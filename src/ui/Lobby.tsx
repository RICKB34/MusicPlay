/**
 * 对战大厅。
 *
 * 流程：连接服务器 → 房主建房并选择歌曲 → 加入者输房间码
 * → 服务器把房主的谱面与音频转给加入者 → 双方准备 → 服务器下发权威时间轴 → 开打。
 *
 * **关键校验**：加入者解出音频后，要用 `audioFingerprint` 核对它与收到的谱面
 * 是否一致。传输过程中丢包或截断都必须在这里拦住，不能让错位时间轴进入游戏。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chart } from '../types'
import type { Settings } from '../state/settings'
import { getAudioContext } from '../state/audioContext'
import { decodeArrayBuffer, describeDecodeError, type DecodedAudio } from '../analysis/decode'
import { runAnalysis } from '../analysis/analyzeClient'
import { generateChart } from '../chartgen/generate'
import { BattleClient, defaultServerUrl, type ConnectionState } from '../net/client'
import type { ScoreSnapshot } from '../types'

export interface BattleStart {
  chart: Chart
  audioBuffer: AudioBuffer
  startAtServerMs: number
  leadMs: number
  /**
   * 复用大厅已经建立好的连接。
   * 不重建的理由：时钟同步样本已经收敛（跑过 8 次 PING），
   * 重建连接等于把这些样本全部丢掉，开局时刻换算会不准。
   */
  client: BattleClient
  opponentLabel: string
}

interface Props {
  settings: Settings
  /** 当前已加载的歌曲（可选）。房主直接复用它，免去重新分析。 */
  current: {
    chart: Chart
    decoded: DecodedAudio
    fileName: string
    sourceBytes: ArrayBuffer
  } | null
  onStart: (payload: BattleStart) => void
  onBack: () => void
}

type Phase = 'connect' | 'menu' | 'waiting' | 'loading' | 'ready' | 'countdown'

