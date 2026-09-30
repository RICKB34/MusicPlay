/**
 * 谱面生成 —— 编排入口。
 *
 *   TrackAnalysis
 *     → 建网格        (grid.ts)
 *     → 量化吸附      (quantize.ts)
 *     → 难度分级      (difficulty.ts)
 *     → 轨道分配      (lanes.ts)
 *     → Chart
 *
 * 确定性要求：同样的输入 + 同样的参数，必须产出**逐字节相同**的谱面。
 * 这是双人对战的硬性前提——两人谱面不一致，功能直接失效。
 */

import type { Chart, Difficulty, Subdivision, TrackAnalysis } from '../types'
import { createGrid } from './grid'
import { quantize, type Slot } from './quantize'
import { applyDifficulty, DIFFICULTY_PROFILES } from './difficulty'
import { decideHolds, type HoldResult } from './holds'
import {
  assignLanes,
  computeCentroidRange,
  reportLaneQuality,
  type LaneQualityReport,
} from './lanes'

export interface GenerateOptions {
  difficulty: Difficulty
  columns: 4 | 6
  title?: string
  /** 手动覆盖 BPM（调试页拖动滑块时用）。 */
  bpmOverride?: number
  /** 手动覆盖网格相位（秒）。 */
  offsetOverride?: number
  /** 手动覆盖网格细分。 */
  subdivisionOverride?: Subdivision
  /** 是否允许双押。 */
  allowChords?: boolean
  /**
   * 是否生成长按。默认开启。
   *
   * 关掉时**完全跳过**长按判定，谱面与加这个功能之前逐字节一致——
   * 这是回归安全网：任何可疑的谱面变化都可以靠它先把长按排除掉。
   */
  holds?: boolean
}

export interface GenerateResult {
  chart: Chart
  quality: LaneQualityReport
  stats: {
    onsetCount: number
    slotCount: number
    noteCount: number
    droppedByStrength: number
    droppedByGap: number
    droppedByNps: number
    effectiveBpm: number
    subdivision: Subdivision
    /** 判定为长按的格点数。 */
    holdCount: number
    /** 被长按吸收、从谱面中移除的格点数。 */
    absorbed: number
  }
}

/** 由指纹派生确定性种子。 */
function seedFromFingerprint(fp: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function generateChart(
  analysis: TrackAnalysis,
  opts: GenerateOptions,
): GenerateResult {
  const bpm = opts.bpmOverride ?? analysis.bpm
  const offset = opts.offsetOverride ?? analysis.gridOffsetSec
  const subdivision = opts.subdivisionOverride ?? analysis.subdivision
  const profile = DIFFICULTY_PROFILES[opts.difficulty]

  const grid = createGrid(bpm, offset, subdivision)

  // ── L3 无网格模式：网格不可信时直接用起音时刻当音符 ──
  // 精度略降（音符不落在整数格点上），但谱面完全可玩，
  // 保证"分析失败 ≠ 项目失败"。
  const noGrid = analysis.diagnostics.fallbackLevel >= 3 && opts.bpmOverride == null

  let slots: Slot[]
  let droppedByQuantize = 0
  if (noGrid) {
    slots = analysis.onsets.map((o, i) => ({
      k: i,
      time: o.time,
      strength: o.strength,
      centroid: o.centroid,
      centroidMin: o.centroid,
      centroidMax: o.centroid,
      lowRatio: o.lowRatio,
      midRatio: o.midRatio,
      highRatio: o.highRatio,
      merged: 1,
      sustainMs: o.sustainMs,
    }))
  } else {
    const q = quantize(analysis.onsets, grid)
    slots = q.slots
    droppedByQuantize = q.dropped
  }

  const diff = applyDifficulty(slots, profile)

  // 轨道分配在难度筛选**之后**做：先确定哪些音符存在，
  // 再决定它们落在哪一轨，否则反卡手约束会基于不存在的音符做判断。
  //
  // 但映射区间必须从**全曲所有起音**推算，与难度无关——否则简单难度
  // 因保留的音符少、音色分布窄，会退回固定区间而塌缩到一两条轨。
  const centroidRange = computeCentroidRange(analysis.onsets.map((o) => o.centroid))

  // 长按判定必须在轨道分配**之前**：长按会占据轨道，分轨得先知道哪些音符
  // 是长按、各占多久才能避开。它还会**吸收**长按区间内的音符，所以下面
  // 必须用 `holdResult.slots`，不能再用 `diff.slots`。
  //
  // 无网格模式下跳过——那里的"格点索引"只是起音的序号，不是时间位置，
  // 拿它当长按时长毫无意义。
  const holdResult: HoldResult =
    noGrid || opts.holds === false
      ? {
          slots: diff.slots,
          stats: { candidates: 0, accepted: 0, rejectedBusy: 0, absorbed: 0 },
        }
      : decideHolds(diff.slots, grid, profile.hold, centroidRange)

  const notes = assignLanes(holdResult.slots, grid, {
    columns: opts.columns,
    seed: seedFromFingerprint(analysis.fingerprint),
    allowChords: opts.allowChords ?? true,
    centroidRange,
  })

  const chart: Chart = {
    version: 1,
    meta: {
      title: opts.title ?? '未命名',
      audioFingerprint: analysis.fingerprint,
      durationMs: analysis.durationMs,
      bpm,
      bpmConfidence: analysis.bpmConfidence,
      gridOffsetMs: Math.round(offset * 1000),
      subdivision,
      source: opts.bpmOverride != null || opts.offsetOverride != null ? 'manual-tuned' : 'auto',
    },
    columns: opts.columns,
    difficulty: opts.difficulty,
    notes,
  }

  return {
    chart,
    quality: reportLaneQuality(notes, opts.columns),
    stats: {
      onsetCount: analysis.onsets.length,
      slotCount: slots.length,
      noteCount: notes.length,
      droppedByStrength: diff.droppedByStrength,
      droppedByGap: diff.droppedByGap,
      droppedByNps: diff.droppedByNps,
      effectiveBpm: bpm,
      subdivision,
      holdCount: holdResult.stats.accepted,
      absorbed: holdResult.stats.absorbed,
    },
  }
}
