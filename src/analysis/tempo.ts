/**
 * 测速与拍点网格 —— 含倍频消歧与四级降级链。
 *
 * 主路径用 `@audio/beat-detect`（谱通量起音 → 梳状滤波测速 → 相位对齐拍点网格）。
 *
 * **倍频错误（octave error）是节拍跟踪最经典的失效模式**：一个 96 BPM 的曲子
 * 很容易被识别成 192 BPM，因为底鼓在正拍、镲片在反拍时，起音序列在时间上
 * 是等距的，"每拍一击"和"每半拍一击"在纯周期意义上无法区分。
 *
 * 实测踩到的坑：早期的 `scoreGrid` 只按**四分音符位置**打分，于是当所有音符
 * 都落在反拍上时，半速网格的得分恒为 0，倍速网格反而胜出——降级链不仅没救回来，
 * 还会把正确答案判为最差。
 *
 * 现在的做法是两步：
 *   1. 相位打分按**细分网格**（1/16）算，半速网格不再被无理由惩罚
 *   2. 候选 BPM 之间用「网格贴合度 + 节拍先验」加权比较，由先验来消歧倍频
 *
 * 节拍先验不是拍脑袋：人耳对 100-140 BPM 附近的节奏有天然偏好
 * （Moelants 2002 的共振曲线，峰值约 120 BPM），这是可用的音乐学先验。
 */

import detect from '@audio/beat-detect'
import type { FallbackLevel, OnsetEvent, Subdivision } from '../types'
import { chooseSubdivision, createGrid, medianResidualMs, type BeatGrid } from '../chartgen/grid'

export interface TempoResult {
  bpm: number
  confidence: number
  /** 拍点时刻（秒）。 */
  beats: number[]
  /** 网格相位（第 0 拍时刻，秒）。 */
  gridOffsetSec: number
  grid: BeatGrid
  fallbackLevel: FallbackLevel
  notes: string[]
}

export interface TempoOptions {
  fs: number
  frameSize?: number
  hopSize?: number
  minBpm?: number
  maxBpm?: number
}

/** 残差中位数超过此值（毫秒）就认为网格不贴合。 */
const RESIDUAL_TOLERANCE_MS = 35
/** 低于此置信度直接进入降级链。 */
const CONFIDENCE_FLOOR = 0.25
/** 相位搜索的候选数。20 个已能覆盖到半拍偏移。 */
const PHASE_TRIALS = 20
/** 相位打分用的细分：用 1/16 网格，避免反拍音符被误判。 */
const PHASE_SUBDIVISION: Subdivision = 4

/**
 * 节拍先验 —— 人对 ~120 BPM 附近节奏的偏好。
 *
 * 对数正态形状，在 120 BPM 取峰值。sigma 取 0.9 个八度，
 * 意味着 60 和 240 BPM 的权重降到约 0.5——足够强到能消歧倍频，
 * 又不至于强行把所有曲子都拉向 120。
 */
export function tempoPrior(bpm: number): number {
  if (bpm <= 0) return 0
  const octavesFromCenter = Math.log2(bpm / 120)
  return Math.exp(-0.5 * (octavesFromCenter / 0.9) ** 2)
}

/**
 * 给定周期与相位，按细分网格打分。
 *
 * 两点关键设计：
 *
 * 1. **按细分网格而非四分音符打分**。否则全落在反拍的音符会让半速候选
 *    得零分，从而选出倍速的错误答案（这是实测踩过的坑）。
 *
 * 2. **按起音强度加权**。节拍是由**重音**定义的，不是由最密集的起音流定义的。
 *    真实音乐里底鼓（强）在正拍、镲片（弱）在反拍，等权处理时密集的弱起音
 *    会淹没强重音携带的节拍信息——实测中合成信号的 BPM 检出值因此在
 *    104/120/157/190 之间乱跳。加权后重音主导，节拍才稳定。
 */
