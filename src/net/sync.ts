/**
 * NTP 式时钟同步。
 *
 * 目标：让两个玩家的本地时钟能换算到同一条"服务器时间轴"上，
 * 从而把服务器下发的同一个绝对时刻 `startAtServerMs` 映射成各自的
 * 本地播放起点，保证同一小节同时到达判定线。
 *
 * 标准四时间戳握手：
 *
 *   客户端                          服务端
 *     t0 ──── PING ────────────────→ t1
 *     t3 ←─── PONG ───────────────── t2
 *
 *   RTT    = (t3 − t0) − (t2 − t1)      扣掉服务端处理耗时
 *   offset = ((t1 − t0) + (t2 − t3)) / 2
 *
 * **取 RTT 最小的那一次样本，而不是中位数或均值**——这是 NTP 的标准做法：
 * 往返延迟最小的那次，路径最对称，时钟偏差估计的误差下界也最小。
 */

/** 本地单调时钟（毫秒）。不用 Date.now()——它会因系统对时而跳变。 */
export function localNowMs(): number {
  return performance.timeOrigin + performance.now()
}

export interface SyncSample {
  rtt: number
  offset: number
}

export class ClockSync {
  private samples: SyncSample[] = []
  private cidCounter = 0
  private pending = new Map<number, number>()

  /** 保留的样本数上限。取最小的 RTT，样本多了没用。 */
  private readonly maxSamples = 8

  get sampleCount(): number {
    return this.samples.length
  }

  get ready(): boolean {
    return this.samples.length >= 3
  }

  get bestRtt(): number {
    return this.samples.reduce((m, s) => Math.min(m, s.rtt), Infinity)
  }

  /** 当前采用的时钟偏差（毫秒）。服务端时间 = 本地时间 + offset。 */
  get offset(): number {
    let best = this.samples[0]
    for (const s of this.samples) if (s.rtt < best.rtt) best = s
    return best?.offset ?? 0
  }

  /** 构造一次 PING。返回消息与对应的 cid。 */
  nextPing(): { cid: number; t0: number } {
    const cid = ++this.cidCounter
    const t0 = localNowMs()
    this.pending.set(cid, t0)
    return { cid, t0 }
  }

  /** 处理 PONG。 */
  onPong(cid: number, t0: number, t1: number, t2: number): void {
    const t3 = localNowMs()
    // 服务端处理耗时（通常 <1ms，但网络抖动时可能不小）要从 RTT 里扣掉
    const rtt = t3 - t0 - (t2 - t1)
    const offset = (t1 - t0 + (t2 - t3)) / 2

    if (!Number.isFinite(rtt) || !Number.isFinite(offset)) return
    // 负 RTT 在物理上不可能，说明有时钟异常，丢弃
    if (rtt < 0) return

    this.samples.push({ rtt, offset })
    if (this.samples.length > this.maxSamples) this.samples.shift()
    this.pending.delete(cid)
  }

  /** 本地时间 → 服务器时间。 */
  toServer(localMs: number): number {
    return localMs + this.offset
  }

  /** 服务器时间 → 本地时间。 */
  toClient(serverMs: number): number {
    return serverMs - this.offset
  }

  reset(): void {
    this.samples = []
    this.pending.clear()
  }
}

/**
 * 判断是否需要校正播放漂移。
 *
 * 两个浏览器各自跑 AudioBufferSourceNode，速度由各自的音频硬件晶振决定，
 * 典型偏差 ±50ppm = 50µs/秒。一首 4 分钟的歌累计漂移仅约 12ms，
 * **远小于判定窗，所以正常情况下不需要任何漂移校正**。
 *
 * 这个函数存在的意义是应对异常情况（比如某台设备严重掉帧导致
 * 调度延迟、或音频被系统重采样）。阈值取 30ms——低于它校正反而
 * 会引入可听见的音高变化（改 playbackRate）或跳音。
 */
export const DRIFT_CORRECTION_THRESHOLD_MS = 30

export function needsDriftCorrection(
  localSongTimeSec: number,
  expectedSongTimeSec: number,
): boolean {
  return Math.abs(localSongTimeSec - expectedSongTimeSec) * 1000 > DRIFT_CORRECTION_THRESHOLD_MS
}
