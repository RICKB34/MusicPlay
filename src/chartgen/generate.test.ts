/**
 * 谱面生成的核心假设验证。
 *
 * 这里测的不是"代码跑不跑得通"，而是**产品设计假设成不成立**：
 * 用谱质心映射轨道，真的能让谱面"跟着音乐走"而不是"随机撒点"吗？
 * 反卡手约束真的生效了吗？谱面真的是可复现的吗？
 *
 * 这几条如果不成立，整个方案的核心卖点就是假的，越早发现越好。
 */

import { describe, expect, it } from 'vitest'
import { generateChart } from './generate'
import { createGrid } from './grid'
import type { OnsetEvent, TrackAnalysis } from '../types'

/** 造一个 128 BPM 的合成分析结果。 */
function synthAnalysis(
  bpm: number,
  durationSec: number,
  makeOnsets: (beatSec: number, duration: number) => OnsetEvent[],
): TrackAnalysis {
  return {
    fingerprint: 'test-fingerprint-128',
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

function onset(
  time: number,
  strength: number,
  centroid: number,
  merged = 1,
  // 默认 0：合成起音一律"没有延续"，于是永远不会被判成长按，
  // 这些用例断言的就是**不启用长按时**的谱面行为。
  sustainMs = 0,
): OnsetEvent {
  const t = Math.max(0, Math.min(1, (centroid - 200) / (6000 - 200)))
  return {
    time,
    rawStrength: strength,
    strength,
    centroid,
    lowRatio: 1 - t,
    midRatio: 0.3,
    highRatio: t,
    sustainMs,
    ...(merged > 1 ? {} : {}),
  }
}

describe('谱质心 → 轨道映射（核心设计假设）', () => {
  it('低沉的音落在左侧轨，明亮的音落在右侧轨', () => {
    const analysis = synthAnalysis(128, 30, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beat) {
        // 每拍一个底鼓（低沉），半拍处一个镲片（明亮）
        out.push(onset(t, 0.9, 80))
        out.push(onset(t + beat / 2, 0.7, 5200))
      }
      return out
    })

    const { chart } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    // 把每个音符时刻映射回它对应的原始起音，比较质心与轨道的关系
    const grid = createGrid(128, 0, 2)
    let lowCentroidLanes = 0
    let lowCentroidCount = 0
    let highCentroidLanes = 0
    let highCentroidCount = 0

    for (const note of chart.notes) {
      // 该音符来自哪个起音：找时刻最接近的那个
      const tSec = note.t / 1000
      const beat = 60 / 128
      const isOffbeat = Math.abs(((tSec / beat) % 1) - 0.5) < 0.1
      if (isOffbeat) {
        highCentroidLanes += note.col
        highCentroidCount++
      } else {
        lowCentroidLanes += note.col
        lowCentroidCount++
      }
    }

    expect(lowCentroidCount).toBeGreaterThan(10)
    expect(highCentroidCount).toBeGreaterThan(10)
    void grid

    const avgLow = lowCentroidLanes / lowCentroidCount
    const avgHigh = highCentroidLanes / highCentroidCount

    // 核心断言：低音的轨道编号显著小于高音
    expect(avgLow).toBeLessThan(avgHigh)
    expect(avgHigh - avgLow).toBeGreaterThan(1.0)
  })
})

