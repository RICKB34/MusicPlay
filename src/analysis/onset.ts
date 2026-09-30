/**
 * 起音（onset）拾取 —— 自适应阈值 + 局部极大值 + 最小间隔去重。
 *
 * 为什么不用 `@audio/onset` 的 `peakPick`：它只返回时刻数组（Float64Array），
 * **不返回强度**。而 strength 是难度分级（保留哪些音符）和轨道分配的输入，
 * 所以必须自己拾取。算法思路与该库一致（局部均值 × delta），但顺带带出强度。
 */

import type { OnsetEvent } from '../types'
import { frameTime, type FrameFeatures } from './stft'
import { percentile } from '../chartgen/grid'

export interface OnsetPickOptions {
  /** 局部均值窗口半径（帧）。默认 8。 */
  windowSize?: number
  /** 阈值相对局部均值的倍数。越小越灵敏、起音越密。默认 1.4。 */
  delta?: number
  /**
   * 最小起音间隔（毫秒）。默认 45ms。
   * 抑制同一击打被相邻帧重复触发——这类重复会让谱面出现物理上打不出的音符。
   */
  minGapMs?: number
}

/** 把帧索引处的逐帧特征附着到起音事件上。 */
function toOnsetEvent(f: FrameFeatures, frame: number, rawStrength: number): OnsetEvent {
  return {
    time: frameTime(frame, f.hopSize, f.frameSize, f.fs),
    rawStrength,
    strength: rawStrength, // 归一化在最后统一做
    centroid: f.centroid[frame],
    lowRatio: f.lowRatio[frame],
    midRatio: f.midRatio[frame],
    highRatio: f.highRatio[frame],
    sustainMs: measureSustainMs(f, frame),
  }
}

/** 持续时长的测量上限（毫秒）。再长也不认为它还在延续。 */
const SUSTAIN_MAX_MS = 4000
/**
 * 能量掉到起始值的这个比例以下，就认为这个音已经结束了。
 *
 * 取 0.5 是"还在响"与"已经过去"的分界。定太高会把颤音、渐弱的正常音符
 * 切成短音；定太低会把余音、混响尾巴也算进持续里。
 */
const SUSTAIN_DROP_RATIO = 0.5

/**
 * 测量一个起音之后能量延续了多久（毫秒）。
 *
 * **盯住起音自身所在的频段，而不是全带能量。** 这是本函数唯一重要的设计。
 * 用全带会得到这样的结果：一段"底鼓 + 持续人声"的段落里，底鼓本身几十毫秒
 * 就衰减完了，但人声把总能量一直撑在高位，于是**每一个鼓点都会被判成两拍长按**，
 * 谱面立刻变成一堵长按墙。按频段分开看就没有这个问题——底鼓看低频段，
 * 那里只有它自己。
 */
function measureSustainMs(features: FrameFeatures, frame: number): number {
  const { rms, lowRatio, midRatio, highRatio, hopSize, fs, nFrames } = features

  const r0 = rms[frame] ?? 0
  const e0 = r0 * r0
  if (e0 <= 1e-12) return 0

  // 起音落在哪个频段，就盯哪个频段
  const lo = lowRatio[frame] ?? 0
  const mid = midRatio[frame] ?? 0
  const hi = highRatio[frame] ?? 0
  const band = lo >= mid && lo >= hi ? 0 : mid >= hi ? 1 : 2
  const bandAt = (i: number): number =>
    band === 0 ? (lowRatio[i] ?? 0) : band === 1 ? (midRatio[i] ?? 0) : (highRatio[i] ?? 0)

  const ref = e0 * bandAt(frame)
  if (ref <= 1e-12) return 0

  const threshold = ref * SUSTAIN_DROP_RATIO
  const maxFrames = Math.floor(((SUSTAIN_MAX_MS / 1000) * fs) / hopSize)
  const end = Math.min(nFrames, frame + maxFrames + 1)

  let last = frame
  for (let i = frame + 1; i < end; i++) {
    const r = rms[i] ?? 0
    if (r * r * bandAt(i) < threshold) break
    last = i
  }

  return ((last - frame) * hopSize * 1000) / fs
}

/**
 * 从逐帧特征里拾取起音事件。
 *
 * `strength` 会按全曲 p95 归一化到 [0,1] —— 归一化必须在**全曲**范围内做，
 * 这是离线分析相对流式分析的关键优势：阈值不会随段落漂移，同一份音频
 * 永远得到同样的谱面（联机对战要求可复现）。
 */
