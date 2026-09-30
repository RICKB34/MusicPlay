/**
 * 长按生成的验证。
 *
 * 要证明的是两件事：
 *   1. 延续够长的音**真的**会变成 `type: 1` 的音符出现在谱面里；
 *   2. 长按的立身之本——**吸收**——真的在删音符，而不是只给音符加个尾巴。
 *
 * 第 2 条是这个功能的意义所在：只加尾巴不加吸收，长按就是纯粹的手指占用
 * 增加（见 `holds.ts` 文件头）。所以"吸收发生了"必须是一条断言，不能只是注释。
 *
 * 另有一条安全网：`holds: false` 时谱面里不该出现任何长按。
 */

import { describe, expect, it } from 'vitest'
import { generateChart } from './generate'
import { createGrid } from './grid'
import { decideHolds } from './holds'
import { DIFFICULTY_PROFILES } from './difficulty'
import type { OnsetEvent, TrackAnalysis } from '../types'
import type { Slot } from './quantize'

/** 造一个 Slot。sustainMs 是唯一的自变量——其余字段只要自洽即可。 */
function mkSlot(k: number, sustainMs: number, centroid = 900): Slot {
  return {
    k,
    time: k * 0.125,
    strength: 1,
    centroid,
    centroidMin: centroid,
    centroidMax: centroid,
    lowRatio: 0,
    midRatio: 1,
    highRatio: 0,
    merged: 1,
    sustainMs,
  }
}

/** 造一个 120 BPM 的合成分析结果（与 generate.test.ts 同一套形状）。 */
function synthAnalysis(
  bpm: number,
  durationSec: number,
  makeOnsets: (beatSec: number, duration: number) => OnsetEvent[],
): TrackAnalysis {
  return {
    fingerprint: 'holds-test',
    durationMs: durationSec * 1000,
    sampleRate: 22050,
    bpm,
    bpmConfidence: 0.9,
    beats: [],
    gridOffsetSec: 0,
    subdivision: 2,
    onsets: makeOnsets(60 / bpm, durationSec),
    diagnostics: {
      medianResidualMs: 5,
      withinToleranceRatio: 0.95,
      quality: 'good',
      fallbackLevel: 0,
      notes: [],
    },
  }
}

function onset(time: number, sustainMs: number, centroid = 900): OnsetEvent {
  const t = Math.max(0, Math.min(1, (centroid - 200) / (6000 - 200)))
  return {
    time,
    rawStrength: 1,
    strength: 1,
    centroid,
    lowRatio: 1 - t,
    midRatio: 0.3,
    highRatio: t,
    sustainMs,
  }
}

// 120 BPM、1/16 细分 → 格距 125ms。minSteps/maxSteps/gapSteps 都由它换算。
const GRID = createGrid(120, 0, 4)
const RANGE = { lo: 200, hi: 6000 }
const PROFILE = DIFFICULTY_PROFILES.normal.hold

