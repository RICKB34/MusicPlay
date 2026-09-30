/**
 * 谱面调试可视化 —— 全项目 ROI 最高的一个组件。
 *
 * 它把「波形 / 节拍网格线 / 检测到的起音 / 生成的谱面 / 量化残差」
 * 全部叠在同一条时间轴上，并让播放头与音频严格同步。
 *
 * 于是验证变成一件直觉的事：**按下播放，耳朵听到底鼓的瞬间，
 * 眼睛看到播放头正好压在小节线上**——BPM 和相位对不对，3 秒就能判断。
 * 没有这个工具，后面所有阈值和算法的调整都是盲调。
 *
 * 同时它也是「分析失败」的最后一道保险（降级链的 L4）：
 * 直接给 BPM / 相位滑块，拖到网格线压住鼓点为止，30 秒搞定，永远有效。
 *
 * **配色是有意不走主题的**：下面各 draw 函数里的固定色（rgba(57,255,20,...) 等）
 * 刻意不接 RenderTheme。这是开发者诊断工具、不在演示路径上，而波形/网格/残差
 * 需要的是一组高对比度的固定色阶——跟着主题换成白底反而看不清细线。
 * 要改就整体替换，别只改一半。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoadedSong } from '../App'
import type { Settings } from '../state/settings'
import { getAudioContext } from '../state/audioContext'
import { createGrid } from '../chartgen/grid'
import { generateChart } from '../chartgen/generate'
import { frameTime } from '../analysis/stft'

interface Props {
  song: LoadedSong | null
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onBack: () => void
}

const CANVAS_HEIGHT = 420
const ROW_RULER = 22
const ROW_GRID = 34
const ROW_WAVE = 90
const ROW_ONSET = 46
const ROW_BANDS = 40
const ROW_NOTES = 100
const ROW_RESIDUAL = 48

export function DebugChart({ song, settings, onChange, onBack }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [bpmOverride, setBpmOverride] = useState<number | null>(null)
  const [offsetOverrideMs, setOffsetOverrideMs] = useState<number | null>(null)

  const [showWave, setShowWave] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showOnsets, setShowOnsets] = useState(true)
  const [showNotes, setShowNotes] = useState(true)
  const [showResidual, setShowResidual] = useState(true)

  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [view, setView] = useState({ start: 0, end: 30 })

  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startCtxRef = useRef(0)
  const rafRef = useRef(0)

  // 手动覆盖后的网格
  const bpm = bpmOverride ?? song?.analysis.bpm ?? 0
  const offsetSec = offsetOverrideMs != null ? offsetOverrideMs / 1000 : (song?.analysis.gridOffsetSec ?? 0)

  const grid = useMemo(
    () => createGrid(bpm || 120, offsetSec, song?.analysis.subdivision ?? 4),
    [bpm, offsetSec, song?.analysis.subdivision],
  )

  /** 用当前（可能被手动覆盖的）参数重新生成谱面，让改动立刻可见。 */
  const regen = useMemo(() => {
    if (!song) return null
    if (bpmOverride == null && offsetOverrideMs == null) return song.generated
    return generateChart(song.analysis, {
      difficulty: settings.difficulty,
      columns: settings.columns,
      bpmOverride: bpm,
      offsetOverride: offsetSec,
    })
  }, [song, bpmOverride, offsetOverrideMs, bpm, offsetSec, settings.difficulty, settings.columns])

  // ── 播放控制 ──
  const stop = useCallback(() => {
    try {
      sourceRef.current?.stop()
    } catch {
      // 已停止
    }
    sourceRef.current?.disconnect()
    sourceRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    setPlaying(false)
  }, [])

  const play = useCallback(
    async (fromSec: number) => {
      if (!song) return
      const ctx = getAudioContext()
      await ctx.resume()
      stop()

      const src = ctx.createBufferSource()
      src.buffer = song.decoded.buffer
      src.connect(ctx.destination)
      const at = ctx.currentTime + 0.08
      src.start(at, Math.max(0, fromSec))
      sourceRef.current = src
      startCtxRef.current = at - fromSec
      setPlaying(true)

      const tick = () => {
        const t = ctx.currentTime - startCtxRef.current
        setPlayhead(t)
        if (t >= song.decoded.buffer.duration) {
          stop()
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [song, stop],
  )

  useEffect(() => () => stop(), [stop])

  // ── 绘制 ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const W = Math.max(1, rect.width)
    const H = CANVAS_HEIGHT
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // 背景
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, W, H)

    const t0 = view.start
    const t1 = view.end
    const span = Math.max(0.01, t1 - t0)
    const xOf = (t: number) => ((t - t0) / span) * W

    let y = 0

    // ── 行 1：小节/拍标尺 ──
    ctx.fillStyle = 'rgba(57,255,20,0.04)'
    ctx.fillRect(0, y, W, ROW_RULER)
    ctx.font = '11px ui-monospace, monospace'
    ctx.textAlign = 'left'
    drawRuler(ctx, grid, t0, t1, xOf, y, ROW_RULER)
    y += ROW_RULER

    // ── 行 2：网格线 ──
    if (showGrid) {
      drawGridLines(ctx, grid, t0, t1, xOf, y, ROW_GRID)
    }
    y += ROW_GRID

    // ── 行 3：波形 ──
    if (showWave && song) {
      drawWaveform(ctx, song.decoded.mono, song.decoded.sampleRate, t0, t1, 0, y, W, ROW_WAVE)
    }
    y += ROW_WAVE

    // ── 行 4：起音强度 ──
    if (showOnsets && song) {
      drawOnsets(ctx, song, t0, t1, xOf, y, ROW_ONSET)
    }
    y += ROW_ONSET

    // ── 行 5：三频段能量 ──
    if (song) {
      drawBands(ctx, song, t0, t1, xOf, y, W, ROW_BANDS)
    }
    y += ROW_BANDS

    // ── 行 6：生成的谱面（按轨道分行的音符）──
    if (showNotes && regen) {
      drawNotes(ctx, regen.chart.notes, settings.columns, t0, t1, xOf, y, ROW_NOTES)
    }
    y += ROW_NOTES

    // ── 行 7：量化残差 ──
    if (showResidual && song) {
      drawResidual(ctx, song, grid, t0, t1, xOf, y, ROW_RESIDUAL)
    }
    y += ROW_RESIDUAL

    // ── 播放头 ──
    if (playhead >= t0 && playhead <= t1) {
      const px = xOf(playhead)
      ctx.strokeStyle = '#ff6ec7'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, H)
      ctx.stroke()
    }
  }, [
    song,
    regen,
    grid,
    view,
    playhead,
    settings.columns,
    showWave,
    showGrid,
    showOnsets,
    showNotes,
    showResidual,
  ])

  if (!song) {
    return (
      <div className="screen">
        <h1>调试工具</h1>
        <p>还没有加载歌曲。先回上一页选一首歌，再回来查看分析结果。</p>
        <button className="ghost" onClick={onBack}>
          返回
        </button>
      </div>
    )
  }

  const diag = song.analysis.diagnostics
  const duration = song.decoded.buffer.duration
  const qualityClass =
    diag.quality === 'good' ? 'good' : diag.quality === 'degraded' ? 'warn' : 'bad'

  return (
    <div className="screen" style={{ maxWidth: 1100 }}>
      <h1>谱面调试</h1>

      <div className="card" style={{ borderColor: diag.quality === 'good' ? undefined : 'var(--warning)' }}>
        <div className="stat-grid">
          <div className="stat">
            <div className="k">BPM</div>
            <div className="v">{bpm.toFixed(1)}</div>
          </div>
          <div className="stat">
            <div className="k">置信度</div>
            <div className="v">{(song.analysis.bpmConfidence * 100).toFixed(0)}%</div>
          </div>
          <div className="stat">
            <div className="k">残差中位数</div>
            <div className="v">{diag.medianResidualMs.toFixed(1)}ms</div>
          </div>
          <div className="stat">
            <div className="k">容差内</div>
            <div className="v">{(diag.withinToleranceRatio * 100).toFixed(0)}%</div>
          </div>
          <div className="stat">
            <div className="k">起音</div>
            <div className="v">{song.analysis.onsets.length}</div>
          </div>
          <div className="stat">
            <div className="k">音符</div>
            <div className="v">{regen?.chart.notes.length ?? 0}</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <span className={'badge ' + qualityClass}>
            降级级别 L{diag.fallbackLevel} ·{' '}
            {diag.quality === 'good' ? '正常' : diag.quality === 'degraded' ? '已降级' : '兜底模式'}
          </span>
        </div>
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {diag.notes.map((n, i) => (
            <div className="note" key={i}>
              {n}
            </div>
          ))}
        </div>
      </div>

      <div className="row tight">
        <button className="primary" onClick={() => (playing ? stop() : void play(view.start))}>
          {playing ? '停止' : '播放'}
        </button>
        <button className="ghost" onClick={() => void play(0)}>
          从头
        </button>
        <button
          className="ghost"
          onClick={() => {
            const center = playhead > 0 ? playhead : 15
            setView({ start: Math.max(0, center - 7.5), end: Math.min(duration, center + 7.5) })
          }}
        >
          聚焦播放头
        </button>
        <button className="ghost" onClick={() => setView({ start: 0, end: duration })}>
          全曲
        </button>
      </div>

      <div className="row tight">
        {(
          [
            ['波形', showWave, setShowWave],
            ['网格', showGrid, setShowGrid],
            ['起音', showOnsets, setShowOnsets],
            ['谱面', showNotes, setShowNotes],
            ['残差', showResidual, setShowResidual],
          ] as const
        ).map(([label, on, set]) => (
          <button
            key={label}
            className="ghost"
            data-active={on}
            style={{ opacity: on ? 1 : 0.45, fontSize: 13 }}
            onClick={() => (set as (v: boolean) => void)(!on)}
          >
            {label}
          </button>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: CANVAS_HEIGHT, borderRadius: 0, display: 'block' }}
        onPointerDown={(e) => {
          // 点波形任意位置跳到那个时刻
          const rect = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - rect.left) / rect.width
          const t = view.start + ratio * (view.end - view.start)
          stop()
          setPlayhead(Math.max(0, Math.min(duration, t)))
          void play(t)
        }}
      />

      <div className="row tight">
        <span className="muted">视窗起点</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, duration - 2)}
          step={0.5}
          value={view.start}
          onChange={(e) => {
            const s = Number(e.target.value)
            const w = view.end - view.start
            setView({ start: s, end: Math.min(duration, s + w) })
          }}
        />
        <span className="muted">宽度</span>
        <input
          type="range"
          min={2}
          max={duration}
          step={1}
          value={view.end - view.start}
          onChange={(e) => {
            const w = Number(e.target.value)
            setView({ start: view.start, end: Math.min(duration, view.start + w) })
          }}
        />
      </div>

      {/* L4 手动兜底：分析怎么都调不准时，拖滑块让网格线压住鼓点 */}
      <div className="card">
        <h2>手动微调（最后一道保险）</h2>
        <p className="muted">
          自动分析对某些曲风会失效。拖动下面两个滑块，让网格线压住波形上的鼓点即可。
        </p>

        <div className="row tight" style={{ marginTop: 12, alignItems: 'center' }}>
          <span className="muted" style={{ width: 64 }}>
            BPM {bpm.toFixed(1)}
          </span>
          <input
            type="range"
            min={60}
            max={200}
            step={0.5}
            value={bpm}
            onChange={(e) => setBpmOverride(Number(e.target.value))}
          />
        </div>

        <div className="row tight" style={{ alignItems: 'center' }}>
          <span className="muted" style={{ width: 64 }}>
            相位 {Math.round(offsetSec * 1000)}ms
          </span>
          <input
            type="range"
            min={-500}
            max={500}
            step={5}
            value={Math.round(offsetSec * 1000)}
            onChange={(e) => setOffsetOverrideMs(Number(e.target.value))}
          />
        </div>

        <div className="row tight" style={{ marginTop: 8 }}>
          <button
            className="ghost"
            onClick={() => {
              setBpmOverride(null)
              setOffsetOverrideMs(null)
            }}
          >
            恢复自动结果
          </button>
          <button
            className="ghost"
            onClick={() => {
              const nudged = (song.analysis.bpm / 2) | 0
              setBpmOverride(nudged)
            }}
          >
            BPM ÷ 2（倍频修正）
          </button>
          <button
            className="ghost"
            onClick={() => {
              const nudged = Math.round(song.analysis.bpm * 2)
              setBpmOverride(nudged)
            }}
          >
            BPM × 2
          </button>
        </div>
      </div>

      <div className="card">
        <h2>操作提示</h2>
        <p className="muted">
          点波形任意位置跳到该时刻并播放。把视窗调窄（宽度 5-10 秒）能看清每个音符落在哪个格点上。
          <br />
          判断标准：<strong>播放时播放头应正好压在波形上每个鼓点的起跳处</strong>；网格线应该自然穿过这些起跳点。
        </p>
      </div>

      <button className="ghost" onClick={onBack}>
        返回
      </button>
    </div>
  )
}

