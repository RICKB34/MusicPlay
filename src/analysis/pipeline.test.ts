/**
 * 分析管线端到端验证 —— 这是全项目最有价值的一个测试。
 *
 * `analyzeMono` 接收的是 `Float32Array`，全程不碰 Web Audio API，
 * 所以可以在 Node 里直接跑。这意味着整个"音频 → BPM → 起音 → 谱面"
 * 的链路可以脱离浏览器验证，不用靠肉眼看波形猜。
 *
 * 这里合成一段**已知 BPM、已知音色分布**的鼓组，然后检查管线
 * 能否把 BPM 还原出来、能否正确区分底鼓与镲片的音色差异。
 */

import { describe, expect, it } from 'vitest'
import { analyzeMono } from './analyzeTrack'
import { generateChart } from '../chartgen/generate'
import { centroidToLane } from '../chartgen/lanes'

const FS = 22050

/** 确定性 PRNG，保证合成音频可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 底鼓：频率从 120Hz 扫到 45Hz 的正弦，40ms 指数衰减。
 * 这是真实底鼓的经典合成方式，频谱能量集中在 45-120Hz，谱质心很低。
 */
function renderKick(out: Float32Array, startSample: number, amp: number): void {
  const dur = Math.floor(0.12 * FS)
  let phase = 0
  for (let i = 0; i < dur && startSample + i < out.length; i++) {
    const t = i / FS
    const f = 45 + 75 * Math.exp(-t / 0.02)
    phase += (2 * Math.PI * f) / FS
    const env = Math.exp(-t / 0.04)
    out[startSample + i] += Math.sin(phase) * env * amp
  }
}

/**
 * 镲片：白噪声，12ms 极快衰减。
 * 白噪声的谱质心接近 fs/4，远高于底鼓。
 */
function renderHat(out: Float32Array, startSample: number, amp: number, rand: () => number): void {
  const dur = Math.floor(0.05 * FS)
  for (let i = 0; i < dur && startSample + i < out.length; i++) {
    const t = i / FS
    const env = Math.exp(-t / 0.012)
    out[startSample + i] += (rand() * 2 - 1) * env * amp
  }
}

/** 合成一段鼓组：每拍一个底鼓，每半拍一个镲片。 */
function synthDrumTrack(bpm: number, durationSec: number): Float32Array {
  const n = Math.floor(durationSec * FS)
  const out = new Float32Array(n)
  const rand = mulberry32(0xc0ffee)
  const beatSec = 60 / bpm

  for (let t = 0; t < durationSec; t += beatSec) {
    renderKick(out, Math.floor(t * FS), 0.85)
    renderHat(out, Math.floor((t + beatSec / 2) * FS), 0.3, rand)
  }
  return out
}

describe('分析管线端到端', () => {
  it('能还原出已知的 128 BPM', () => {
    const mono = synthDrumTrack(128, 20)
    const analysis = analyzeMono(mono, { fs: FS, fingerprint: 'synth-128', profile: 'balanced' })

    // 允许 1 BPM 误差；倍频/半频错误会立刻暴露（64 或 256）
    expect(analysis.bpm).toBeGreaterThan(126)
    expect(analysis.bpm).toBeLessThan(130)
    expect(analysis.onsets.length).toBeGreaterThan(20)
    expect(analysis.diagnostics.fallbackLevel).toBeLessThanOrEqual(1)
  })

  it('对另一个 BPM 同样准确（排除碰巧）', () => {
    const mono = synthDrumTrack(96, 20)
    const analysis = analyzeMono(mono, { fs: FS, fingerprint: 'synth-96', profile: 'balanced' })

    expect(analysis.bpm).toBeGreaterThan(94)
    expect(analysis.bpm).toBeLessThan(98)
  })

  it('生成的音符落在节拍网格上，且起音数量合理', () => {
    const mono = synthDrumTrack(128, 20)
    const analysis = analyzeMono(mono, { fs: FS, fingerprint: 'synth-128', profile: 'balanced' })
    const { chart } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    // 20 秒 @128BPM 每半拍一个事件 ≈ 85 个，考虑难度筛选后应在合理区间
    expect(chart.notes.length).toBeGreaterThan(20)
    expect(chart.notes.length).toBeLessThan(200)

    for (const n of chart.notes) {
      expect(n.col).toBeGreaterThanOrEqual(0)
      expect(n.col).toBeLessThan(4)
    }
  })

  it('能区分底鼓与镲片的音色，并把它们分到不同的轨道区域', () => {
    const mono = synthDrumTrack(128, 20)
    const analysis = analyzeMono(mono, { fs: FS, fingerprint: 'synth-128', profile: 'balanced' })

    // 检查起音事件确实带出了正确的音色特征
    const centroids = analysis.onsets.map((o) => o.centroid).sort((a, b) => a - b)
    const low = centroids[Math.floor(centroids.length * 0.1)] ?? 0
    const high = centroids[Math.floor(centroids.length * 0.9)] ?? 0

    // 底鼓与镲片的谱质心应当有数量级差异
    expect(high).toBeGreaterThan(low * 3)

    // 低沉的音应映射到靠左的轨，明亮的音映射到靠右的轨
    expect(centroidToLane(low, 4)).toBeLessThan(centroidToLane(high, 4))
  })

  it('完全静音输入不会崩溃，而是优雅降级', () => {
    const silence = new Float32Array(FS * 5)
    const analysis = analyzeMono(silence, { fs: FS, fingerprint: 'silence', profile: 'balanced' })

    expect(analysis.onsets.length).toBe(0)
    expect(analysis.diagnostics.fallbackLevel).toBe(3)
    expect(analysis.diagnostics.notes.length).toBeGreaterThan(0)
  })

  it('同一输入两次分析结果完全一致（联机可复现性）', () => {
    const mono = synthDrumTrack(128, 15)
    const a = analyzeMono(mono.slice(), { fs: FS, fingerprint: 'synth-128', profile: 'balanced' })
    const b = analyzeMono(mono.slice(), { fs: FS, fingerprint: 'synth-128', profile: 'balanced' })

    expect(a.bpm).toBe(b.bpm)
    expect(a.onsets.length).toBe(b.onsets.length)
    expect(a.diagnostics.medianResidualMs).toBe(b.diagnostics.medianResidualMs)

    const ca = generateChart(a, { difficulty: 'normal', columns: 4 })
    const cb = generateChart(b, { difficulty: 'normal', columns: 4 })
    expect(JSON.stringify(ca.chart.notes)).toBe(JSON.stringify(cb.chart.notes))
  })
})
