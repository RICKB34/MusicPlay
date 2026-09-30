/**
 * 第三方库的类型补充。
 *
 * 两个库都有各自的类型问题，这个文件一次性解决：
 *
 * 1. `fourier-transform` 完全没有发布类型定义。
 * 2. `@audio/beat-detect` 有 `index.d.ts`，但它的 `exports` map 指向 `./detect.js`，
 *    TypeScript 会去找 `detect.d.ts` 而找不到（报 TS7016）。
 *
 * 这里的签名是**直接读源码核对过的**，不是猜的。
 */

declare module 'fourier-transform' {
  /**
   * 实数输入的幅度谱。
   *
   * ⚠️ `output` 省略时返回的是**内部复用的 view**，下次同尺寸调用会被覆写。
   * 调用方若需要保留结果，必须传入自己的 `output` 缓冲区。
   *
   * @param input 长度必须是 2 的幂
   * @param output 可选，长度 N/2
   * @returns 幅度谱，长度 N/2（不含 Nyquist bin）
   */
  export default function rfft(input: ArrayLike<number>, output?: Float64Array): Float64Array

  /** 复数谱（未归一化）。返回 [re, im]，各 N/2+1 个 bin。 */
  export function fft(
    input: ArrayLike<number>,
    output?: [Float64Array, Float64Array],
  ): [Float64Array, Float64Array]

  /** 原地复数正变换。长度必须是 2 的幂。 */
  export function cfft(re: Float64Array, im: Float64Array): void

  /** 原地复数逆变换（1/N 归一化）。 */
  export function cifft(re: Float64Array, im: Float64Array): void

  /** 实数逆变换。re/im 各 N/2+1 个 bin，返回长度 N 的时域信号。 */
  export function ifft(re: Float64Array, im: Float64Array, output?: Float64Array): Float64Array
}

declare module '@audio/beat-detect' {
  export interface DetectOptions {
    /** 采样率，默认 44100 */
    fs?: number
    /** STFT 帧长，默认 2048 */
    frameSize?: number
    /** STFT 跳距，默认 512 */
    hopSize?: number
    /** 起音峰值阈值倍数，默认 1.4 */
    delta?: number
    /** 最小 BPM，默认 60 */
    minBpm?: number
    /** 最大 BPM，默认 200 */
    maxBpm?: number
  }

  export interface DetectResult {
    bpm: number
    /** 测速置信度 [0,1] */
    confidence: number
    /** 相位对齐的拍点时刻（秒） */
    beats: Float64Array
    /** 检测到的起音时刻（秒） */
    onsets: Float64Array
  }

  /**
   * 谱通量起音 → 梳状滤波测速 → 相位对齐拍点网格。
   * 三个阶段共用同一次 STFT 遍历。
   */
  export default function detect(
    data: Float32Array | Float64Array,
    opts?: DetectOptions,
  ): DetectResult
}
