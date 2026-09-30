/**
 * 节拍网格 —— 谱面生成的骨架。
 *
 * 由 {bpm, 第0拍时刻, 细分} 构建一张无限延伸的网格，所有起音都被吸附到格点上。
 * 网格只做一件事：把"音频里检测到的时刻"翻译成"音乐上的第几个音"。
 */

import type { OnsetEvent, Subdivision } from '../types'

/** 假设 4/4 拍。变拍号需要小节检测，1-2 周项目不做。 */
export const BEATS_PER_BAR = 4

export interface BeatGrid {
  bpm: number
  /** 一拍的时长（秒）。这是四分音符，不是格点间距。 */
  beatIntervalSec: number
  /** 第 0 拍的时刻（秒）。 */
  phase0Sec: number
  subdivision: Subdivision
  /** 格点间距（秒）= beatIntervalSec / subdivision。 */
  gridStepSec: number

  /** 格点索引 k → 时刻（秒）。 */
  stepTime(k: number): number
  /** 时刻（秒）→ 最接近的格点索引。 */
  nearestStep(t: number): number
  /** 该格点是否为小节线（每 BEATS_PER_BAR 拍）。 */
  isBarLine(k: number): boolean
  /** 该格点在所属小节内是第几拍，0 .. BEATS_PER_BAR-1。 */
  beatInBar(k: number): number
  /** 拍点在拍内的位置：0 表示正拍，非 0 表示细分音。用于重拍锚定。 */
  isOnBeat(k: number): boolean
}

export function createGrid(
  bpm: number,
  phase0Sec: number,
  subdivision: Subdivision,
): BeatGrid {
  const beatIntervalSec = 60 / bpm
  const gridStepSec = beatIntervalSec / subdivision
  const stepsPerBar = BEATS_PER_BAR * subdivision

  return {
    bpm,
    beatIntervalSec,
    phase0Sec,
    subdivision,
    gridStepSec,
    stepTime: (k) => phase0Sec + k * gridStepSec,
    nearestStep: (t) => Math.round((t - phase0Sec) / gridStepSec),
    isBarLine: (k) => ((k % stepsPerBar) + stepsPerBar) % stepsPerBar === 0,
    beatInBar: (k) => Math.floor((((k % stepsPerBar) + stepsPerBar) % stepsPerBar) / subdivision),
    isOnBeat: (k) => ((k % subdivision) + subdivision) % subdivision === 0,
  }
}

/**
 * 量化残差的中位数（毫秒）—— 网格贴合程度的唯一客观指标。
 *
 * 残差越小说明网格越贴合实际音频。这是 AnalysisDiagnostics 的核心数字，
 * 也是降级链的触发依据。中位数而非均值：抗离群点。
 */
export function medianResidualMs(grid: BeatGrid, onsets: OnsetEvent[]): number {
  if (onsets.length === 0) return Infinity
  const residuals = onsets.map((o) => Math.abs(o.time - grid.stepTime(grid.nearestStep(o.time))))
  return median(residuals) * 1000
}

/**
 * 自动选择细分：在等分（十六分音）与三连音之间，取量化残差更小的那个。
 *
 * 摇摆/shuffle 曲风用三连音网格才贴得住，等分网格会产生系统性残差。
 * 限制为**全曲统一选择** —— 小节内动态切换需要小节级检测，成本远超收益。
 */
export function chooseSubdivision(
  bpm: number,
  phase0Sec: number,
  onsets: OnsetEvent[],
): { subdivision: Subdivision; residualMs: number } {
  const candidates: Subdivision[] = [4, 3, 2]
  let best: { subdivision: Subdivision; residualMs: number } = {
    subdivision: 4,
    residualMs: Infinity,
  }

  for (const sub of candidates) {
    const grid = createGrid(bpm, phase0Sec, sub)
    const r = medianResidualMs(grid, onsets)
    if (r < best.residualMs) best = { subdivision: sub, residualMs: r }
    // 十六分音已经贴合得很好就不必再试更粗的网格了——细分越粗，
    // 残差只会更大，但格点更少会让"看起来贴合"具有欺骗性。
    if (sub === 4 && r < 12) break
  }

  return best
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 线性插值分位数。用于强度归一化（除以 p95）。 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}
