/**
 * 延迟校准。
 *
 * 这是让"手感对"的关键功能，而且**必须让玩家自己调**：音频输出延迟、
 * 输入采样延迟、显示延迟、个人反应偏置，四者叠加起来因设备而异，
 * 蓝牙耳机和有线音箱能差 100ms 以上。
 *
 * 策略是「用一个参数吸收所有未建模误差」——不去在代码里精确建模每一条延迟
 * （那做不到，也没必要），而是量测总偏差并一次性补偿。
 *
 * 测量原理：
 *   在 ctxTime = start + k·interval 调度一声 click。
 *   玩家听到（延迟 outputLatency）后反应并按下（再加反应时间与输入延迟）。
 *   记 tap 时刻的 songTime 与该 click 的 songTime 之差为 delta，
 *   则 userOffset = -median(delta)。
 *
 * 用**中位数**而非均值：抗手滑产生的离群点。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from '../state/settings'
import { getAudioContext } from '../state/audioContext'

interface Props {
  settings: Settings
  onDone: (offsetMs: number) => void
  onBack: () => void
}

/** 节拍间隔（秒）。500ms = 120 BPM，不快不慢，容易跟。 */
const INTERVAL = 0.5
/** 需要采集的有效样本数。 */
const TARGET_SAMPLES = 16
/** 丢弃前几个样本（热身）。 */
const WARMUP = 2
/** 超过这个偏差视为手滑，丢弃（毫秒）。 */
const OUTLIER_MS = 220

export function Calibration({ settings, onDone, onBack }: Props) {
  const [running, setRunning] = useState(false)
  const [samples, setSamples] = useState<number[]>([])
  const [result, setResult] = useState<number | null>(null)

  const ctxRef = useRef<AudioContext | null>(null)
  const startCtxTimeRef = useRef(0)
  const latencyRef = useRef(0)
  const oscRef = useRef<OscillatorNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)

  const stop = useCallback(() => {
    setRunning(false)
    try {
      oscRef.current?.stop()
    } catch {
      // 已停止
    }
    oscRef.current?.disconnect()
    gainRef.current?.disconnect()
    oscRef.current = null
    gainRef.current = null
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    const ctx = getAudioContext()
    await ctx.resume()
    ctxRef.current = ctx
    const c = ctx as AudioContext & { outputLatency?: number }
    latencyRef.current = c.outputLatency ?? ctx.baseLatency ?? 0

    setSamples([])
    setResult(null)
    setRunning(true)

    // 一个持续振荡器 + 增益门控，比每拍新建 Oscillator 更省也更准时
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1200
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()

    oscRef.current = osc
    gainRef.current = gain

    // 提前 3 秒开始调度，留出音频图就绪时间
    startCtxTimeRef.current = ctx.currentTime + 0.2
    scheduleClicks(ctx, gain, startCtxTimeRef.current)
  }, [])

  const handleTap = useCallback(() => {
    if (!running) return
    const ctx = ctxRef.current
    if (!ctx) return

    // 用与 GameClock.songTime() 完全一致的公式计算
    const songTime = ctx.currentTime - latencyRef.current - startCtxTimeRef.current
    if (songTime < 0) return

    // 找最近的节拍
    const k = Math.round(songTime / INTERVAL)
    const deltaMs = (songTime - k * INTERVAL) * 1000

    setSamples((prev) => {
      const next = [...prev, deltaMs]
      if (next.length >= TARGET_SAMPLES) {
        const offset = computeOffset(next)
        setResult(offset)
        stop()
      }
      return next
    })
  }, [running, stop])

  const effectiveSamples = samples.slice(WARMUP).filter((s) => Math.abs(s) <= OUTLIER_MS)

  return (
    <div className="screen">
      <h1>延迟校准</h1>
      <p>
        跟着节拍声，用任意键或点击屏幕打拍子。系统会量测你整体的延迟并补偿。
        <br />
        戴蓝牙耳机、或者觉得音符总是"偏早/偏晚"，都该跑一遍这个。
      </p>

      {!running && result === null && (
        <button className="primary" style={{ padding: 16, fontSize: 16 }} onClick={() => void start()}>
          开始校准
        </button>
      )}

      {running && (
        <>
          <div
            className="card"
            style={{
              textAlign: 'center',
              padding: '48px 16px',
              cursor: 'pointer',
              userSelect: 'none',
              touchAction: 'none',
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              handleTap()
            }}
          >
            <div style={{ fontSize: 40, fontWeight: 700 }}>{effectiveSamples.length}</div>
            <p className="muted">已采集 / 需要 {TARGET_SAMPLES - WARMUP} 次</p>
            <div className="progress" style={{ marginTop: 14 }}>
              <div style={{ width: `${(samples.length / TARGET_SAMPLES) * 100}%` }} />
            </div>
          </div>
          <button className="ghost" onClick={stop}>
            停止
          </button>
        </>
      )}

      {result !== null && (
        <div className="card">
          <h2>量测结果</h2>
          <div className="stat-grid">
            <div className="stat">
              <div className="k">建议偏置</div>
              <div className="v">{result.toFixed(0)} ms</div>
            </div>
            <div className="stat">
              <div className="k">有效样本</div>
              <div className="v">{effectiveSamples.length}</div>
            </div>
            <div className="stat">
              <div className="k">离散程度</div>
              <div className="v">{stdev(effectiveSamples).toFixed(0)} ms</div>
            </div>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            {result > 0
              ? '你有偏慢倾向，判定线会相应延后。'
              : result < 0
                ? '你有偏快倾向，判定线会相应提前。'
                : '你的时机很准。'}
            {stdev(effectiveSamples) > 60 && ' 离散程度偏大，建议再测一次——可能是节拍没跟稳。'}
          </p>
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="primary"
              style={{ flex: 1 }}
              onClick={() => onDone(Math.round(result))}
            >
              应用并返回
            </button>
            <button className="ghost" onClick={() => void start()}>
              重测
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>当前设置</h2>
        <p className="muted">
          偏置 {settings.userOffsetMs} ms · 音符接近时长 {settings.approachMs} ms
          <br />
          系统报告的输出延迟：
          {(() => {
            const ctx = getAudioContext()
            const c = ctx as AudioContext & { outputLatency?: number }
            return `${(((c.outputLatency ?? 0) + (ctx.baseLatency ?? 0)) * 1000).toFixed(0)} ms`
          })()}
        </p>
      </div>

      <button className="ghost" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

/** 提前调度一串 click。用增益门控做极短的包络，避免爆音。 */
function scheduleClicks(ctx: AudioContext, gain: GainNode, startAt: number): void {
  const total = TARGET_SAMPLES + WARMUP + 4
  for (let k = 0; k < total; k++) {
    const t = startAt + k * INTERVAL
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.16, t + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045)
  }
}

function computeOffset(samples: number[]): number {
  const usable = samples.slice(WARMUP).filter((s) => Math.abs(s) <= OUTLIER_MS)
  if (usable.length === 0) return 0
  const sorted = [...usable].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  // 玩家偏慢 → delta 为正 → 需要把判定线延后，即 userOffset 取负
  return -median
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(v)
}
