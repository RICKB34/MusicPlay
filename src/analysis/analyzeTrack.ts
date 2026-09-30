/**
 * 分析编排 —— 把解码后的单声道数据变成 TrackAnalysis。
 *
 * 这是分析管线的唯一入口，跑在 Worker 里。
 * 流程：逐帧特征 → 起音拾取 → 测速与网格 → 质量自检。
 */

import type { AnalysisDiagnostics, AnalysisQuality, OnsetEvent, TrackAnalysis } from '../types'
import { computeFrameFeatures } from './stft'
import { detectOnsets, type OnsetPickOptions } from './onset'
import { estimateTempo } from './tempo'
import { createGrid, medianResidualMs } from '../chartgen/grid'

/**
 * 分析档位 —— 移动端性能崩了时的救命开关。
 *
 * hop 越小时间分辨率越高（越准），但计算量成反比增长。
 * `demo` 档只分析前 90 秒，现场设备弱时能保证演示不卡住。
 */
export type AnalysisProfile = 'fast' | 'balanced' | 'precise' | 'demo'

export interface ProfileSettings {
  frameSize: number
  hopSize: number
  /** 只分析前 N 秒。undefined = 全曲。 */
  maxSeconds?: number
}

export const PROFILES: Record<AnalysisProfile, ProfileSettings> = {
  fast: { frameSize: 1024, hopSize: 1024 },
  balanced: { frameSize: 2048, hopSize: 512 },
  precise: { frameSize: 4096, hopSize: 512 },
  demo: { frameSize: 2048, hopSize: 512, maxSeconds: 90 },
}

export interface AnalyzeOptions {
  fs: number
  fingerprint: string
  profile?: AnalysisProfile
  onset?: OnsetPickOptions
  onProgress?: (stage: string, ratio: number) => void
}

/** 采样率过高时没必要按原始采样率做 FFT —— 降到 22050 即可，能省一半计算量。 */
const ANALYSIS_SAMPLE_RATE_TARGET = 22050

function decimate(mono: Float32Array, fs: number): { data: Float32Array; fs: number } {
  if (fs <= ANALYSIS_SAMPLE_RATE_TARGET) return { data: mono, fs }
  // 简单的整数倍抽取。不做抗混叠滤波——对起音检测（宽带瞬态）影响可忽略，
  // 因为谱通量关心的是"有东西突然出现"，高频镜像不会制造假的起音。
  const factor = Math.max(2, Math.round(fs / ANALYSIS_SAMPLE_RATE_TARGET))
  const outLen = Math.floor(mono.length / factor)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) out[i] = mono[i * factor]
  return { data: out, fs: fs / factor }
}

export function analyzeMono(
  monoInput: Float32Array,
  opts: AnalyzeOptions,
): TrackAnalysis {
  const profile = PROFILES[opts.profile ?? 'balanced']
  const progress = opts.onProgress ?? (() => {})

  // 只分析前 N 秒（demo 档）
  let mono = monoInput
  if (profile.maxSeconds) {
    const n = Math.min(mono.length, Math.floor(profile.maxSeconds * opts.fs))
    mono = mono.subarray(0, n)
  }

  const { data, fs } = decimate(mono, opts.fs)
  const durationMs = (mono.length / opts.fs) * 1000

  progress('提取逐帧特征', 0.1)
  const features = computeFrameFeatures(data, {
    fs,
    frameSize: profile.frameSize,
    hopSize: profile.hopSize,
  })

  if (features.nFrames === 0) {
    return emptyAnalysis(opts.fingerprint, durationMs, fs, '音频过短或完全静音，无法分析')
  }

  progress('拾取起音', 0.55)
  const onsets = detectOnsets(features, opts.onset)

  if (onsets.length === 0) {
    return emptyAnalysis(opts.fingerprint, durationMs, fs, '没有检测到任何起音，可能是纯人声或极安静的片段')
  }

  return finalizeAnalysis(opts, data, fs, durationMs, onsets, profile, progress)
}

/**
 * 从"已确定的起音"往下走完测速 + 质量自检 + 组装 TrackAnalysis。
 *
 * 抽出这一步是为了让旋律分析（起音来自 basic-pitch 而非 spectral-flux）
 * 复用同一套测速与质量逻辑——起音来源不同，但测速/网格/自检完全相同。
 */
