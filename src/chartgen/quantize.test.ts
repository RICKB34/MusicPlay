import { describe, expect, it } from 'vitest'
import type { OnsetEvent } from '../types'
import { createGrid } from './grid'
import { quantize } from './quantize'

function onset(time: number, strength = 1): OnsetEvent {
  return {
    time,
    rawStrength: strength,
    strength,
    centroid: 1000,
    lowRatio: 0.4,
    midRatio: 0.4,
    highRatio: 0.2,
    sustainMs: 80,
  }
}

describe('quantize —— 保留起音微时序', () => {
  const grid = createGrid(120, 0, 4) // 格距 125ms，容差 43.75ms

  it('轻微偏离格点时保留真实起音时刻', () => {
    const result = quantize([onset(0.138)], grid)

    expect(result.slots).toHaveLength(1)
    expect(result.slots[0]!.k).toBe(1)
    expect(result.slots[0]!.time).toBeCloseTo(0.138, 6)
  })

  it('明显偏离格点时最多保留 18ms 微时序', () => {
    const result = quantize([onset(0.164)], grid)

    expect(result.slots).toHaveLength(1)
    expect(result.slots[0]!.k).toBe(1)
    expect(result.slots[0]!.time).toBeCloseTo(0.143, 6)
  })
})