// ─────────────────────────── 绘制辅助 ───────────────────────────

function drawRuler(
  ctx: CanvasRenderingContext2D,
  grid: ReturnType<typeof createGrid>,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  h: number,
): void {
  const kStart = Math.max(0, grid.nearestStep(t0))
  const kEnd = grid.nearestStep(t1)
  const stepsPerBar = 4 * grid.subdivision

  // 视窗太宽时只标小节线，避免文字糊成一片
  const tooDense = (kEnd - kStart) / stepsPerBar > 40

  for (let k = kStart; k <= kEnd; k++) {
    if (!grid.isBarLine(k)) continue
    const t = grid.stepTime(k)
    if (t < t0 || t > t1) continue
    const x = xOf(t)
    ctx.strokeStyle = 'rgba(57,255,20,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y + h)
    ctx.stroke()

    if (!tooDense) {
      const bar = Math.floor(k / stepsPerBar) + 1
      ctx.fillStyle = 'rgba(57,255,20,0.8)'
      ctx.fillText(String(bar), x + 3, y + 14)
    }
  }
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  grid: ReturnType<typeof createGrid>,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  h: number,
): void {
  const kStart = grid.nearestStep(t0)
  const kEnd = grid.nearestStep(t1)
  for (let k = kStart; k <= kEnd; k++) {
    const t = grid.stepTime(k)
    if (t < t0 || t > t1) continue
    const x = xOf(t)
    const isBar = grid.isBarLine(k)
    const isBeat = grid.isOnBeat(k)
    ctx.strokeStyle = isBar
      ? 'rgba(57,255,20,0.55)'
      : isBeat
        ? 'rgba(57,255,20,0.25)'
        : 'rgba(57,255,20,0.1)'
    ctx.lineWidth = isBar ? 1.5 : 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y + h)
    ctx.stroke()
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  mono: Float32Array,
  sampleRate: number,
  t0: number,
  t1: number,
  x0: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = 'rgba(57,255,20,0.03)'
  ctx.fillRect(x0, y, w, h)

  const mid = y + h / 2
  const s0 = Math.max(0, Math.floor(t0 * sampleRate))
  const s1 = Math.min(mono.length, Math.ceil(t1 * sampleRate))
  if (s1 <= s0) return

  // 每个像素列取该列覆盖采样的 min/max —— 标准波形金字塔做法
  const px = Math.ceil(w)
  const perPx = (s1 - s0) / px

  ctx.strokeStyle = 'rgba(57,255,20,0.75)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < px; i++) {
    const a = s0 + Math.floor(i * perPx)
    const b = Math.min(s1, s0 + Math.floor((i + 1) * perPx))
    let lo = 1
    let hi = -1
    for (let j = a; j < b; j++) {
      const v = mono[j] ?? 0
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (lo > hi) continue
    const x = x0 + i
    ctx.moveTo(x, mid - hi * (h / 2) * 0.92)
    ctx.lineTo(x, mid - lo * (h / 2) * 0.92)
  }
  ctx.stroke()

  ctx.strokeStyle = 'rgba(57,255,20,0.2)'
  ctx.beginPath()
  ctx.moveTo(x0, mid)
  ctx.lineTo(x0 + w, mid)
  ctx.stroke()
}