function scoreGrid(
  periodSec: number,
  phaseSec: number,
  onsets: OnsetEvent[],
  subdivision: Subdivision = PHASE_SUBDIVISION,
  toleranceFraction = 0.3,
): number {
  if (onsets.length === 0 || periodSec <= 0) return 0
  const step = periodSec / subdivision
  const tol = step * toleranceFraction
  let weighted = 0
  let totalWeight = 0
  for (const o of onsets) {
    let d = (((o.time - phaseSec) % step) + step) % step
    if (d > step / 2) d = step - d
    // 权重下限 0.05，避免极弱起音被完全忽略（它们仍携带节拍信息）
    const w = Math.max(0.05, o.strength)
    if (d < tol) weighted += w * (1 - d / tol)
    totalWeight += w
  }
  return totalWeight > 0 ? weighted / totalWeight : 0
}

function bestPhaseFor(
  periodSec: number,
  onsets: OnsetEvent[],
  trials: number = PHASE_TRIALS,
): { phase: number; score: number } {
  const coarseTrials = Math.max(4, Math.floor(trials))
  let best = { phase: 0, score: -Infinity }
  for (let p = 0; p < coarseTrials; p++) {
    const phase = (p / coarseTrials) * periodSec
    const s = scoreGrid(periodSec, phase, onsets)
    if (s > best.score) best = { phase, score: s }
  }

  // 粗搜的相位分辨率可能超过 20ms。再围绕胜出的相位做两轮局部细化，
  // 把误差压到约 1ms，避免全曲谱面被一个固定相位偏差整体推晚或推早。
  let radius = periodSec / coarseTrials / 2
  for (let pass = 0; pass < 2; pass++) {
    const center = best.phase
    for (let i = -8; i <= 8; i++) {
      const phase = normalizePhase(center + (i / 8) * radius, periodSec)
      const s = scoreGrid(periodSec, phase, onsets)
      if (s > best.score) best = { phase, score: s }
    }
    radius /= 8
  }

  return best
}

function normalizePhase(phase: number, periodSec: number): number {
  return ((phase % periodSec) + periodSec) % periodSec
}

/** 由 {bpm, phase} 生成拍点时刻数组。 */
function buildBeats(bpm: number, phase: number, durationSec: number): number[] {
  const period = 60 / bpm
  const beats: number[] = []
  let t = phase
  // 首拍离 0 太远就往前补一拍，避免开头一段没有网格
  if (t > period * 0.25 && t - period >= 0) t -= period
  for (; t < durationSec; t += period) if (t >= 0) beats.push(t)
  return beats
}

export interface CandidateEvaluation {
  bpm: number
  phase: number
  grid: BeatGrid
  subdivision: Subdivision
  residualMs: number
  /** 网格贴合度 [0,1]，1 表示完全贴合。 */
  fit: number
  prior: number
  /** 综合得分 = 贴合度 × 0.6 + 先验 × 0.4。 */
  score: number
}

/**
 * 完整评估一个候选 BPM：搜相位 → 定细分 → 算残差 → 加先验。
 *
 * @param fixedSubdivision 指定细分则跳过自动选择。精搜阶段必须固定它，
 *   否则细分会在相邻 BPM 之间来回跳变，导致得分函数不连续、搜索失去意义。
 * @param phaseTrials 相位搜索的候选数。精搜阶段可减少以省算力。
 */
export function evaluateBpm(
  bpm: number,
  onsets: OnsetEvent[],
  fixedSubdivision?: Subdivision,
  phaseTrials: number = PHASE_TRIALS,
): CandidateEvaluation {
  const period = 60 / bpm
  const { phase } = bestPhaseFor(period, onsets, phaseTrials)
  const subdivision = fixedSubdivision ?? chooseSubdivision(bpm, phase, onsets).subdivision
  const grid = createGrid(bpm, phase, subdivision)
  const residualMs = medianResidualMs(grid, onsets)

  // 残差 0ms → fit 1.0；20ms → 0.5；正无穷 → 0
  const fit = residualMs === Infinity ? 0 : 1 / (1 + residualMs / 20)
  const prior = tempoPrior(bpm)

  return {
    bpm,
    phase,
    grid,
    subdivision,
    residualMs,
    fit,
    prior,
    score: fit * 0.6 + prior * 0.4,
  }
}

