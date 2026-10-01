/**
 * 对战客户端。
 *
 * 传输层刻意保持可替换：整个类只依赖 `WebSocket` 与我们的协议类型，
 * 将来要换成 Cloudflare Durable Objects 或别的托管方案，只改这个文件。
 *
 * 时钟同步的策略：连上之后密集打 8 次 PING（间隔 150ms）快速收敛，
 * 之后每 10 秒补一次以跟踪网络变化。
 */

import type { Chart, ScoreSnapshot } from '../types'
import { deserializeChart } from '../chartgen/serialize'
import { ClockSync, localNowMs } from './sync'
import { MAX_BATTLE_AUDIO_BYTES, type ClientMessage, type ServerMessage } from './protocol'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'open'
  | 'closed'
  | 'error'

export interface BattleCallbacks {
  onState?: (state: ConnectionState, detail?: string) => void
  onRoomCreated?: (roomCode: string, playerId: string) => void
  onJoined?: (roomCode: string, playerId: string) => void
  onResumed?: (isHost: boolean, opponentPresent: boolean) => void
  onResumeFailed?: (message: string) => void
  onPlayerJoined?: (playerId: string) => void
  onPlayerLeft?: (playerId: string) => void
  onChart?: (chart: Chart, fingerprint: string) => void
  /** 加入者收到房主上传的完整音频。 */
  onAudio?: (audio: ArrayBuffer, fingerprint: string, fileName: string) => void
  onOpponentReady?: (ready: boolean) => void
  onCountdown?: (startAtServerMs: number, leadMs: number) => void
  onOpponentScore?: (snapshot: ScoreSnapshot) => void
  onOpponentFinished?: (score: number, accuracy: number, maxCombo: number) => void
  onFinal?: (
    players: { playerId: string; score: number; accuracy: number; maxCombo: number }[],
    winnerId: string | null,
  ) => void
  onError?: (message: string) => void
  /** 时钟同步完成（样本足够）。 */
  onSynced?: (rttMs: number) => void
}

/**
 * 对战服务器地址。
 *
 * 优先读取 `VITE_WS_URL`，便于前端与 WebSocket 服务分开托管。
 * 未配置时：
 *   - Vite 开发页（5173）连本机 8787；
 *   - 生产环境默认连当前站点同源，适用于 Node 同时托管网页与 WebSocket。
 */