export function detectOnsets(
  features: FrameFeatures,
  opts: OnsetPickOptions = {},
): OnsetEvent[] {
  const { odf, nFrames } = features
  if (nFrames < 3) return []

  const windowSize = opts.windowSize ?? 8
  const delta = opts.delta ?? 1.4
  const minGapMs = opts.minGapMs ?? 45

  // ── 第 1 步：找出所有候选峰值（局部极大 + 超过自适应阈值）──
  interface Candidate {
    frame: number
    strength: number
  }
  const candidates: Candidate[] = []

  for (let f = 1; f < nFrames - 1; f++) {
    const v = odf[f]
    if (v <= 0) continue
    if (v <= odf[f - 1] || v < odf[f + 1]) continue // 非局部极大（平顶时取最左）

    const start = Math.max(0, f - windowSize)
    const end = Math.min(nFrames, f + windowSize + 1)
    let sum = 0
    for (let i = start; i < end; i++) sum += odf[i]
    const mean = sum / (end - start)

    if (v > mean * delta && v > 1e-9) candidates.push({ frame: f, strength: v })
  }

  // ── 第 2 步：按强度降序贪心接受，保证最小间隔 ──
  // 同一击打常在相邻 2-3 帧都形成局部极大，必须先收强者。
  const frameGap = (minGapMs / 1000) * features.fs / features.hopSize
  candidates.sort((a, b) => b.strength - a.strength)

  const accepted: Candidate[] = []
  for (const c of candidates) {
    let clash = false
    for (const a of accepted) {
      if (Math.abs(a.frame - c.frame) < frameGap) {
        clash = true
        break
      }
    }
    if (!clash) accepted.push(c)
  }

  accepted.sort((a, b) => a.frame - b.frame)

  // ── 第 3 步：全曲 p95 归一化强度 ──
  // 用 p95 而非 max：单次爆音（拍手、爆音）会把 max 抬得极高，导致其余音符全被压扁。
  const p95 = percentile(
    accepted.map((c) => c.strength),
    0.95,
  )
  const scale = p95 > 1e-9 ? 1 / p95 : 1

  return accepted.map((c) => {
    const ev = toOnsetEvent(features, c.frame, c.strength)
    ev.strength = Math.min(1, c.strength * scale)
    ev.time = refineOnsetTime(features, c.frame, ev.time)
    return ev
  })
}

/**
 * 亚帧时间精化 —— 用抛物线插值求 ODF 峰值的真实位置。
 *
 * 为什么必需：帧间跳距 hop 决定了起音的时间分辨率。hop=512 @22050Hz
 * 就是 23.2ms，而一个 128 BPM 的半拍是 234.4ms = 10.09 帧——
 * 取整到 10 帧变成 232.2ms，产生 0.9% 的系统误差，累积到曲末就是秒级漂移。
 *
 * 在峰值两侧各取一帧做三点抛物线拟合，可以把精度提升一个数量级：
 *
 *        y0        y2
 *         \   y1  /
 *          \  |  /
 *           \_|_/
 *             ↑ 顶点偏移 δ ∈ [-0.5, 0.5]
 *
 * δ = 0.5·(y0 − y2) / (y0 − 2·y1 + y2)
 *
 * 这是标准的峰值插值做法，成本 O(起音数)，可忽略。
 */
function refineOnsetTime(features: FrameFeatures, frame: number, fallbackTime: number): number {
  const { odf, nFrames, hopSize, frameSize, fs } = features
  if (frame <= 0 || frame >= nFrames - 1) return fallbackTime

  const y0 = odf[frame - 1]
  const y1 = odf[frame]
  const y2 = odf[frame + 1]
  if (y0 == null || y1 == null || y2 == null) return fallbackTime

  // 分母为 0 表示三点共线（平顶或退化），此时不做插值
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < 1e-12) return fallbackTime

  let delta = (0.5 * (y0 - y2)) / denom
  // 顶点必须在两点之间；越界说明不是真正的抛物线峰（多是噪声），放弃插值
  if (!Number.isFinite(delta) || delta < -0.5 || delta > 0.5) return fallbackTime

  // 与 frameTime() 保持同样的"帧中心"约定
  return ((frame + delta) * hopSize + frameSize / 2) / fs
}