/** 精搜时用的相位候选数。比粗搜少，因为相位不会因 BPM 微调而大幅改变。 */
const REFINE_PHASE_TRIALS = 8
/** 精搜范围：粗估值 ±6%。覆盖帧量化误差（典型 <2%）绰绰有余。 */
const REFINE_SPAN = 0.06

/**
 * BPM 局部精搜 —— 修正帧量化带来的系统性速度误差。
 *
 * 为什么必需：起音时刻受 STFT 帧跳距量化，hop=512 @22050Hz 就是 23.2ms。
 * 一个 128 BPM 的半拍是 234.4ms = 10.09 帧，取整到 10 帧变成 232.2ms，
 * 于是任何基于单次周期估计的方法都会得到约 130 BPM（误差 1.5%）。
 * 这个误差累积到 3 分钟的曲末就是 2.8 秒的网格漂移，谱面会彻底对不上。
 *
 * 解法：不依赖单次周期估计，而是**用全曲几十上百个起音一起投票**——
 * 搜索使总量化残差最小的周期，帧量化的随机部分被平均掉，
 * 系统性部分则被真正的最小值点排除。
 *
 * 两遍搜索：先 0.1 BPM 粗搜定位，再在最优附近 0.01 BPM 细分。
 */
function refineBpm(
  coarse: CandidateEvaluation,
  onsets: OnsetEvent[],
  lo: number,
  hi: number,
): CandidateEvaluation {
  const span = coarse.bpm * REFINE_SPAN
  const start = Math.max(lo, coarse.bpm - span)
  const end = Math.min(hi, coarse.bpm + span)

  let best = coarse
  for (let bpm = start; bpm <= end; bpm += 0.1) {
    const e = evaluateBpm(bpm, onsets, coarse.subdivision, REFINE_PHASE_TRIALS)
    if (e.score > best.score) best = e
  }

  // 第二遍：在最优附近以 0.01 BPM 细分，锁定到百分位
  const s2 = best.bpm
  for (let bpm = s2 - 0.15; bpm <= s2 + 0.15; bpm += 0.01) {
    if (bpm < lo || bpm > hi) continue
    const e = evaluateBpm(bpm, onsets, best.subdivision, REFINE_PHASE_TRIALS)
    if (e.score > best.score) best = e
  }

  // 最终对锁定下来的 BPM 做一次完整相位搜索
  return evaluateBpm(best.bpm, onsets, best.subdivision, PHASE_TRIALS)
}

/**
 * L2：完全绕开频域测速，只在起音时刻序列上做梳状搜索。
 *
 * 当 `detect()` 的置信度很低（通常是曲风让梳状滤波失效）时兜底。
 * 只负责给出一个候选，是否采用由后续的候选比较决定。
 */
function combSearchBpm(onsets: OnsetEvent[]): { bpm: number; confidence: number } {
  if (onsets.length < 8) return { bpm: 0, confidence: 0 }

  let bestBpm = 0
  let bestScore = -Infinity
  let total = 0
  let n = 0

  // 步长 1 BPM 即可：这里只负责**产生候选**，精度由后续的局部精搜保证。
  // 步长再细只是徒增算力，不会改变谁进入候选集。
  for (let bpm = 60; bpm <= 200; bpm += 1) {
    const { score } = bestPhaseFor(60 / bpm, onsets)
    total += score
    n++
    if (score > bestScore) {
      bestScore = score
      bestBpm = bpm
    }
  }

  const mean = n > 0 ? total / n : 0
  const confidence = bestScore > 0 ? Math.max(0, Math.min(1, (bestScore - mean) / bestScore)) : 0
  return { bpm: bestBpm, confidence }
}

