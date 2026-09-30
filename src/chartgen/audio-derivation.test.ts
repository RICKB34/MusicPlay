/**
 * 谱面必须真的由音频推导出来 —— 把这个不变量固化成测试。
 *
 * 存在的意义：这是个容易被怀疑、也容易被后续改动悄悄破坏的性质。
 * 如果哪天有人调参把谱质心映射的权重调没了，谱面就会退化成
 * "按节拍随机撒点"——表面看还是一份能玩的谱子，但和音乐再无关系。
 * 那种退化很难靠肉眼发现，必须靠测试锁住。
 *
 * 三个测量：
 *   1. 音符时刻能否追溯到真实检测到的起音
 *   2. 音色（谱质心）与轨道位置的相关性
 *   3. 消融实验：抹掉音色信息后，多少音符会换轨道
 */

import { describe, expect, it } from 'vitest'
import { analyzeMono } from '../analysis/analyzeTrack'
import { generateChart } from './generate'
import type { OnsetEvent, TrackAnalysis } from '../types'

const FS = 22050

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
 * 一段 4/4 鼓组，三档音色刻意拉开：
 *   底鼓 每拍 / 军鼓 第 2、4 拍 / 镲片 反拍
 *
 * `humanize` 为 true 时加入 ±8ms 时间抖动与 ±25% 力度起伏——
 * 这既是真实演奏的特征，也能消除"机器级完美周期"带来的节拍歧义。
 */
function synthTrack(bpm: number, dur: number, humanize: boolean): Float32Array {
  const n = Math.floor(dur * FS)
  const out = new Float32Array(n)
  const rand = mulberry32(0xbeef)
  const beat = 60 / bpm
  const jitter = () => (humanize ? (rand() - 0.5) * 0.016 : 0)
  const vel = () => (humanize ? 0.75 + rand() * 0.5 : 1)

  const addKick = (t: number) => {
    const s = Math.max(0, Math.floor(t * FS))
    let phase = 0
    const g = vel()
    for (let k = 0; k < 0.12 * FS && s + k < n; k++) {
      const tt = k / FS
      phase += (2 * Math.PI * (45 + 75 * Math.exp(-tt / 0.02))) / FS
      out[s + k] += Math.sin(phase) * Math.exp(-tt / 0.04) * 0.9 * g
    }
  }

  // 军鼓：白噪声过两级一阶低通，能量压到中频
  const addSnare = (t: number) => {
    const s = Math.max(0, Math.floor(t * FS))
    let lp1 = 0
    let lp2 = 0
    const g = vel()
    for (let k = 0; k < 0.1 * FS && s + k < n; k++) {
      const tt = k / FS
      const w = rand() * 2 - 1
      lp1 += 0.18 * (w - lp1)
      lp2 += 0.18 * (lp1 - lp2)
      out[s + k] += lp2 * Math.exp(-tt / 0.035) * 1.6 * g
    }
  }

  // 镲片：白噪声一阶高通，能量推到高频
  const addHat = (t: number) => {
    const s = Math.max(0, Math.floor(t * FS))
    let prev = 0
    const g = vel()
    for (let k = 0; k < 0.05 * FS && s + k < n; k++) {
      const tt = k / FS
      const w = rand() * 2 - 1
      out[s + k] += (w - prev) * Math.exp(-tt / 0.012) * 0.35 * g
      prev = w
    }
  }

  for (let bar = 0; bar * 4 * beat < dur; bar++) {
    for (let b = 0; b < 4; b++) {
      const t = (bar * 4 + b) * beat + jitter()
      if (t >= dur || t < 0) continue
      addKick(t)
      if (b === 1 || b === 3) addSnare(t + jitter())
      const off = t + beat / 2
      if (off < dur) addHat(off)
    }
  }
  return out
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 3) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const den = Math.sqrt(dx * dy)
  return den < 1e-12 ? 0 : num / den
}

