import { describe, expect, it } from 'vitest'
import { drumHitsFromOnsets } from './drumHit'
import type { OnsetEvent } from '../types'

/** 造一个起音。默认是"中频为主"——即人声/旋律的音色，应当被筛掉。 */
function onset(
  time: number,
  o: { strength?: number; lowRatio?: number; highRatio?: number } = {},
): OnsetEvent {
  const low = o.lowRatio ?? 0.05
  const high = o.highRatio ?? 0.05
  return {
    time,
    rawStrength: o.strength ?? 0.8,
    strength: o.strength ?? 0.8,
    centroid: 1000,
    lowRatio: low,
    midRatio: Math.max(0, 1 - low - high),
    highRatio: high,
    sustainMs: 100,
  }
}

describe('drumHitsFromOnsets（原曲筛鼓点）', () => {
  it('低频突出（底鼓）与高频突出（军鼓/镲）都算鼓点', () => {
    const hits = drumHitsFromOnsets([
      onset(0.5, { lowRatio: 0.6 }), // 底鼓
      onset(1.0, { highRatio: 0.5 }), // 军鼓/镲
    ])
    expect(hits.map((h) => h.t)).toEqual([0.5, 1.0])
  })

  it('中频为主的人声/旋律被筛掉 —— 这是这条路径不误报的关键', () => {
    const hits = drumHitsFromOnsets([
      onset(0.5, { lowRatio: 0.05, highRatio: 0.05 }),
      onset(1.0, { lowRatio: 0.2, highRatio: 0.1 }),
    ])
    expect(hits).toEqual([])
  })

  it('强度低于门限的起音被滤掉', () => {
    const hits = drumHitsFromOnsets([
      onset(0.5, { lowRatio: 0.6, strength: 0.1 }),
      onset(1.0, { lowRatio: 0.6, strength: 0.9 }),
    ])
    expect(hits.map((h) => h.t)).toEqual([1.0])
  })

  it('过密的击打被最小间隔压平', () => {
    const dense = Array.from({ length: 20 }, (_, i) => onset(0.5 + i * 0.01, { lowRatio: 0.6 }))
    const hits = drumHitsFromOnsets(dense)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].t - hits[i - 1].t).toBeGreaterThanOrEqual(0.07)
    }
  })

  it('输入乱序时仍按时间升序输出', () => {
    const hits = drumHitsFromOnsets([
      onset(2.0, { lowRatio: 0.6 }),
      onset(1.0, { lowRatio: 0.6 }),
      onset(3.0, { lowRatio: 0.6 }),
    ])
    expect(hits.map((h) => h.t)).toEqual([1.0, 2.0, 3.0])
  })

  it('没有起音时返回空数组（弦乐、纯人声这类曲子）', () => {
    expect(drumHitsFromOnsets([])).toEqual([])
  })

  it('空数组不该抛异常', () => {
    expect(() => drumHitsFromOnsets([], { strengthFloor: 0.5 })).not.toThrow()
  })
})
