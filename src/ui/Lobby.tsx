/**
 * 对战大厅。
 *
 * 流程：连接服务器 → 建房/加入 → 双方各自加载同一首歌的本地文件
 * → 房主生成并提交谱面 → 服务器转发给对手 → 双方准备 → 服务器下发权威时间轴 → 开打。
 *
 * **关键校验**：对手收到谱面后要核对 `audioFingerprint` 与自己本地文件是否一致。
 * 两人用的不是同一个音频文件的话，谱面时间轴会完全错位——这是演示现场最容易
 * 翻车的地方，10 行代码就能防住。
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
  current: { chart: Chart; decoded: DecodedAudio; fileName: string } | null
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
  const [opponentPresent, setOpponentPresent] = useState(false)
  const [opponentReady, setOpponentReady] = useState(false)
  const [rtt, setRtt] = useState<number | null>(null)
  const [status, setStatus] = useState('正在连接对战服务器…')
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<BattleClient | null>(null)
  const [chart, setChart] = useState<Chart | null>(null)
  const [decoded, setDecoded] = useState<DecodedAudio | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [myReady, setMyReady] = useState(false)
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
        setPhase('waiting')
        setStatus('把房间码告诉朋友')
      },
      onJoined: (code) => {
        setRoomCode(code)
        setIsHost(false)
        setPhase('waiting')
        setStatus('已加入房间')
      },
      onPlayerJoined: () => {
        setOpponentPresent(true)
        setStatus('对手已加入，请各自加载同一首歌')
      },
      onPlayerLeft: () => {
        setOpponentPresent(false)
        setOpponentReady(false)
        setStatus('对手已离开')
      },
      onChart: (incoming, fp) => {
        setChart(incoming)
        setFingerprint(fp)
        // 校验：对手发来的谱面所基于的音频，必须和我加载的是同一个文件
        setDecoded((mine) => {
          if (mine && mine.fingerprint !== incoming.meta.audioFingerprint) {
            setError('对手用的音频文件和你不是同一个。请确保双方选择的是完全相同的那个文件。')
          }
          return mine
        })
        setStatus('已收到对手的谱面')
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
    if (current && !chart) {
      setChart(current.chart)
      setDecoded(current.decoded)
      setFingerprint(current.decoded.fingerprint)
    }
  }, [current, chart])

  /** 加载本地音频并生成谱面（房主提交用；客人只需解码以做指纹校验）。 */
  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setPhase('loading')
      setStatus('正在分析…')
      try {
        const ctx = getAudioContext()
        const buf = await file.arrayBuffer()
        const dec = await decodeArrayBuffer(buf, ctx)

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
        setStatus('分析完成，点「准备」提交给对手')
        setPhase('ready')
      } catch (e) {
        setError(describeDecodeError(e))
        setPhase('waiting')
      }
    },
    [settings.analysisProfile, settings.difficulty, settings.columns],
  )

  const handleReady = useCallback(() => {
    const client = clientRef.current
    if (!client || !chart) {
      setError('还没有谱面。请先加载一首本地音乐。')
      return
    }
    // 房主负责把谱面推给对手
    if (isHost && fingerprint) client.submitChart(chart, fingerprint)
    client.setReady(true)
    setMyReady(true)
    setStatus('已准备，等待对手…')
  }, [chart, isHost, fingerprint])

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
            <p className="muted">还没有加载歌曲。</p>
          )}

          {opponentPresent && (
            <p style={{ marginTop: 10 }}>
              对手状态：{opponentReady ? '已准备' : '未准备'}
            </p>
          )}

          {!chart && (
            <button
              className="primary"
              style={{ width: '100%', marginTop: 12 }}
              onClick={() => fileRef.current?.click()}
            >
              加载本地音乐（双方必须是同一个文件）
            </button>
          )}

          {chart && !myReady && phase !== 'countdown' && (
            <button
              className="primary"
              style={{ width: '100%', marginTop: 12 }}
              disabled={!opponentPresent}
              onClick={handleReady}
            >
              {opponentPresent ? '准备' : '等待对手加入…'}
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

      <button className="ghost" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

export type { ScoreSnapshot }
