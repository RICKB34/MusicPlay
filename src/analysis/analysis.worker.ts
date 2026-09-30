/// <reference lib="webworker" />
/**
 * 分析 Worker —— 全曲离线分析跑在这里，避免阻塞主线程。
 *
 * 4 分钟的歌在桌面上约 2-4 秒（低端安卓 8-15 秒），期间主线程必须保持
 * 可交互以显示进度条，所以分析不能在主线程做。
 */

import { analyzeMono, analyzeFromOnsets, type AnalysisProfile } from './analyzeTrack'
import type { OnsetPickOptions } from './onset'
import type { OnsetEvent, TrackAnalysis } from '../types'

export interface AnalyzeRequest {
  /** 单声道采样，由主线程 transfer 过来（零拷贝）。 */
  mono: Float32Array
  fs: number
  fingerprint: string
  profile?: AnalysisProfile
  onset?: OnsetPickOptions
  /** 外部给定的起音（旋律分析）。提供时跳过 spectral-flux 拾取。 */
  onsets?: OnsetEvent[]
}

export type AnalyzeResponse =
  | { type: 'progress'; stage: string; ratio: number }
  | { type: 'done'; analysis: TrackAnalysis }
  | { type: 'error'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { mono, fs, fingerprint, profile, onset, onsets } = e.data

  try {
    const onProgress = (stage: string, ratio: number) => {
      const msg: AnalyzeResponse = { type: 'progress', stage, ratio }
      ctx.postMessage(msg)
    }
    const base = { fs, fingerprint, profile, onProgress }

    const analysis = onsets
      ? analyzeFromOnsets(mono, base, onsets)
      : analyzeMono(mono, { ...base, onset })

    const msg: AnalyzeResponse = { type: 'done', analysis }
    ctx.postMessage(msg)
  } catch (err) {
    const msg: AnalyzeResponse = {
      type: 'error',
      message: (err as Error)?.message ?? String(err),
    }
    ctx.postMessage(msg)
  }
}