export function Lobby({ settings, current, onStart, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('connect')
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [roomCode, setRoomCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [isHost, setIsHost] = useState(false)
  const isHostRef = useRef(false)
  const [opponentPresent, setOpponentPresent] = useState(false)
  const [opponentReady, setOpponentReady] = useState(false)
  const [rtt, setRtt] = useState<number | null>(null)
  const [status, setStatus] = useState('正在连接对战服务器…')
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<BattleClient | null>(null)
  const [chart, setChart] = useState<Chart | null>(null)
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [audioBytes, setAudioBytes] = useState<ArrayBuffer | null>(null)
  const [myReady, setMyReady] = useState(false)
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const startRef = useRef(onStart)
  startRef.current = onStart

  // ── 建立连接 ──
  useEffect(() => {
    const client = new BattleClient({
      onState: (s, detail) => {
        setConnState(s)
        if (s === 'open') {
          setStatus('已连接，创建或加入房间')
          setPhase((p) => (p === 'connect' ? 'menu' : p))
        } else if (s === 'closed') setStatus('连接已断开')
        else if (s === 'error') setError(detail ?? '连接失败')
      },
      onSynced: (ms) => setRtt(ms),
      onRoomCreated: (code) => {
        setRoomCode(code)
        setIsHost(true)
        isHostRef.current = true
        setPhase('waiting')
        setStatus('请选择歌曲，并把房间码告诉朋友')
      },
      onJoined: (code) => {
        setRoomCode(code)
        setIsHost(false)
        isHostRef.current = false
        // 能成功加入，房主必然已经在房间里。
        setOpponentPresent(true)
        setPhase('waiting')
        setStatus('已加入房间，等待房主选择歌曲')
      },
      onPlayerJoined: () => {
        setOpponentPresent(true)
        setStatus(
          isHostRef.current ? '对手已加入，请选择歌曲' : '已加入房间，等待房主选择歌曲',
        )
      },
      onPlayerLeft: () => {
        setOpponentPresent(false)
        setOpponentReady(false)
        setStatus('对手已离开')
      },
      onChart: (incoming, fp) => {
        setChart(incoming)
        setFingerprint(fp)
        // 房主只收到服务器回执；加入者随后会自动收到原始音频。
        setDecoded((mine) => {
          if (mine && mine.fingerprint !== incoming.meta.audioFingerprint) {
            setError('收到的谱面和音频不匹配，请让房主重新选择歌曲。')
          }
          return mine
        })
        setStatus(isHostRef.current ? '谱面已发送' : '已收到歌曲信息，正在接收音频…')
      },
      onAudio: (audio, fp, fileName) => {
        if (isHostRef.current) return
        setPhase('loading')
        setStatus('正在解码房主发来的歌曲…')
        void (async () => {
          let incoming: DecodedAudio
          try {
            incoming = await decodeArrayBuffer(audio, getAudioContext())
          } catch (e) {
            setError(describeDecodeError(e))
            setStatus('歌曲解码失败')
            setPhase('waiting')
            return
          }

          const chartFingerprint = chartRef.current?.meta.audioFingerprint
          if (
            incoming.fingerprint !== fp ||
            (chartFingerprint && incoming.fingerprint !== chartFingerprint)
          ) {
            setError(`《${fileName}》与房主提交的谱面不匹配，请让房主重新发送。`)
            setStatus('歌曲校验失败')
            setPhase('waiting')
            return
          }

          setDecoded(incoming)
          setFingerprint(incoming.fingerprint)
          setPhase('ready')
          setStatus('歌曲已收到，点击「准备」加入对战')
        })()
      },
      onOpponentReady: setOpponentReady,
      onCountdown: (startAtServerMs, leadMs) => {
        setPhase('countdown')
        setStatus('即将开始！')
        const c = chartRef.current
        const d = decodedRef.current
        const client = clientRef.current
        if (c && d && client) {
          startRef.current({
            chart: c,
            audioBuffer: d.buffer,
            startAtServerMs,
            leadMs,
            client,
            opponentLabel: '对手',
          })
        } else {
          setError('缺少谱面或音频，无法开局')
        }
      },
      onError: (m) => setError(m),
    })
    clientRef.current = client
    client.connect(defaultServerUrl())

    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  // 用 ref 保存最新的 chart/decoded，供 countdown 回调读取
  const chartRef = useRef<Chart | null>(null)
  chartRef.current = chart
  const decodedRef = useRef<DecodedAudio | null>(null)
  decodedRef.current = decoded

  // 复用 App 里已加载的歌曲
  useEffect(() => {
    // 加入者哪怕之前在单机选过歌，也不能拿那首歌充当房主的选择。
    if (isHost && current && !chart) {
      setChart(current.chart)
      setDecoded(current.decoded)
      setFingerprint(current.decoded.fingerprint)
      setAudioBytes(current.sourceBytes)
    }
  }, [current, chart, isHost])

  /** 加载本地音频并生成谱面。只有房主会走这条路径。 */
  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setPhase('loading')
      setStatus('正在分析…')
      try {
        const ctx = getAudioContext()
        const buf = await file.arrayBuffer()
        // decodeAudioData 可能转移原始缓冲区；房主之后还要原样发给对手。
        const dec = await decodeArrayBuffer(buf.slice(0), ctx)

        const analysis = await runAnalysis(dec.mono.slice(), {
          fs: dec.sampleRate,
          fingerprint: dec.fingerprint,
          profile: settings.analysisProfile,
          onProgress: (stage, ratio) => setStatus(`${stage} ${Math.round(ratio * 100)}%`),
        })
        const generated = generateChart(analysis, {
          difficulty: settings.difficulty,
          columns: settings.columns,
          title: file.name.replace(/\.[^.]+$/, ''),
        })
        setDecoded(dec)
        setFingerprint(dec.fingerprint)
        setChart(generated.chart)
        setAudioBytes(buf)
        setStatus('分析完成，点「准备」把歌曲发给对手')
        setPhase('ready')
      } catch (e) {
        setError(describeDecodeError(e))
        setPhase('waiting')
      }
    },
    [settings.analysisProfile, settings.difficulty, settings.columns],
  )

  const handleReady = useCallback(async () => {
    const client = clientRef.current
    if (!client || !chart || !decoded) {
      setError('还没有可用的歌曲。请让房主先选择一首本地音乐。')
      return
    }

    if (isHost) {
      if (sending) return
      if (!audioBytes || !fingerprint) {
        setError('原始音频不可用，请重新选择歌曲。')
        return
      }
      setSending(true)
      setError(null)
      setStatus('正在把歌曲发给对手…')
      try {
        client.submitChart(chart, fingerprint)
        await client.uploadAudio(audioBytes, fingerprint, `${chart.meta.title}.audio`, (ratio) => {
          setStatus(`正在发送歌曲 ${Math.round(ratio * 100)}%`)
        })
      } catch (e) {
        setError((e as Error).message)
        setStatus('歌曲发送失败')
        setSending(false)
        return
      }
      setSending(false)
    }

    client.setReady(true)
    setMyReady(true)
    setStatus('已准备，等待对手…')
  }, [audioBytes, chart, decoded, fingerprint, isHost, sending])

  const canInteract = connState === 'open'

  return (
    <div className="screen">
      <h1>双人对战</h1>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="card">
        <div className="stat-grid">
          <div className="stat">
            <div className="k">连接</div>
            <div className="v" style={{ fontSize: 15 }}>
              {connState === 'open' ? '已连接' : connState === 'connecting' ? '连接中' : '未连接'}
            </div>
          </div>
          <div className="stat">
            <div className="k">时钟 RTT</div>
            <div className="v" style={{ fontSize: 15 }}>
              {rtt == null ? '—' : `${rtt.toFixed(0)} ms`}
            </div>
          </div>
          {roomCode && (
            <div className="stat">
              <div className="k">房间码</div>
              <div className="v" style={{ letterSpacing: 2 }}>
                {roomCode}
              </div>
            </div>
          )}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          {status}
        </p>
        {rtt != null && rtt > 120 && (
          <p style={{ color: 'var(--warning)', marginTop: 8 }}>
            网络延迟偏高（{rtt.toFixed(0)}ms）。对战仍然可玩——判定完全在本地做，
            不受网络影响，只有进度条显示会稍有滞后。
          </p>
        )}
      </div>

      {phase === 'menu' && (
        <div className="card">
          <h2>创建房间</h2>
          <button
            className="primary"
            style={{ width: '100%' }}
            disabled={!canInteract}
            onClick={() => clientRef.current?.createRoom()}
          >
            我来建房
          </button>

          <h2 style={{ marginTop: 20 }}>加入房间</h2>
          <div className="row">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 4))}
              placeholder="房间码"
              className="input"
              style={{ flex: 1, fontSize: 18, letterSpacing: 4 }}
            />
            <button
              disabled={!canInteract || joinCode.length < 4}
              onClick={() => clientRef.current?.joinRoom(joinCode)}
            >
              加入
            </button>
          </div>
        </div>
      )}

      {(phase === 'waiting' || phase === 'loading' || phase === 'ready' || phase === 'countdown') && (
        <div className="card">
          <h2>歌曲</h2>
          {chart ? (
            <p className="muted">
              已加载 · {chart.notes.length} 个音符 · {chart.meta.bpm.toFixed(1)} BPM · {chart.columns}K
              <br />
              <span style={{ fontSize: 11, wordBreak: 'break-all' }}>
                指纹 {chart.meta.audioFingerprint}
              </span>
            </p>
          ) : (
            <p className="muted">
              {isHost ? '还没有选择歌曲。' : '等待房主选择歌曲…'}
            </p>
          )}

          {opponentPresent && (
            <p style={{ marginTop: 10 }}>
              对手状态：{opponentReady ? '已准备' : '未准备'}
            </p>
          )}

          {isHost && !chart && (
            <button
              className="primary"
              style={{ width: '100%', marginTop: 12 }}
              onClick={() => fileRef.current?.click()}
            >
              选择本地音乐
            </button>
          )}

          {chart && decoded && !myReady && phase !== 'countdown' && (
            <button
              className="primary"
              style={{ width: '100%', marginTop: 12 }}
              disabled={!opponentPresent || sending}
              onClick={() => void handleReady()}
            >
              {sending ? '正在发送歌曲…' : opponentPresent ? '准备' : '等待对手加入…'}
            </button>
          )}

          {myReady && phase !== 'countdown' && (
            <p style={{ marginTop: 12, color: 'var(--accent)' }}>已准备，等待对手…</p>
          )}

          {phase === 'countdown' && <p style={{ marginTop: 12, color: 'var(--accent)' }}>即将开始…</p>}
        </div>
      )}

      <div className="card">
        <h2>演示提示</h2>
        <p className="muted">
          服务器默认连到 <code>{defaultServerUrl()}</code>。
          <br />
          现场演示建议：本机跑 <code>node server/index.js</code>，两台设备连同一个 WiFi，
          浏览器打开 <code>http://&lt;你的局域网IP&gt;:8787</code>。
          这样 RTT 接近 0，最稳。
        </p>
      </div>

      {isHost && (
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
      )}

      <button className="ghost" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

export type { ScoreSnapshot }
