/**
 * 从原曲分析得到的起音中筛出鼓点，供边框光晕使用。
 *
 * 这份产出只喂给氛围反馈，不参与判定、计分与轨道分配。
 */

import type { DrumHit, OnsetEvent } from '../types'

export interface OnsetDrumOptions {
  /** 起音强度的门限 [0,1]。默认 0.3。 */
  strengthFloor?: number
  /** 低频占比门限 [0,1]，底鼓判据。默认 0.30。 */
  lowRatioMin?: number
  /** 高频占比门限 [0,1]，军鼓/镲片判据。默认 0.25。 */
  highRatioMin?: number
  /** 最小间隔（毫秒）。默认 70。 */
  minGapMs?: number
}

/**
 * 从**原曲**的起音列表里筛出鼓点。
 *
 * `analysis.onsets` 是谱面生成时**已经算好**的副产品，直接从里面挑，
 * 零额外成本、不联网、不需要任何服务。
 *
 * ── 判据是音色，不是响度 ──
 *
 * 底鼓的能量集中在低频（20–250Hz），军鼓和镲片在高频（2000–8000Hz），
 * 而人声和旋律主要落在中频（250–2000Hz）。所以「低频突出 **或** 高频突出」
 * 就是打击乐——这两个条件是**或**的关系，因为底鼓和镲片处在频谱两端。
 *
 * 代价说清楚：原曲里人声的爆破音（p、t、k 这类）也会有宽频瞬态，
 * 可能被误判成鼓点，因此密度可能略高于真实打击乐。
 */
export function drumHitsFromOnsets(
  onsets: readonly OnsetEvent[],
  opts: OnsetDrumOptions = {},
): DrumHit[] {
  const strengthFloor = opts.strengthFloor ?? 0.3
  const lowMin = opts.lowRatioMin ?? 0.3
  const highMin = opts.highRatioMin ?? 0.25
  const minGapSec = (opts.minGapMs ?? 70) / 1000

  const hits: DrumHit[] = []
  let lastSec = -Infinity

  // 显式排序，保证输出与输入顺序无关。
  const sorted = [...onsets].sort((a, b) => a.time - b.time)

  for (const o of sorted) {
    if (o.strength < strengthFloor) continue
    if (o.lowRatio < lowMin && o.highRatio < highMin) continue
    if (o.time - lastSec < minGapSec) continue
    lastSec = o.time
    // strength 在分析管线里已归一化到 [0,1]，这里可以直接当 DrumHit 的强度用
    hits.push({ t: o.time, strength: o.strength })
  }
  return hits
}
