import { describe, expect, it } from 'vitest'
import type { OnsetEvent } from '../types'
import { evaluateBpm } from './tempo'

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

describe('tempo —— 相位细化', () => {
  it('用细相位搜索把网格残差压到毫秒级', () => {
    const phase = 0.137
    const step = 0.125
    const onsets = Array.from({ length: 160 }, (_, i) => {
      const jitter = ((i % 5) - 2) * 0.0006
      return onset(phase + i * step + jitter, 0.5 + (i % 7) / 20)
    })

    const evaluation = evaluateBpm(120, onsets)

    expect(evaluation.residualMs).toBeLessThan(2.5)
  })
})