export function defaultServerUrl(): string {
  const configured = import.meta.env.VITE_WS_URL?.trim()
  if (configured) {
    if (configured.startsWith('https://')) return `wss://${configured.slice(8)}`
    if (configured.startsWith('http://')) return `ws://${configured.slice(7)}`
    return configured
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname || 'localhost'
  // Vite 端口被占用时会自动顺延到 5174/5175…，开发模式下统一回落到 8787。
  if (import.meta.env.DEV || window.location.port === '4173') {
    return `${proto}//${host}:8787`
  }
  if (window.location.host) return `${proto}//${window.location.host}`
  return `${proto}//${host}:8787`
}

export class BattleClient {
  readonly sync = new ClockSync()
  private ws: WebSocket | null = null
  private cb: BattleCallbacks
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private quickSyncRemaining = 0
  private disposed = false
  private shouldReconnect = false
  private connectUrl = ''
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private resumeToken: string | null = null
  private resumePending = false
  private audioUploadWaiter: {
    resolve: () => void
    reject: (error: Error) => void
    timer: number
  } | null = null
  private incomingAudio: {
    size: number
    fingerprint: string
    fileName: string
    received: number
    chunks: Uint8Array[]
  } | null = null
  /**
   * 附加观察者。
   *
   * 存在的意义：大厅组件与游戏组件是两个生命周期，游戏开始时大厅还挂着。
   * 与其为订阅对手分数重建连接（会丢掉已经收敛的时钟同步样本），
   * 不如让双方挂到同一个连接上。
   */
  private observers = new Set<BattleCallbacks>()

  playerId: string | null = null
  roomCode: string | null = null

  constructor(cb: BattleCallbacks = {}) {
    this.cb = cb
  }

  /**
   * 挂一个附加观察者。返回取消订阅函数。
   *
   * 观察者只收到回调，不能发消息——发送接口仍集中在本类上，
   * 避免多处代码各自持有发送逻辑导致协议分散。
   */
  observe(cb: BattleCallbacks): () => void {
    this.observers.add(cb)
    return () => this.observers.delete(cb)
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(url = defaultServerUrl()): void {
    if (this.disposed) return
    this.shouldReconnect = true
    this.connectUrl = url
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.openSocket(url)
  }

  private openSocket(url: string): void {
    this.stopTimers()
    this.closeSocket()
    this.cb.onState?.('connecting', url)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.cb.onState?.('error', (e as Error).message)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.cb.onState?.('open', url)
      // 密集打点快速收敛时钟
      this.quickSyncRemaining = 8
      this.ping()
      this.pingTimer = setInterval(() => this.ping(), 150)
      // 收敛后转为低频跟踪
      this.keepAliveTimer = setInterval(() => this.ping(), 10_000)
      if (this.roomCode && this.playerId && this.resumeToken) {
        this.resumePending = true
        this.send({
          t: 'REJOIN_ROOM',
          roomCode: this.roomCode,
          playerId: this.playerId,
          resumeToken: this.resumeToken,
        })
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopTimers()
      this.rejectAudioUpload(new Error('连接已断开，音频发送失败'))
      if (this.shouldReconnect) {
        this.cb.onState?.('reconnecting')
        this.scheduleReconnect()
      } else {
        this.cb.onState?.('closed')
      }
    }

    ws.onerror = () => {
      this.cb.onState?.('error', '无法连接到对战服务器')
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        if (ev.data instanceof ArrayBuffer) {
          this.handleAudioChunk(new Uint8Array(ev.data))
        } else if (ev.data instanceof Blob) {
          void ev.data
            .arrayBuffer()
            .then((buf) => this.handleAudioChunk(new Uint8Array(buf)))
            .catch((e) => this.cb.onError?.((e as Error).message))
        }
        return
      }

      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data) as ServerMessage
      } catch {
        return
      }
      this.dispatch(msg)
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer !== null) return
    const delay = Math.min(10_000, 800 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect && !this.disposed) this.openSocket(this.connectUrl)
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private dispatch(msg: ServerMessage): void {
    // 先分发给附加观察者（游戏页），再走主回调（大厅页）
    for (const obs of this.observers) this.dispatchTo(obs, msg)
    this.dispatchTo(this.cb, msg)
  }

  private dispatchTo(cb: BattleCallbacks, msg: ServerMessage): void {
    if (msg.t === 'PONG') {
      // 时钟同步由本类统一维护，观察者只关心是否已收敛
      this.sync.onPong(msg.cid, msg.t0, msg.t1, msg.t2)
      if (this.quickSyncRemaining > 0 && --this.quickSyncRemaining === 0) {
        this.cb.onSynced?.(this.sync.bestRtt)
      }
      return
    }
    if (msg.t === 'OPPONENT_SCORE') {
      cb.onOpponentScore?.({
        score: msg.score,
        combo: msg.combo,
        maxCombo: msg.maxCombo,
        accuracy: msg.accuracy,
        progress: msg.progress,
      })
      return
    }
    if (msg.t === 'OPPONENT_FINISHED') {
      cb.onOpponentFinished?.(msg.score, msg.accuracy, msg.maxCombo)
      return
    }
    // 其余消息只给主回调，避免观察者重复处理房间状态机
    if (cb !== this.cb) return
    this.dispatchRest(msg)
  }

  /** 房间状态机相关的消息。PONG 与分数类消息在 dispatchTo 里已提前分流。 */
  private dispatchRest(msg: ServerMessage): void {
    switch (msg.t) {
      case 'ROOM_CREATED':
        this.playerId = msg.playerId
        this.roomCode = msg.roomCode
        this.resumeToken = msg.resumeToken
        this.resumePending = false
        this.cb.onRoomCreated?.(msg.roomCode, msg.playerId)
        break
      case 'JOINED':
        this.playerId = msg.playerId
        this.roomCode = msg.roomCode
        this.resumeToken = msg.resumeToken
        this.resumePending = false
        this.cb.onJoined?.(msg.roomCode, msg.playerId)
        break
      case 'ROOM_RESUMED':
        this.playerId = msg.playerId
        this.roomCode = msg.roomCode
        this.resumePending = false
        this.cb.onResumed?.(msg.isHost, msg.opponentPresent)
        break
      case 'PLAYER_JOINED':
        this.cb.onPlayerJoined?.(msg.playerId)
        break
      case 'PLAYER_LEFT':
        this.cb.onPlayerLeft?.(msg.playerId)
        break
      case 'CHART_RECEIVED':
        try {
          // 对手发来的谱面属于不可信输入，必须校验后再用
          this.cb.onChart?.(deserializeChart(JSON.stringify(msg.chart)), msg.fingerprint)
        } catch (e) {
          this.cb.onError?.(`收到的谱面无效：${(e as Error).message}`)
        }
        break
      case 'AUDIO_ACCEPTED':
        this.resolveAudioUpload()
        break
      case 'AUDIO_BEGIN':
        if (
          !Number.isInteger(msg.size) ||
          msg.size <= 0 ||
          msg.size > MAX_BATTLE_AUDIO_BYTES
        ) {
          this.cb.onError?.('收到的音频大小不合法')
          this.incomingAudio = null
          break
        }
        this.incomingAudio = {
          size: msg.size,
          fingerprint: msg.fingerprint,
          fileName: msg.fileName,
          received: 0,
          chunks: [],
        }
        break
      case 'AUDIO_END': {
        const incoming = this.incomingAudio
        this.incomingAudio = null
        if (!incoming || incoming.received !== incoming.size) {
          this.cb.onError?.('音频接收不完整，请让房主重新发送')
          break
        }
        const bytes = new Uint8Array(incoming.size)
        let offset = 0
        for (const chunk of incoming.chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.cb.onAudio?.(bytes.buffer, incoming.fingerprint, incoming.fileName)
        break
      }
      case 'OPPONENT_READY':
        this.cb.onOpponentReady?.(msg.ready)
        break
      case 'COUNTDOWN':
        this.cb.onCountdown?.(msg.startAtServerMs, msg.leadMs)
        break
      case 'FINAL_RESULT':
        this.cb.onFinal?.(msg.players, msg.winnerId)
        break
      case 'ERROR':
        this.rejectAudioUpload(new Error(msg.message))
        if (this.resumePending) {
          this.resumePending = false
          this.roomCode = null
          this.playerId = null
          this.resumeToken = null
          this.cb.onResumeFailed?.(msg.message)
        }
        this.cb.onError?.(msg.message)
        break
    }
  }

  private handleAudioChunk(chunk: Uint8Array): void {
    const incoming = this.incomingAudio
    if (!incoming) return
    if (incoming.received + chunk.byteLength > incoming.size) {
      this.incomingAudio = null
      this.cb.onError?.('音频接收超出声明大小')
      return
    }
    incoming.chunks.push(chunk)
    incoming.received += chunk.byteLength
  }

  private resolveAudioUpload(): void {
    const waiter = this.audioUploadWaiter
    if (!waiter) return
    this.audioUploadWaiter = null
    window.clearTimeout(waiter.timer)
    waiter.resolve()
  }

  private rejectAudioUpload(error: Error): void {
    const waiter = this.audioUploadWaiter
    if (!waiter) return
    this.audioUploadWaiter = null
    window.clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  private ping(): void {
    if (!this.isOpen) return
    const { cid, t0 } = this.sync.nextPing()
    this.send({ t: 'PING', cid, t0 })
  }

  private send(msg: ClientMessage): void {
    if (!this.isOpen) return
    this.ws?.send(JSON.stringify(msg))
  }

  /** 把服务器时间轴上的绝对时刻换算成本地单调时钟时刻（毫秒）。 */
  serverToLocalMs(serverMs: number): number {
    return this.sync.toClient(serverMs)
  }

  /** 距离服务器时间轴上的某个时刻还有多少毫秒（负数表示已过）。 */
  msUntil(serverMs: number): number {
    return serverMs - this.sync.toServer(localNowMs())
  }

  createRoom(): void {
    this.resumePending = false
    this.send({ t: 'CREATE_ROOM' })
  }

  joinRoom(code: string): void {
    this.resumePending = false
    this.send({ t: 'JOIN_ROOM', roomCode: code.toUpperCase() })
  }

  submitChart(chart: Chart, fingerprint: string): void {
    this.send({ t: 'SUBMIT_CHART', chart, fingerprint })
  }

  /**
   * 把房主的原始音频分块发给服务端，服务端转发给加入者。
   *
   * `bufferedAmount` 背压很重要：直接把几十 MB 塞进 WebSocket 会让浏览器
   * 为了排队把整份数据复制进内存，低端手机会瞬间卡死。
   */
  async uploadAudio(
    audio: ArrayBuffer,
    fingerprint: string,
    fileName: string,
    onProgress?: (ratio: number) => void,
  ): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('对战服务器未连接')
    }
    if (audio.byteLength <= 0 || audio.byteLength > MAX_BATTLE_AUDIO_BYTES) {
      throw new Error('音频文件必须在 30MB 以内，才能通过对战服务器中转')
    }
    if (this.audioUploadWaiter) {
      throw new Error('音频正在发送，请稍候')
    }

    const bytes = new Uint8Array(audio)
    const chunkSize = 256 * 1024
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.audioUploadWaiter) this.audioUploadWaiter = null
        reject(new Error('音频发送超时，请重试'))
      }, 120_000)
      this.audioUploadWaiter = { resolve, reject, timer }
    })
    // 上传过程中可能先收到服务器 ERROR；提前挂一个 no-op，避免 Windows 浏览器报未处理拒绝。
    void accepted.catch(() => {})

    try {
      this.send({ t: 'AUDIO_BEGIN', size: audio.byteLength, fingerprint, fileName })
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((resolve) => window.setTimeout(resolve, 10))
        }
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error('连接已断开，音频发送失败')
        }
        ws.send(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)))
        onProgress?.(Math.min(1, (offset + chunkSize) / bytes.byteLength))
      }
      this.send({ t: 'AUDIO_END' })
      await accepted
    } catch (e) {
      this.rejectAudioUpload(e as Error)
      throw e
    }
  }

  setReady(ready: boolean): void {
    this.send({ t: 'READY', ready })
  }

  sendScore(s: ScoreSnapshot): void {
    this.send({
      t: 'SCORE_UPDATE',
      score: s.score,
      combo: s.combo,
      maxCombo: s.maxCombo,
      accuracy: s.accuracy,
      progress: s.progress,
    })
  }

  finish(score: number, accuracy: number, maxCombo: number): void {
    this.send({ t: 'FINISH', score, accuracy, maxCombo })
  }

  leave(): void {
    this.send({ t: 'LEAVE' })
    this.roomCode = null
    this.playerId = null
    this.resumeToken = null
    this.resumePending = false
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.pingTimer = null
    this.keepAliveTimer = null
  }

  close(): void {
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.stopTimers()
    this.rejectAudioUpload(new Error('连接已关闭'))
    this.incomingAudio = null
    this.closeSocket()
    this.sync.reset()
  }

  private closeSocket(): void {
    const ws = this.ws
    if (ws) {
      ws.onopen = null
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      try {
        ws.close()
      } catch {
        // 忽略
      }
      this.ws = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.close()
  }
}
