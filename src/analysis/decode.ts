/**
 * 解码 —— File → AudioBuffer（供播放）+ 单声道 Float32Array（供分析）。
 *
 * 解码跑在主线程（`decodeAudioData` 的实际工作在浏览器内部线程，不阻塞 JS），
 * 然后把单声道副本**转移**（零拷贝）给 Worker 做分析。
 * AudioBuffer 本身不可转移，留在主线程给播放用。
 */

import type { AudioSource } from '../types'

export interface DecodedAudio {
  /** 供播放使用，必须留在主线程。 */
  buffer: AudioBuffer
  /** 单声道副本，分析用。可直接 transfer 给 Worker。 */
  mono: Float32Array
  sampleRate: number
  durationMs: number
  fingerprint: string
}

/**
 * 计算音频指纹 —— 用于联机时校验双方加载的是不是同一个文件。
 *
 * 不追求密码学强度，只需要"同一个文件必然同指纹、不同文件极大概率不同"。
 * 采样而非全量：全量哈希要遍历上千万个样本，没必要。
 */
function fingerprintOf(mono: Float32Array, sampleRate: number, channels: number): string {
  // FNV-1a，对量化后的采样值做哈希
  let h = 0x811c9dc5
  const stride = Math.max(1, Math.floor(mono.length / 20000)) // 约 2 万个采样点
  for (let i = 0; i < mono.length; i += stride) {
    // 量化到 1/1000，避免浮点末位差异导致同一文件算出不同指纹
    const q = Math.round((mono[i] ?? 0) * 1000)
    h ^= q & 0xff
    h = Math.imul(h, 0x01000193)
    h ^= (q >> 8) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  const head = (h >>> 0).toString(36)
  return `${mono.length}-${sampleRate}-${channels}-${head}`
}

/** 把多声道降混为单声道（各声道求和后取平均）。 */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length
  const ch = buffer.numberOfChannels
  const out = new Float32Array(n)

  if (ch === 1) {
    out.set(buffer.getChannelData(0))
    return out
  }

  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += data[i]
  }
  const inv = 1 / ch
  for (let i = 0; i < n; i++) out[i] *= inv
  return out
}

export async function decodeArrayBuffer(
  arrayBuffer: ArrayBuffer,
  ctx: BaseAudioContext,
): Promise<DecodedAudio> {
  const buffer = await ctx.decodeAudioData(arrayBuffer)
  const mono = downmixToMono(buffer)
  return {
    buffer,
    mono,
    sampleRate: buffer.sampleRate,
    durationMs: buffer.duration * 1000,
    fingerprint: fingerprintOf(mono, buffer.sampleRate, buffer.numberOfChannels),
  }
}

/** 本地文件音频源 —— 当前唯一实现。 */
export class FileAudioSource implements AudioSource {
  readonly kind = 'file'

  constructor(private readonly file: File) {}

  async load(ctx: BaseAudioContext): Promise<AudioBuffer> {
    const buf = await this.file.arrayBuffer()
    return ctx.decodeAudioData(buf)
  }

  async fingerprint(): Promise<string> {
    // 轻量指纹：文件名 + 大小 + 最后修改时间，不需要解码
    return `${this.file.name}:${this.file.size}:${this.file.lastModified}`
  }
}

/**
 * 解码失败的常见原因提示。
 *
 * Safari 对 flac / ogg 的支持不保证，用户拿这两个格式来会直接抛 EncodingError，
 * 需要给出可操作的建议而不是一句"解码失败"。
 */
export function describeDecodeError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'EncodingError') {
    return '无法解码这个音频格式。浏览器对 FLAC / OGG 的支持不一致，请转成 MP3 或 WAV 后重试。'
  }
  if (name === 'NotSupportedError') {
    return '浏览器不支持这个音频格式，请转成 MP3 或 WAV 后重试。'
  }
  return `音频解码失败：${(err as Error)?.message ?? String(err)}`
}