function nearestOnset(onsets: OnsetEvent[], tSec: number): OnsetEvent | null {
  let best: OnsetEvent | null = null
  let bestD = Infinity
  for (const o of onsets) {
    const d = Math.abs(o.time - tSec)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  // 60ms 内才算同一个事件
  return bestD < 0.06 ? best : null
}

const BPM = 120
const DURATION = 24

function buildChart() {
  const mono = synthTrack(BPM, DURATION, true)
  const analysis = analyzeMono(mono, { fs: FS, fingerprint: 'derivation', profile: 'balanced' })
  const generated = generateChart(analysis, { difficulty: 'normal', columns: 4 })
  return { analysis, chart: generated.chart }
}

describe('谱面确实由音频推导而来', () => {
  it('BPM 能被正确还原（真实演奏特征下）', () => {
    const { analysis } = buildChart()
    expect(analysis.bpm).toBeGreaterThan(BPM - 2)
    expect(analysis.bpm).toBeLessThan(BPM + 2)
  })

  it('每个音符的时刻都能追溯到一个真实检测到的起音', () => {
    const { analysis, chart } = buildChart()
    expect(chart.notes.length).toBeGreaterThan(20)

    let matched = 0
    const timingErrorsMs: number[] = []
    for (const note of chart.notes) {
      const onset = nearestOnset(analysis.onsets, note.t / 1000)
      if (onset) {
        matched++
        timingErrorsMs.push(Math.abs(note.t / 1000 - onset.time) * 1000)
      }
    }

    // 允许极少数因网格合并而偏移的边界情况，但必须绝大部分能对上
    expect(matched / chart.notes.length).toBeGreaterThan(0.95)

    timingErrorsMs.sort((a, b) => a - b)
    const medianError = timingErrorsMs[Math.floor(timingErrorsMs.length / 2)] ?? Infinity
    // 保留真实起音微时序后，音符不应再被统一吸到几十毫秒外的格点上。
    expect(medianError).toBeLessThan(4)
  })

  it('音色决定了音符落在哪条轨（相关性显著）', () => {
    const { analysis, chart } = buildChart()

    const pairs: { centroid: number; col: number }[] = []
    for (const note of chart.notes) {
      const o = nearestOnset(analysis.onsets, note.t / 1000)
      if (o) pairs.push({ centroid: o.centroid, col: note.col })
    }
    expect(pairs.length).toBeGreaterThan(20)

    const r = pearson(
      pairs.map((p) => p.centroid),
      pairs.map((p) => p.col),
    )
    // 音色越明亮，轨道编号应越大
    expect(r).toBeGreaterThan(0.6)

    // 低音色档必须明显靠左于高音色档
    const sorted = [...pairs].sort((a, b) => a.centroid - b.centroid)
    const third = Math.floor(sorted.length / 3)
    const lowAvg = sorted.slice(0, third).reduce((a, p) => a + p.col, 0) / Math.max(1, third)
    const highAvg =
      sorted.slice(-third).reduce((a, p) => a + p.col, 0) / Math.max(1, third)
    expect(highAvg - lowAvg).toBeGreaterThan(1.0)
  })

  it('消融实验：抹掉音色信息后，大部分音符会换轨道', () => {
    const { analysis, chart } = buildChart()

    // 把谱质心抹成常数，其余一切不变，重新生成
    const meanCentroid =
      analysis.onsets.reduce((a, o) => a + o.centroid, 0) / Math.max(1, analysis.onsets.length)
    const ablated: TrackAnalysis = {
      ...analysis,
      onsets: analysis.onsets.map((o) => ({
        ...o,
        centroid: meanCentroid,
        centroidMin: meanCentroid,
        centroidMax: meanCentroid,
      })),
    }
    const ablatedChart = generateChart(ablated, { difficulty: 'normal', columns: 4 }).chart

    const origByTime = new Map(chart.notes.map((n) => [n.t, n.col]))
    let compared = 0
    let changed = 0
    for (const n of ablatedChart.notes) {
      const origCol = origByTime.get(n.t)
      if (origCol === undefined) continue
      compared++
      if (origCol !== n.col) changed++
    }

    expect(compared).toBeGreaterThan(20)
    // 音色是轨道分配的主导因素，去掉它应当显著改变结果。
    // 阈值取 0.5 而非更高：反卡手/左右手均衡等规则本身也会贡献一部分轨道决策。
    expect(changed / compared).toBeGreaterThan(0.5)
  })

  it('换一首歌会得到完全不同的谱面', () => {
    const a = buildChart()
    const mono2 = synthTrack(96, DURATION, true)
    const analysis2 = analyzeMono(mono2, { fs: FS, fingerprint: 'derivation-2', profile: 'balanced' })
    const chart2 = generateChart(analysis2, { difficulty: 'normal', columns: 4 }).chart

    const timesA = new Set(a.chart.notes.map((n) => n.t))
    const shared = chart2.notes.filter((n) => timesA.has(n.t)).length
    // 不同速度、不同结构的歌，谱面不应有多少重合
    expect(shared).toBeLessThan(a.chart.notes.length * 0.2)
  })
})
