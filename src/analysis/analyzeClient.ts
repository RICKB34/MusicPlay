/**
 * 分析 Worker 的主线程客户端。
 *
 * 把 Worker 的 postMessage 协议包装成 Promise，并提供进度回调。
 * 每次分析起一个独立 Worker，用完即弃——避免 Worker 里残留的
 * 大数组（几十 MB 的 Float64Array）长期占内存。
 */

import type { AnalysisProfile } from './analyzeTrack'
import type { OnsetPickOptions } from './onset'
import type { AnalyzeRequest, AnalyzeResponse } from './analysis.worker'
import type { OnsetEvent, TrackAnalysis } from '../types'

export interface RunAnalysisOptions {
  fs: number
  fingerprint: string
  profile?: AnalysisProfile
  onset?: OnsetPickOptions
  /** 外部给定起音（旋律分析）。提供时跳过 spectral-flux 拾取。 */
  onsets?: OnsetEvent[]
  onProgress?: (stage: string, ratio: number) => void
}

export function runAnalysis(
  mono: Float32Array,
  opts: RunAnalysisOptions,
): Promise<TrackAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
      type: 'module',
    })

    const cleanup = () => worker.terminate()

    worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'progress':
          opts.onProgress?.(msg.stage, msg.ratio)
          break
        case 'done':
          cleanup()
          resolve(msg.analysis)
          break
        case 'error':
          cleanup()
          reject(new Error(msg.message))
          break
      }
    }

    worker.onerror = (e) => {
      cleanup()
      reject(new Error(`分析 Worker 崩溃：${e.message || '未知错误'}`))
    }

    // 转移 mono 的所有权给 Worker，避免拷贝几十 MB 的数据。
    // 注意：转移后主线程的 mono 会变成 detached，不可再用。
    // 调用方若还需要原始数据，应自行保留副本。
    const req: AnalyzeRequest = {
      mono,
      fs: opts.fs,
      fingerprint: opts.fingerprint,
      profile: opts.profile,
      onset: opts.onset,
      onsets: opts.onsets,
    }
    worker.postMessage(req, [mono.buffer])
  })
}