function finalizeAnalysis(
  opts: AnalyzeOptions,
  data: Float32Array,
  fs: number,
  durationMs: number,
  onsets: OnsetEvent[],
  profile: ProfileSettings,
  progress: (stage: string, ratio: number) => void,
): TrackAnalysis {
  progress('估算速度与网格', 0.8)
  const tempo = estimateTempo(data, onsets, {
    fs,
    frameSize: profile.frameSize,
    hopSize: profile.hopSize,
  })

  progress('质量自检', 0.95)

  // 容差取格距的 35%，但不超过 45ms —— 双上限避免在密网格下过于宽松
  const toleranceSec = Math.min(tempo.grid.gridStepSec * 0.35, 0.045)
  let within = 0
  for (const o of onsets) {
    const d = Math.abs(o.time - tempo.grid.stepTime(tempo.grid.nearestStep(o.time)))
    if (d <= toleranceSec) within++
  }
  const withinRatio = within / onsets.length
  const residualMs = medianResidualMs(tempo.grid, onsets)

  const quality: AnalysisQuality =
    tempo.fallbackLevel >= 3 ? 'manual' : tempo.fallbackLevel >= 1 ? 'degraded' : 'good'

  const diagnostics: AnalysisDiagnostics = {
    medianResidualMs: residualMs,
    withinToleranceRatio: withinRatio,
    quality,
    fallbackLevel: tempo.fallbackLevel,
    notes: [
      ...tempo.notes,
      `起音 ${onsets.length} 个，残差中位数 ${residualMs.toFixed(1)}ms，容差内占比 ${(withinRatio * 100).toFixed(1)}%`,
    ],
  }

  progress('完成', 1)

  return {
    fingerprint: opts.fingerprint,
    durationMs,
    sampleRate: fs,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    beats: tempo.beats,
    gridOffsetSec: tempo.gridOffsetSec,
    subdivision: tempo.grid.subdivision,
    onsets,
    diagnostics,
  }
}

/**
 * 从外部给定的起音（旋律音符）组装 TrackAnalysis —— 旋律分析管线入口。
 *
 * 与 analyzeMono 的差别只在起音来源：这里跳过 STFT + spectral-flux 拾取，
 * 直接拿 basic-pitch 产出的旋律音符当起音，然后走同一套测速与质量自检。
 */
export function analyzeFromOnsets(
  monoInput: Float32Array,
  opts: AnalyzeOptions,
  onsets: OnsetEvent[],
): TrackAnalysis {
  const profile = PROFILES[opts.profile ?? 'balanced']
  const progress = opts.onProgress ?? (() => {})

  let mono = monoInput
  if (profile.maxSeconds) {
    const n = Math.min(mono.length, Math.floor(profile.maxSeconds * opts.fs))
    mono = mono.subarray(0, n)
  }

  const { data, fs } = decimate(mono, opts.fs)
  const durationMs = (mono.length / opts.fs) * 1000

  if (onsets.length === 0) {
    return emptyAnalysis(opts.fingerprint, durationMs, fs, '旋律分析未检测到任何音符')
  }

  return finalizeAnalysis(opts, data, fs, durationMs, onsets, profile, progress)
}

function emptyAnalysis(
  fingerprint: string,
  durationMs: number,
  sampleRate: number,
  reason: string,
): TrackAnalysis {
  return {
    fingerprint,
    durationMs,
    sampleRate,
    bpm: 0,
    bpmConfidence: 0,
    beats: [],
    gridOffsetSec: 0,
    subdivision: 1,
    onsets: [],
    diagnostics: {
      medianResidualMs: Infinity,
      withinToleranceRatio: 0,
      quality: 'manual',
      fallbackLevel: 3,
      notes: [reason],
    },
  }
}

/** 供调试页使用：用任意 {bpm, offset} 重建网格，无需重新分析。 */
export function rebuildGrid(bpm: number, offsetSec: number, subdivision: 1 | 2 | 3 | 4) {
  return createGrid(bpm, offsetSec, subdivision)
}