describe('反卡手约束', () => {
  it('不会出现超长的同轨连击', () => {
    // 全部同质音色（最极端的情况：质心全都一样），
    // 此时只有反卡手约束能防止谱面塌缩成一条轨
    const analysis = synthAnalysis(128, 40, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beat / 2) out.push(onset(t, 0.8, 1000))
      return out
    })

    const { chart, quality } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    expect(chart.notes.length).toBeGreaterThan(20)

    // 统计最长同轨连续
    let run = 1
    let maxRun = 1
    for (let i = 1; i < chart.notes.length; i++) {
      if (chart.notes[i].col === chart.notes[i - 1].col) {
        run++
        maxRun = Math.max(maxRun, run)
      } else {
        run = 1
      }
    }

    // 允许少量超出（约束是软性的评分罚项，不是硬性禁止），
    // 但绝不能塌缩成"一路同轨打到底"
    expect(maxRun).toBeLessThan(6)
    expect(quality.collapsed).toBe(false)
  })

  it('轨道使用率不会完全塌缩到一条轨', () => {
    const analysis = synthAnalysis(120, 40, (beat, dur) => {
      const out: OnsetEvent[] = []
      // 质心连续变化，模拟真实音乐的音色多样性
      for (let t = 0, i = 0; t < dur; t += beat / 2, i++) {
        out.push(onset(t, 0.5 + 0.5 * Math.sin(i * 0.7), 300 + (i * 911) % 5000))
      }
      return out
    })

    const { quality } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    expect(quality.collapsed).toBe(false)
    expect(quality.meanLaneDelta).toBeGreaterThan(0.5)
    for (const u of quality.laneUsage) {
      expect(u).toBeGreaterThan(0.05)
    }
  })
})

describe('确定性（联机对战的硬性前提）', () => {
  it('同样的输入必须产出逐字节相同的谱面', () => {
    const make = () =>
      synthAnalysis(140, 30, (beat, dur) => {
        const out: OnsetEvent[] = []
        for (let t = 0, i = 0; t < dur; t += beat / 2, i++) {
          out.push(onset(t, 0.4 + 0.6 * Math.abs(Math.sin(i)), 400 + (i * 733) % 4000))
        }
        return out
      })

    const a = generateChart(make(), { difficulty: 'normal', columns: 4 })
    const b = generateChart(make(), { difficulty: 'normal', columns: 4 })

    expect(JSON.stringify(a.chart)).toBe(JSON.stringify(b.chart))
  })

  it('不同难度产出不同但都有效的谱面', () => {
    const make = () =>
      synthAnalysis(140, 30, (beat, dur) => {
        const out: OnsetEvent[] = []
        for (let t = 0, i = 0; t < dur; t += beat / 4, i++) {
          out.push(onset(t, 0.2 + 0.8 * Math.abs(Math.sin(i * 0.3)), 400 + (i * 733) % 4000))
        }
        return out
      })

    const easy = generateChart(make(), { difficulty: 'easy', columns: 4 })
    const hard = generateChart(make(), { difficulty: 'hard', columns: 4 })

    expect(easy.chart.notes.length).toBeLessThan(hard.chart.notes.length)
    expect(easy.chart.notes.length).toBeGreaterThan(0)
  })
})

describe('网格对齐', () => {
  it('生成的音符时刻落在节拍网格上', () => {
    const analysis = synthAnalysis(128, 20, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beat / 2) out.push(onset(t, 0.8, 2000))
      return out
    })

    const { chart } = generateChart(analysis, { difficulty: 'normal', columns: 4 })
    const grid = createGrid(chart.meta.bpm, chart.meta.gridOffsetMs / 1000, chart.meta.subdivision)

    for (const note of chart.notes) {
      const tSec = note.t / 1000
      const snapped = grid.stepTime(grid.nearestStep(tSec))
      expect(Math.abs(tSec - snapped)).toBeLessThan(0.002) // 2ms 内
    }
  })
})

/**
 * 回归测试：窄音色范围的曲目必须也能铺满所有轨道。
 *
 * 这是**真实曲目实测出来的缺陷**，合成测试原本覆盖不到——
 * 因为我早期的合成信号音色跨度都很大（底鼓 80Hz 到镲片 6000Hz），
 * 恰好躲开了这个问题。
 *
 * 实测《卡农》（弦乐合奏）时暴露：全曲谱质心只在 602-1094Hz 之间，
 * 而映射区间的固定端点是 200-6000Hz，于是几乎所有音符都落到最左轨，
 * 四轨使用率变成 **65%/2%/33%/0%**——一半轨道完全没用上。
 *
 * 修法是让映射区间由**本曲自己的音色分布**推算（p10/p90 归一化）。
 * 这个测试守住它：只要有人把自适应区间改回固定区间，立刻会红。
 */