/** 生成一个 BPM 及其倍频/半频的候选列表（去重并限制在合理范围）。 */
function withOctaves(bpm: number, lo: number, hi: number): number[] {
  if (bpm <= 0) return []
  const out: number[] = []
  for (const f of [1, 2, 0.5, 4, 0.25]) {
    const v = bpm * f
    if (v >= lo && v <= hi) out.push(v)
  }
  return out
}

export function estimateTempo(
  mono: Float32Array | Float64Array,
  onsets: OnsetEvent[],
  opts: TempoOptions,
): TempoResult {
  const notes: string[] = []
  const fs = opts.fs
  const frameSize = opts.frameSize ?? 2048
  const hopSize = opts.hopSize ?? 512
  const durationSec = mono.length / fs
  const lo = opts.minBpm ?? 50
  const hi = opts.maxBpm ?? 220

  if (onsets.length < 4) {
    notes.push('起音数量不足，直接进入无网格模式')
    const grid = createGrid(120, 0, 1)
    return {
      bpm: 120,
      confidence: 0,
      beats: buildBeats(120, 0, durationSec),
      gridOffsetSec: 0,
      grid,
      fallbackLevel: 3,
      notes,
    }
  }

  // ── 收集候选 ──
  let detectBpm = 0
  let confidence = 0
  try {
    const r = detect(mono, { fs, frameSize, hopSize, minBpm: 60, maxBpm: 200 })
    detectBpm = r.bpm
    confidence = r.confidence
    notes.push(`库测速 ${detectBpm.toFixed(1)} BPM（置信度 ${confidence.toFixed(2)}）`)
  } catch (e) {
    notes.push(`detect() 抛错：${(e as Error).message}`)
  }

  const candidateSet = new Set<number>()
  for (const b of withOctaves(detectBpm, lo, hi)) candidateSet.add(b)

  // ── 纯起音梳状搜索：**无条件运行**，不拿库的置信度当开关 ──
  //
  // 这是实测踩到的重要一课：库在 120 BPM 的信号上返回了 200 BPM
  // （正好顶在搜索区间上界，典型的梳状滤波退化），而且 **confidence = 1.00**。
  // 拿置信度当降级开关完全无效。
  //
  // 更致命的是候选集不能只锚定在库的输出上：若库给出 200，其倍频只有
  // {200, 100, 50}，而正确答案 120 永远进不了候选——即使 120 的贴合度得分
  // 远高于所有候选（0.853 vs 0.609）也无济于事。
  //
  // 所以候选集必须有一个**独立于库自评**的来源。代价是一次梳状搜索，
  // 对几千个起音的曲子约 0.1-0.2 秒，跑在 Worker 里可忽略。
  const comb = combSearchBpm(onsets)
  const combBpm = comb.bpm
  if (combBpm > 0) {
    notes.push(`纯起音梳状搜索 ${combBpm.toFixed(1)} BPM（置信度 ${comb.confidence.toFixed(2)}）`)
    for (const b of withOctaves(combBpm, lo, hi)) candidateSet.add(b)
  }

  if (candidateSet.size === 0) {
    notes.push('没有任何可用候选，进入无网格模式')
    const grid = createGrid(120, 0, 1)
    return {
      bpm: 120,
      confidence: 0,
      beats: buildBeats(120, 0, durationSec),
      gridOffsetSec: 0,
      grid,
      fallbackLevel: 3,
      notes,
    }
  }

  // ── 粗评所有候选，用「贴合度 + 节拍先验」排序 ──
  const coarse = Array.from(candidateSet)
    .map((bpm) => evaluateBpm(bpm, onsets))
    .sort((a, b) => b.score - a.score)

  // ── 对排名靠前的候选做局部精搜，修正帧量化带来的速度误差 ──
  // 只精搜前 2 个：通常就是真实速度与其倍频，再多是浪费算力。
  const refined = coarse.slice(0, 2).map((c) => refineBpm(c, onsets, lo, hi))

  const best = [...coarse, ...refined].sort((a, b) => b.score - a.score)[0]
  if (!best) {
    const grid = createGrid(120, 0, 1)
    return {
      bpm: 120,
      confidence: 0,
      beats: buildBeats(120, 0, durationSec),
      gridOffsetSec: 0,
      grid,
      fallbackLevel: 3,
      notes,
    }
  }

  // ── 判定降级级别 ──
  // 分三种情况：与库一致（可能含精搜微调）、倍频纠正、改用纯起音搜索。
  // 精搜后 130 → 128.5 是同一速度的修正，绝不能误判成倍频纠正。
  const within = (a: number, b: number, tol: number) => b > 0 && Math.abs(a / b - 1) < tol
  const ratio = detectBpm > 0 ? best.bpm / detectBpm : 1
  const isOctaveOfDetect =
    Math.abs(ratio - 2) < 0.08 ||
    Math.abs(ratio - 0.5) < 0.04 ||
    Math.abs(ratio - 4) < 0.15 ||
    Math.abs(ratio - 0.25) < 0.02
  const matchesDetect = within(best.bpm, detectBpm, 0.1) && !isOctaveOfDetect
  const matchesComb = within(best.bpm, combBpm, 0.1)

  let level: FallbackLevel = 0
  if (isOctaveOfDetect) level = 1
  else if (!matchesDetect) level = 2

  if (matchesDetect) {
    const deltaBpm = best.bpm - detectBpm
    const label = Math.abs(deltaBpm) > 0.05 ? '速度精搜' : '库测速'
    notes.push(
      `${label}：${best.bpm.toFixed(1)} BPM（修正 ${deltaBpm >= 0 ? '+' : ''}${deltaBpm.toFixed(2)}，残差 ${best.residualMs.toFixed(1)}ms）`,
    )
  } else if (level === 1) {
    notes.push(
      `倍频纠正：${detectBpm.toFixed(1)} → ${best.bpm.toFixed(1)} BPM（贴合度 ${best.fit.toFixed(2)}，先验 ${best.prior.toFixed(2)}）`,
    )
  } else if (level === 2) {
    notes.push(
      `改用纯起音搜索：库给的 ${detectBpm > 0 ? detectBpm.toFixed(1) : '—'} BPM 贴合度过低，` +
        `采用 ${best.bpm.toFixed(1)} BPM（残差 ${best.residualMs.toFixed(1)}ms vs 库候选更差）` +
        (matchesComb ? '，与梳状搜索结果一致' : ''),
    )
  }

  const beats = buildBeats(best.bpm, best.phase, durationSec)
  const beatsOk = beats.length >= 4

  // ── 最后自检：贴合度仍然太差就走 L3 无网格 ──
  if (!beatsOk || best.residualMs > RESIDUAL_TOLERANCE_MS) {
    notes.push(
      `L3 无网格模式：残差 ${best.residualMs.toFixed(1)}ms（拍点数 ${beats.length}）仍超阈值，改用起音时刻直接作为音符`,
    )
    return {
      bpm: best.bpm > 0 ? best.bpm : 120,
      confidence: 0,
      beats: beatsOk ? beats : buildBeats(best.bpm || 120, 0, durationSec),
      gridOffsetSec: best.phase,
      grid: createGrid(best.bpm || 120, best.phase, 1),
      fallbackLevel: 3,
      notes,
    }
  }

  notes.push(
    `最终采用 ${best.bpm.toFixed(1)} BPM，1/${best.subdivision} 细分，残差中位数 ${best.residualMs.toFixed(1)}ms`,
  )

  return {
    bpm: best.bpm,
    confidence,
    beats,
    gridOffsetSec: best.phase,
    grid: createGrid(best.bpm, best.phase, best.subdivision),
    fallbackLevel: level,
    notes,
  }
}
