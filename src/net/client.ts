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
import type { ClientMessage, ServerMessage } from './protocol'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface BattleCallbacks {
  onState?: (state: ConnectionState, detail?: string) => void
  onRoomCreated?: (roomCode: string, playerId: string) => void
  onJoined?: (roomCode: string, playerId: string) => void
  onPlayerJoined?: (playerId: string) => void
  onPlayerLeft?: (playerId: string) => void
  onChart?: (chart: Chart, fingerprint: string) => void
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
  if (window.location.port === '5173' || window.location.port === '4173') {
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
    this.close()

    this.cb.onState?.('connecting', url)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      this.cb.onState?.('error', (e as Error).message)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.cb.onState?.('open', url)
      // 密集打点快速收敛时钟
      this.quickSyncRemaining = 8
      this.ping()
      this.pingTimer = setInterval(() => this.ping(), 150)
      // 收敛后转为低频跟踪
      this.keepAliveTimer = setInterval(() => this.ping(), 10_000)
    }

    ws.onclose = () => {
      this.cb.onState?.('closed')
      this.stopTimers()
    }

    ws.onerror = () => {
      this.cb.onState?.('error', '无法连接到对战服务器')
    }

    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage
      } catch {
        return
      }
      this.dispatch(msg)
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
        this.cb.onRoomCreated?.(msg.roomCode, msg.playerId)
        break
      case 'JOINED':
        this.playerId = msg.playerId
        this.roomCode = msg.roomCode
        this.cb.onJoined?.(msg.roomCode, msg.playerId)
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
        this.cb.onError?.(msg.message)
        break
    }
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
    this.send({ t: 'CREATE_ROOM' })
  }

  joinRoom(code: string): void {
    this.send({ t: 'JOIN_ROOM', roomCode: code.toUpperCase() })
  }

  submitChart(chart: Chart, fingerprint: string): void {
    this.send({ t: 'SUBMIT_CHART', chart, fingerprint })
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
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.pingTimer = null
    this.keepAliveTimer = null
  }

  close(): void {
    this.stopTimers()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      try {
        this.ws.close()
      } catch {
        // 忽略
      }
      this.ws = null
    }
    this.sync.reset()
  }

  dispose(): void {
    this.disposed = true
    this.close()
  }
}
