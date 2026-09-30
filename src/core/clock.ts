/**
 * 游戏主时钟 —— 整个项目最容易出错、也最不能出错的地方。
 *
 * 铁律：**唯一主时钟是 `AudioContext.currentTime`**。
 * 绝不用 `performance.now()` 或 rAF 时间戳做判定基准——rAF 有抖动（±4ms，
 * 掉帧时更多），拿它判分会毁掉判定的公平性：同样的手感，帧率高的设备拿高分。
 *
 * 三层时间坐标：
 *   ctxTime   音频硬件时钟（秒，单调递增，由 currentTime 提供）
 *   songTime  玩家此刻"听到"的歌曲位置（秒）—— 判定就用它
 *   sharedTime 联机时的共享时间轴（见 net/sync.ts）
 */

export interface ClockConfig {
  ctx: AudioContext
  /** 歌曲总时长（秒）。 */
  durationSec: number
  /** 用户校准偏置（秒）。正数表示判定线延迟到达，即玩家偏慢。 */
  userOffsetSec?: number
}

export class GameClock {
  readonly ctx: AudioContext
  readonly durationSec: number

  /** 计划开始播放的 ctx 时间。`currentTime` 达到它时歌曲位置为 0。 */
  private startCtxTime = 0
  /** 输出延迟补偿（秒）。 */
  private outputLatencySec = 0
  /** 用户校准偏置（秒）。 */
  private userOffsetSec: number
  /** 联机漂移补偿（秒），由 net 层设置。 */
  private battleDriftSec = 0
  /** 暂停时的歌曲位置；未暂停为 null。 */
  private pausedAtSongTime: number | null = null

  private source: AudioBufferSourceNode | null = null
  private started = false

  constructor(config: ClockConfig) {
    this.ctx = config.ctx
    this.durationSec = config.durationSec
    this.userOffsetSec = config.userOffsetSec ?? 0
    this.measureLatency()
  }

  /**
   * 采样输出延迟。
   *
   * `outputLatency` 是"从 AudioContext 到扬声器"的延迟，正是需要补偿的量。
   * 但 Safari 和部分 Firefox 没实现它，必须回落到 `baseLatency`
   * （后者只覆盖音频图的缓冲，偏小，剩余误差交给用户校准吸收）。
   */
  measureLatency(): void {
    const ctx = this.ctx as AudioContext & {
      outputLatency?: number
      baseLatency?: number
    }
    this.outputLatencySec = ctx.outputLatency ?? ctx.baseLatency ?? 0
  }

  get latencySec(): number {
    return this.outputLatencySec
  }

  get userOffset(): number {
    return this.userOffsetSec
  }

  setUserOffset(sec: number): void {
    this.userOffsetSec = sec
  }

  setBattleDrift(sec: number): void {
    this.battleDriftSec = sec
  }

  /**
   * 调度播放。
   *
   * `leadSec` 是留给音频图就绪的提前量——立刻 start 会丢开头一小段。
   * 联机时传入更大的提前量（如 3 秒），让双方都有时间准备好。
   */
  start(buffer: AudioBuffer, leadSec = 0.1, loop = false): void {
    if (this.started) return

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = loop

    this.startCtxTime = this.ctx.currentTime + leadSec
    src.start(this.startCtxTime)
    src.connect(this.ctx.destination)

    this.source = src
    this.started = true
  }

  /**
   * 玩家此刻"听到"的歌曲位置（秒）。
   *
   * `currentTime - outputLatency` 是"此刻正从扬声器发出的那个采样"
   * 在音频图里的处理时刻——这是输出延迟补偿的正确形式。
   */
  songTime(): number {
    if (!this.started) return -this.startCtxTime + this.ctx.currentTime
    if (this.pausedAtSongTime !== null) return this.pausedAtSongTime
    return (
      this.ctx.currentTime - this.outputLatencySec - this.startCtxTime + this.userOffsetSec
    )
  }

  /** 联机共享时间轴上的歌曲位置。 */
  sharedSongTime(): number {
    return this.songTime() + this.battleDriftSec
  }

  /**
   * 把服务器时间轴上的绝对时刻换算成本地 ctx 时间。
   *
   * 联机开局的正确性全靠这个换算：双方各自把同一个"服务器绝对时间"
   * 映射到本地音频时钟，才能保证同一小节同时到达判定线。
   *
   * @param serverMs 服务器时间戳（毫秒）
   * @param toLocalMs 服务器时间 → 本地 monotonic 时间的换算函数（来自 net/sync）
   */
  serverTimeToCtxTime(serverMs: number, toLocalMs: (serverMs: number) => number): number {
    const localMs = toLocalMs(serverMs)
    const nowLocalMs = performance.timeOrigin + performance.now()
    return this.ctx.currentTime + (localMs - nowLocalMs) / 1000
  }

  /** 是否已经播放到结尾。 */
  finished(): boolean {
    return this.songTime() > this.durationSec
  }

  pause(): void {
    if (this.pausedAtSongTime !== null) return
    this.pausedAtSongTime = this.songTime()
    this.ctx.suspend()
  }

  async resume(): Promise<void> {
    if (this.pausedAtSongTime === null) return
    // 恢复时把起点整体后移，使 songTime 与暂停时连续
    const pausedSong = this.pausedAtSongTime
    await this.ctx.resume()
    this.startCtxTime = this.ctx.currentTime - this.outputLatencySec - pausedSong + this.userOffsetSec
    this.pausedAtSongTime = null
  }

  get isPaused(): boolean {
    return this.pausedAtSongTime !== null
  }

  destroy(): void {
    try {
      this.source?.stop()
    } catch {
      // 已经停止过，忽略
    }
    this.source?.disconnect()
    this.source = null
    this.started = false
  }
}

/**
 * 读一次「音频硬件时钟」与「墙上时钟」的对应关系，用于诊断。
 *
 * 不参与判定计算——各浏览器对 `getOutputTimestamp` 的实现一致性没有保证，
 * 所以它只用来在调试页显示"估算延迟是否合理"。
 */
export function diagnoseLatency(ctx: AudioContext): {
  baseLatency: number
  outputLatency: number | null
  driftMs: number | null
} {
  const c = ctx as AudioContext & { outputLatency?: number }
  const ts = ctx.getOutputTimestamp?.()
  let driftMs: number | null = null
  if (ts && ts.contextTime != null && ts.performanceTime != null) {
    const ctxNow = ctx.currentTime
    const perfNowSec = (performance.timeOrigin + performance.now() - ts.performanceTime) / 1000
    const estimated = perfNowSec - (ctxNow - ts.contextTime)
    driftMs = estimated * 1000
  }
  return {
    baseLatency: ctx.baseLatency ?? 0,
    outputLatency: c.outputLatency ?? null,
    driftMs,
  }
}