function drawOnsets(
  ctx: CanvasRenderingContext2D,
  song: LoadedSong,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  h: number,
): void {
  const base = y + h
  for (const o of song.analysis.onsets) {
    if (o.time < t0 || o.time > t1) continue
    const x = xOf(o.time)
    // 颜色由强度决定：酸性黄 → 赛博粉
    const hue = 60 - o.strength * 100
    ctx.strokeStyle = `hsl(${hue}, 95%, ${45 + o.strength * 20}%)`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, base)
    ctx.lineTo(x, base - o.strength * h * 0.92)
    ctx.stroke()
  }
}

function drawBands(
  ctx: CanvasRenderingContext2D,
  song: LoadedSong,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = 'rgba(57,255,20,0.03)'
  ctx.fillRect(0, y, w, h)

  // 用起音自带的频段占比按时间铺开，比重新算一遍 STFT 便宜得多
  const colors = ['rgba(255,110,199,0.75)', 'rgba(57,255,20,0.75)', 'rgba(230,255,0,0.75)']
  const ratios = ['lowRatio', 'midRatio', 'highRatio'] as const

  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'left'
  const labels = ['低频', '中频', '高频']
  const rowH = h / 3

  for (let bi = 0; bi < 3; bi++) {
    const rowY = y + bi * rowH
    const key = ratios[bi]
    ctx.fillStyle = colors[bi]
    for (const o of song.analysis.onsets) {
      if (o.time < t0 || o.time > t1) continue
      const x = xOf(o.time)
      const v = o[key]
      const barH = v * (rowH - 2)
      ctx.fillRect(x - 1, rowY + (rowH - 2 - barH), 2, barH)
    }
    ctx.fillStyle = 'rgba(57,255,20,0.6)'
    ctx.fillText(labels[bi], 3, rowY + 10)
  }
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  notes: { t: number; col: number }[],
  columns: number,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  h: number,
): void {
  ctx.fillStyle = 'rgba(57,255,20,0.03)'
  ctx.fillRect(0, y, 10000, h)

  const rowH = h / columns
  for (let c = 0; c < columns; c++) {
    ctx.strokeStyle = 'rgba(57,255,20,0.1)'
    ctx.beginPath()
    ctx.moveTo(0, y + c * rowH)
    ctx.lineTo(10000, y + c * rowH)
    ctx.stroke()
  }

  for (const n of notes) {
    const t = n.t / 1000
    if (t < t0 || t > t1) continue
    const x = xOf(t)
    const rowY = y + n.col * rowH
    ctx.fillStyle = '#39ff14'
    ctx.fillRect(x - 2, rowY + rowH * 0.18, 4, rowH * 0.64)
  }
}

