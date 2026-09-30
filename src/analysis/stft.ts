/**
 * 特征提取 —— 单次 STFT 遍历，同时算出谱面生成需要的全部逐帧特征。
 *
 * 为什么要自己写这一遍而不是直接用 `@audio/onset` 的 `spectralFlux`：
 * 那个函数只返回 ODF，而轨道分配还需要**谱质心**和**三频段能量**。
 * 多跑一遍 STFT 要 1.5-3 秒（4 分钟的歌），所以合成一遍算完。
 *
 * ⚠️ `fourier-transform` 的 `rfft(input)` 省略第二个参数时返回的是**内部复用的 view**，
 * 下次同尺寸调用会被覆写。本文件全程传入自己的 `magBuf`，绝不保留库返回的引用。
 */

import rfft from 'fourier-transform'

export interface FrameFeatureOptions {
  fs: number
  /** FFT 帧长，2 的幂。默认 2048。 */
  frameSize?: number
  /** 帧间跳距。默认 512。 */
  hopSize?: number
}

export interface FrameFeatures {
  nFrames: number
  hopSize: number
  frameSize: number
  fs: number
  /** 逐帧谱通量（spectral flux）：相邻帧幅度谱正向差分之和。 */
  odf: Float64Array
  /** 逐帧谱质心（Hz）。感知上的"音色明暗"，轨道分配的核心依据。 */
  centroid: Float64Array
  /** 逐帧低频段（20–250Hz）能量占比 [0,1]。底鼓。 */
  lowRatio: Float64Array
  /** 逐帧中频段（250–2000Hz）能量占比 [0,1]。 */
  midRatio: Float64Array
  /** 逐帧高频段（2000–8000Hz）能量占比 [0,1]。镲片。 */
  highRatio: Float64Array
  /** 逐帧 RMS 能量。用于长按（hold）识别。 */
  rms: Float64Array
}

/** 频段划分（Hz）。三分法是音游谱面里最实用的粗粒度音色区分。 */
export const BAND_LOW = [20, 250] as const
export const BAND_MID = [250, 2000] as const
export const BAND_HIGH = [2000, 8000] as const

/** 用帧索引换算帧中心在原始信号中的时刻（秒）。 */
export function frameTime(frameIndex: number, hopSize: number, frameSize: number, fs: number): number {
  return (frameIndex * hopSize + frameSize / 2) / fs
}

export function computeFrameFeatures(
  data: Float32Array | Float64Array,
  opts: FrameFeatureOptions,
): FrameFeatures {
  const fs = opts.fs
  const frameSize = opts.frameSize ?? 2048
  const hopSize = opts.hopSize ?? 512

  const nFrames = Math.floor((data.length - frameSize) / hopSize) + 1
  const empty = (): FrameFeatures => ({
    nFrames: 0,
    hopSize,
    frameSize,
    fs,
    odf: new Float64Array(0),
    centroid: new Float64Array(0),
    lowRatio: new Float64Array(0),
    midRatio: new Float64Array(0),
    highRatio: new Float64Array(0),
    rms: new Float64Array(0),
  })
  if (nFrames < 2) return empty()

  // Hann 窗，自建以避免依赖 @audio/onset 的传递依赖 window-function
  const win = new Float64Array(frameSize)
  for (let i = 0; i < frameSize; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frameSize))

  const frame = new Float64Array(frameSize)
  // rfft 的输出长度是 frameSize/2（不含 Nyquist bin）
  const magBuf = new Float64Array(frameSize / 2)
  const prevMag = new Float64Array(frameSize / 2)

  const odf = new Float64Array(nFrames)
  const centroid = new Float64Array(nFrames)
  const lowRatio = new Float64Array(nFrames)
  const midRatio = new Float64Array(nFrames)
  const highRatio = new Float64Array(nFrames)
  const rms = new Float64Array(nFrames)

  const half = frameSize / 2
  const binHz = fs / frameSize
  // 频段对应的 bin 下标区间（含头不含尾）
  const kLow0 = Math.max(1, Math.floor(BAND_LOW[0] / binHz))
  const kLow1 = Math.min(half, Math.ceil(BAND_LOW[1] / binHz))
  const kMid1 = Math.min(half, Math.ceil(BAND_MID[1] / binHz))
  const kHigh1 = Math.min(half, Math.ceil(BAND_HIGH[1] / binHz))

  for (let f = 0; f < nFrames; f++) {
    const offset = f * hopSize

    let sumSq = 0
    for (let i = 0; i < frameSize; i++) {
      const s = data[offset + i] ?? 0
      sumSq += s * s
      frame[i] = s * win[i]
    }
    rms[f] = Math.sqrt(sumSq / frameSize)

    // 传入自己的缓冲区 —— 绝不使用库返回的内部复用 view
    const mag = rfft(frame, magBuf)

    // ── 谱通量：只累加正向增量，这是起音的本质 ──
    let flux = 0
    if (f > 0) {
      for (let k = 0; k < half; k++) {
        const d = mag[k] - prevMag[k]
        if (d > 0) flux += d
      }
    }
    odf[f] = flux

    // ── 谱质心 + 频段能量，同一遍循环算完 ──
    let magSum = 0
    let weighted = 0
    let eLow = 0
    let eMid = 0
    let eHigh = 0

    for (let k = 1; k < half; k++) {
      const m = mag[k]
      magSum += m
      weighted += m * k * binHz
      const e = m * m
      if (k < kLow0) continue
      if (k < kLow1) eLow += e
      else if (k < kMid1) eMid += e
      else if (k < kHigh1) eHigh += e
    }

    centroid[f] = magSum > 1e-12 ? weighted / magSum : 0

    const eTotal = eLow + eMid + eHigh
    if (eTotal > 1e-12) {
      lowRatio[f] = eLow / eTotal
      midRatio[f] = eMid / eTotal
      highRatio[f] = eHigh / eTotal
    }

    prevMag.set(mag)
  }

  return { nFrames, hopSize, frameSize, fs, odf, centroid, lowRatio, midRatio, highRatio, rms }
}