describe('窄音色范围的曲目（弦乐/人声等无打击乐素材）', () => {
  it('音色跨度很窄时，四轨仍然都被用到且不塌缩', () => {
    // 模拟弦乐合奏：所有起音的谱质心都挤在 600-1100Hz 这个窄区间里
    const analysis = synthAnalysis(120, 40, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0, i = 0; t < dur; t += beat / 2, i++) {
        // 在窄区间内起伏，模拟弦乐声部的音高与音色变化
        const centroid = 620 + ((i * 137) % 460)
        out.push(onset(t, 0.5 + 0.5 * Math.abs(Math.sin(i * 0.6)), centroid))
      }
      return out
    })

    const { quality } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    expect(quality.collapsed).toBe(false)
    // 每条轨都应有实质使用量，而不是形同虚设
    for (const u of quality.laneUsage) {
      expect(u).toBeGreaterThan(0.08)
    }
  })

  it('同一首歌换难度时映射区间不变（映射是歌曲属性，不是难度属性）', () => {
    // 音色窄、且强弱差异明显：简单难度只留下最强的那些音，
    // 它们的音色分布会更窄——早期实现会因此退回固定区间而塌缩
    const analysis = synthAnalysis(120, 40, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0, i = 0; t < dur; t += beat / 2, i++) {
        const centroid = 620 + ((i * 137) % 460)
        out.push(onset(t, i % 4 === 0 ? 0.95 : 0.18, centroid))
      }
      return out
    })

    const easy = generateChart(analysis, { difficulty: 'easy', columns: 4 })
    const hard = generateChart(analysis, { difficulty: 'hard', columns: 4 })

    expect(easy.quality.collapsed).toBe(false)
    expect(hard.quality.collapsed).toBe(false)
    for (const u of easy.quality.laneUsage) expect(u).toBeGreaterThan(0.05)
  })
})

describe('双押（chord）生成', () => {
  it('同格多起音且谱质心跨度 ≥ 阈值时拆成双押', () => {
    // 每拍两个起音落在同一格点：低音 500Hz + 高音 1500Hz，跨度 1000Hz。
    // 阈值 800 时应拆成双押（同一时刻出现两个音符）；若阈值被改回 1500，
    // 这两个会被合并成一个音符，本条断言立刻变红。
    const analysis = synthAnalysis(120, 20, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beat) {
        out.push(onset(t, 0.9, 500))
        out.push(onset(t, 0.8, 1500))
      }
      return out
    })

    const { chart } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    // 按时刻统计音符数：双押 = 某个时刻有 ≥2 个音符
    const countByTime = new Map<number, number>()
    for (const n of chart.notes) {
      countByTime.set(n.t, (countByTime.get(n.t) ?? 0) + 1)
    }
    expect(Math.max(...countByTime.values())).toBeGreaterThanOrEqual(2)
  })

  it('小节线的强拍会被主动拆成双押', () => {
    // 每 4 拍（一小节）一个强音，落在小节线上 → 主动注入双押。
    // 这些是单起音（merged=1），被动拆分不会触发；若主动注入被去掉，
    // 它们就全是单音符，本条断言会立刻变红。
    const analysis = synthAnalysis(120, 20, (beat, dur) => {
      const out: OnsetEvent[] = []
      for (let t = 0; t < dur; t += beat * 4) {
        out.push(onset(t, 0.9, 1000))
      }
      return out
    })

    const { chart } = generateChart(analysis, { difficulty: 'normal', columns: 4 })

    const countByTime = new Map<number, number>()
    for (const n of chart.notes) countByTime.set(n.t, (countByTime.get(n.t) ?? 0) + 1)
    expect(Math.max(...countByTime.values())).toBeGreaterThanOrEqual(2)
  })
})