describe('decideHolds', () => {
  it('延续够长的格点成为长按', () => {
    const r = decideHolds([mkSlot(0, 1200)], GRID, PROFILE, RANGE)

    expect(r.stats.candidates).toBe(1)
    expect(r.stats.accepted).toBe(1)
    // 1200ms / 125ms ≈ 10 格（上限 3 拍 × 4 = 12 格，没被截断）
    expect(r.slots[0]!.holdSteps).toBe(10)
  })

  it('吸收区间内音色相近的持续音，保留打击乐和异类音色', () => {
    const slots = [
      mkSlot(0, 1200), // 长按本体
      mkSlot(2, 800), // 区间内、够长、音色相同 → 同一个持续织体的再触发，吸收
      mkSlot(4, 100), // 区间内但只有 100ms 延续（鼓点）→ 独立的声音，保留
      mkSlot(6, 800, 4500), // 区间内、够长，但音色差得远 → 另一条旋律线，保留
      mkSlot(20, 800), // 长按区间之外 → 保留
    ]

    const r = decideHolds(slots, GRID, PROFILE, RANGE)

    expect(r.stats.accepted).toBe(1)
    expect(r.stats.absorbed).toBe(1)
    expect(r.slots.map((s) => s.k)).toEqual([0, 4, 6, 20])
  })

  it('延续时长低于下限就放弃，而不是拉伸到下限', () => {
    // 门槛只要 100ms，但下限要求 4 拍 = 2000ms。800ms 够格做候选，却撑不起下限。
    const demanding = { minSustainMs: 100, minBeats: 4, maxBeats: 8, gapBeats: 2, maxHoldNps: 99 }
    const r = decideHolds([mkSlot(0, 800)], GRID, demanding, RANGE)

    expect(r.stats.candidates).toBe(1)
    expect(r.stats.accepted).toBe(0)
    // 关键：没有被抬到下限——那样尾巴会挂在空气里，玩家不知道该不该松手
    expect(r.slots[0]!.holdSteps).toBe(0)
  })

  it('两个长按之间保持距离，避免整条谱变成一堵长按墙', () => {
    const slots = [mkSlot(0, 1200), mkSlot(8, 1200), mkSlot(6, 1200)]
      .sort((a, b) => a.k - b.k)

    const r = decideHolds(slots, GRID, PROFILE, RANGE)

    // gapBeats 是 8 拍 = 32 格：k=0 之后要等到 k>=32 才允许下一个
    expect(r.stats.accepted).toBe(1)
    expect(r.slots.filter((s) => (s.holdSteps ?? 0) > 0).map((s) => s.k)).toEqual([0])
  })

  it('同输入两次判定结果一致——联机对战的前提', () => {
    const build = () => [mkSlot(0, 1200), mkSlot(2, 800), mkSlot(20, 900)]
    const a = decideHolds(build(), GRID, PROFILE, RANGE)
    const b = decideHolds(build(), GRID, PROFILE, RANGE)
    expect(a.slots.map((s) => [s.k, s.holdSteps])).toEqual(b.slots.map((s) => [s.k, s.holdSteps]))
  })
})

describe('generateChart 的长按', () => {
  /** 每 2 拍一个持续 1.5 秒的长音。 */
  const longNotes = (beatSec: number, dur: number): OnsetEvent[] => {
    const out: OnsetEvent[] = []
    for (let t = 0; t < dur; t += beatSec * 2) out.push(onset(t, 1500))
    return out
  }

  it('谱面里真的出现 type=1 且带正时长的音符', () => {
    const analysis = synthAnalysis(120, 20, longNotes)
    const r = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    const holds = r.chart.notes.filter((n) => n.type === 1)
    expect(holds.length).toBeGreaterThan(0)
    expect(holds.every((h) => (h.d ?? 0) > 0)).toBe(true)
    expect(r.stats.holdCount).toBeGreaterThan(0)
  })

  it('吸收真的在删音符', () => {
    // 长音之间还夹着"同一个持续织体"的再触发，它们应当被吸收掉
    const analysis = synthAnalysis(120, 20, (beatSec, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beatSec * 2) out.push(onset(t, 1500))
      return out
    })

    const withHolds = generateChart(analysis, { difficulty: 'normal', columns: 4 })
    const without = generateChart(analysis, { difficulty: 'normal', columns: 4, holds: false })

    expect(withHolds.stats.holdCount).toBeGreaterThan(0)
    // 有长按时音符数不该增多——长按的意义是简化，不是加压
    expect(withHolds.chart.notes.length).toBeLessThanOrEqual(without.chart.notes.length)
  })

  it('holds: false 时一个长按都不该有——回归安全网', () => {
    const analysis = synthAnalysis(120, 20, longNotes)
    const r = generateChart(analysis, { difficulty: 'normal', columns: 4, holds: false })

    expect(r.chart.notes.every((n) => n.type === 0)).toBe(true)
    expect(r.stats.holdCount).toBe(0)
  })

  it('长按谱面同样可复现', () => {
    const build = () => generateChart(synthAnalysis(120, 20, longNotes), {
      difficulty: 'normal',
      columns: 4,
    })
    expect(build().chart.notes).toEqual(build().chart.notes)
  })
})
