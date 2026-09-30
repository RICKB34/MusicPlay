/**
 * 量化 —— 把起音吸附到节拍网格上。
 *
 * 这一步同时解决三件事：
 *   1. 把浮点时刻变成"音乐上的第几个音"（整数格点索引）
 *   2. 丢掉对不上网格的起音（滑音、装饰音、检测噪声）
 *   3. 合并落在同一格点的多个起音
 *
 * 第 3 点不是可选的优化，是**必需的正确性保证**：底鼓和镲片常常落在同一个
 * 十六分格上，不合并就会生成两个同轨音符，物理上打不出来。
 */

import type { OnsetEvent } from '../types'
import type { BeatGrid } from './grid'

export interface Slot {
  /** 格点索引。 */
  k: number
  /** 用于谱面的时刻（秒）：以格点为骨架，并保留最多 18ms 的真实起音微时序。 */
  time: number
  /** 合并后的强度（多个起音取最大，而非求和——求和会让密集段落强度爆炸）。 */
  strength: number
  /** 强度加权的谱质心（Hz）。 */
  centroid: number
  /** 合并进本格点的起音中，最小的谱质心（Hz）。用于判断是否该拆成双押。 */
  centroidMin: number
  /** 合并进本格点的起音中，最大的谱质心（Hz）。 */
  centroidMax: number
  /** 强度加权的低频占比 [0,1]。 */
  lowRatio: number
  /** 强度加权的中频占比 [0,1]。 */
  midRatio: number
  /** 强度加权的高频占比 [0,1]。 */
  highRatio: number
  /** 合并进这个格点的原始起音数量。 */
  merged: number
  /**
   * 合并进本格点的起音里**最长**的延续时长（毫秒）—— 长按判定的原料。
   *
   * 取 max 而非加权平均：只要有一个起音是长音，这个格点就该考虑做长按。
   */
  sustainMs: number
  /**
   * 长按占用的格点数，0 或未定义表示不是长按。
   *
   * 由 `holds.ts` 的 `decideHolds` **原地写入**，轨道分配读它来决定
   * 这条轨要占用多久。
   */
  holdSteps?: number
}

export interface QuantizeResult {
  slots: Slot[]
  /** 因对不上网格而丢弃的起音数。 */
  dropped: number
}

export interface QuantizeOptions {
  /**
   * 容差（秒）。超过这个距离的起音视为"非网格音"被丢弃。
   *
   * 双上限：既不超过格距的 35%（保证不会吸附到隔壁格点），
   * 也不超过 45ms（避免在粗网格下过于宽松，把装饰音也吸进来）。
   */
  toleranceSec?: number
}

/**
 * 软量化允许保留的最大微时序（秒）。
 *
 * 真人和真鼓不会严格落在数学格点上。完全吸附会丢掉演奏的微小时差，
 * 让音符听起来“差一点”；完全不量化又会让检测噪声直接进入谱面。
 * 18ms 足够覆盖常见的人类演奏抖动，同时仍把明显离格的起音拉回节拍附近。
 */
const MAX_MICROTIMING_SEC = 0.018

function softSnapTime(onsetTime: number, snapped: number): number {
  const residual = onsetTime - snapped
  const kept = Math.max(-MAX_MICROTIMING_SEC, Math.min(MAX_MICROTIMING_SEC, residual))
  return snapped + kept
}

export function quantize(
  onsets: OnsetEvent[],
  grid: BeatGrid,
  opts: QuantizeOptions = {},
): QuantizeResult {
  const tol = opts.toleranceSec ?? Math.min(grid.gridStepSec * 0.35, 0.045)

  const byIndex = new Map<number, Slot>()
  let dropped = 0

  for (const o of onsets) {
    const k = grid.nearestStep(o.time)
    const snapped = grid.stepTime(k)
    if (Math.abs(o.time - snapped) > tol) {
      dropped++
      continue
    }

    const existing = byIndex.get(k)
    if (!existing) {
      byIndex.set(k, {
        k,
        time: softSnapTime(o.time, snapped),
        strength: o.strength,
        centroid: o.centroid,
        centroidMin: o.centroid,
        centroidMax: o.centroid,
        lowRatio: o.lowRatio,
        midRatio: o.midRatio,
        highRatio: o.highRatio,
        merged: 1,
        sustainMs: o.sustainMs,
      })
      continue
    }

    // 合并：强度取最大，其余特征按强度加权平均。
    // 加权而非取最亮者的理由：底鼓+镲片撞在同一格时，谁响谁主导更符合听感。
    const w = o.strength
    const total = existing.strength + w
    const mix = (a: number, b: number) => (total > 1e-9 ? (a * existing.strength + b * w) / total : a)
    const onsetTime = softSnapTime(o.time, snapped)

    existing.time = mix(existing.time, onsetTime)
    existing.centroid = mix(existing.centroid, o.centroid)
    existing.centroidMin = Math.min(existing.centroidMin, o.centroid)
    existing.centroidMax = Math.max(existing.centroidMax, o.centroid)
    existing.lowRatio = mix(existing.lowRatio, o.lowRatio)
    existing.midRatio = mix(existing.midRatio, o.midRatio)
    existing.highRatio = mix(existing.highRatio, o.highRatio)
    existing.strength = Math.max(existing.strength, w)
    existing.sustainMs = Math.max(existing.sustainMs, o.sustainMs)
    existing.merged++
  }

  const slots = Array.from(byIndex.values()).sort((a, b) => a.k - b.k)
  return { slots, dropped }
}