function drawResidual(
  ctx: CanvasRenderingContext2D,
  song: LoadedSong,
  grid: ReturnType<typeof createGrid>,
  t0: number,
  t1: number,
  xOf: (t: number) => number,
  y: number,
  h: number,
): void {
  const mid = y + h / 2
  ctx.strokeStyle = 'rgba(57,255,20,0.25)'
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(10000, mid)
  ctx.stroke()

  // 纵轴范围：±60ms
  const maxMs = 60
  for (const o of song.analysis.onsets) {
    if (o.time < t0 || o.time > t1) continue
    const errSec = o.time - grid.stepTime(grid.nearestStep(o.time))
    const errMs = errSec * 1000
    const clamped = Math.max(-maxMs, Math.min(maxMs, errMs))
    const x = xOf(o.time)
    const dy = (clamped / maxMs) * (h / 2) * 0.9
    const absMs = Math.abs(errMs)
    ctx.strokeStyle = absMs < 20 ? '#39ff14' : absMs < 35 ? '#e6ff00' : '#ff6ec7'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, mid)
    ctx.lineTo(x, mid - dy)
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(57,255,20,0.6)'
  ctx.font = '10px ui-monospace, monospace'
  ctx.textAlign = 'left'
  ctx.fillText('残差 ±60ms', 3, y + 11)
}
