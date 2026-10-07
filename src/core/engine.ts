/**
 * 游戏主类 —— 纯 TypeScript class，**零 React 依赖**。
 *
 * 这是刻意的架构约束：游戏主循环跑到 60fps，如果状态走 React 的 setState，
 * 每次更新都要 diff + 重渲染，掉帧是必然的。所以 React 只负责
 * 「创建它 / 销毁它」，游戏内的 HUD 直接画在 canvas 上。
 *
 * 唯一向上报告的是低频事件（结算、节流的分数快照），这些走回调给 React。
 */

import type { Chart, DrumHit, Judgment, ScoreSnapshot } from '../types'
import { DEFAULT_JUDGMENT, type JudgmentConfig } from '../types'
import { GameClock } from './clock'
import { Judger, Scorer, gradeOf, type ScoreState } from './judge'
import { InputManager } from './input'
import {
  CanvasRenderer,
  QQ_THEME,
  hitEffectLifeSec,
  type HitEffect,
  type RenderTheme,
} from './render'

export interface GameResult {
  score: number
  maxCombo: number
  accuracy: number
  grade: string
  counts: Record<Judgment, number>
  totalNotes: number
}

export interface EngineOptions {
  canvas: HTMLCanvasElement
  chart: Chart
  audioBuffer: AudioBuffer
  ctx: AudioContext
  /** 音符从出现到抵达判定线的时长（秒）。越小越难。默认 0.9。 */
  approachSec?: number
  /** 用户校准偏置（秒）。 */
  userOffsetSec?: number
  /** 开播前的提前量（秒）。联机时用更大的值。 */
  leadSec?: number
  judgment?: JudgmentConfig
  /**
   * 画布调色板。不传则用 QQ 音乐主题——与 `:root` 的默认主题保持一致。
   * 主题只在构造时读一次，游戏中不切换。
   */
  theme?: RenderTheme
  /** 显示判定偏差数值（调试用）。 */
  showDelta?: boolean
  /** 每轨的 KeyboardEvent.code，顺序与 chart.columns 一致。 */
  keyBindings?: readonly string[]
  /**
   * 鼓点序列（秒 + 强度），从原曲起音中筛出，见 `analysis/drumHit.ts`。
   *
   * 不传或传空数组 = 没有鼓点反馈。
   * 它**只驱动震动与边框光晕**，与判定、计分、轨道分配完全无关：
   * 玩家漏掉音符不会少一次震动，因为节拍感来自音乐而不是操作。
   */
  drumHits?: readonly DrumHit[]
  /**
   * 每帧输出边框光晕的强度 [0,1]，供 GameScreen 写到 DOM 上。
   *
   * 走回调而不是让引擎直接摸 DOM，是为了保住"引擎零 React 依赖"这条约束；
   * 而调用方**必须**用 ref 直接写 style、不能 setState——这是 60fps 的调用，
   * 进 React 就是每帧一次重渲染。
   */
  onGlow?: (intensity: number) => void
  onFinish?: (result: GameResult) => void
  /** 分数快照回调，**节流到 2Hz**，供联机上报与 React HUD 使用。 */
  onScore?: (snapshot: ScoreSnapshot) => void
  onReady?: () => void
}

/** 分数快照的节流间隔（毫秒）。2Hz 足够，联机也不需要更密。 */
const SCORE_THROTTLE_MS = 500

/**
 * ── 鼓点反馈的强度标定 ──
 *
 * 只保留边框光晕这一种反馈。
 *
 * 曾经还有两种：判定线上下抖动、以及手机马达的 `navigator.vibrate`。
 * 真机实测后都去掉了——抖动每一帧都在位移判定线，视觉上很"吵"，
 * 而且带来明显的卡顿感（它逼着画布每帧重绘一块本来静止的区域）；
 * 马达则在密集鼓点下变成持续嗡鸣，反而干扰手感。光晕是纯合成层的
 * opacity 变化，观感有节拍感而不打扰操作，留下它就够了。
 */

/**
 * 光晕能量每秒的衰减速率。
 *
 * 3.2/s 意味着一次满强度脉冲约 300ms 淡尽——比一次击打的余韵略长，
 * 让人能看清一次闪光，又不会糊到下一次鼓点上去。
 */
const GLOW_DECAY_PER_SEC = 3.2

/** 光晕脉冲的起始能量下限。最弱的鼓点也要看得见，否则光晕会显得断断续续。 */
const GLOW_BASE = 0.35

/**
 * 把 [0,1] 的鼓点强度映射到 [GLOW_BASE, 1]，让最弱的鼓点也留下可见的一下。
 */
function pulseEnergy(strength: number): number {
  return GLOW_BASE + strength * (1 - GLOW_BASE)
}

/**
 * 判定线抖动的最大位移（CSS 像素）。
 *
 * 判定线只有 3px 粗，抖得太轻根本看不出在动；但它同时是玩家判断"什么时候
 * 该按"的参照，抖过头会让判定变得没把握。4px（约线宽的 1.3 倍）是这两端
 * 之间的平衡点。想要更强的打击感就调这里，别去调衰减速率。
 */
const JUDGE_SHAKE_MAX_PX = 4

/**
 * 抖动能量每秒的衰减速率。约 90ms 抖完。
 *
 * 比光晕（3.2/s）快得多是刻意的：光晕是"余晖"，拖长一点好看；抖动是"撞击"，
 * 拖长就变成判定线在飘，既不像打击感也影响读谱。
 */
const SHAKE_DECAY_PER_SEC = 11

export class RhythmGame {
  private readonly opts: EngineOptions
  private readonly clock: GameClock
  private readonly judger: Judger
  private readonly scorer: Scorer
  private readonly input: InputManager
  private readonly renderer: CanvasRenderer

  private rafId = 0
  private running = false
  private finished = false
  private effects: HitEffect[] = []
  private lastDeltaSec: number | null = null
  private lastScoreEmitMs = -Infinity
  private readonly startedAtMs: number

  // ── 鼓点反馈的状态 ──
  /**
   * 鼓点游标：下一个待触发的 `drumHits` 下标。
   *
   * 用游标而不是每帧二分查找——鼓点是单调递增的，一帧最多跨过几个，
   * 指针推进是 O(1) 摊还。回退只在时间倒流时发生，见 `advanceDrums`。
   */
  private drumCursor = 0
  /** 当前光晕能量 [0,1]，每帧朝 0 衰减。 */
  private glow = 0
  /** 上一帧的 `performance.now()`，用来算光晕衰减用的帧间隔。 */
  private lastFrameMs = 0

  constructor(opts: EngineOptions) {
    this.opts = opts
    this.startedAtMs = performance.timeOrigin + performance.now()

    this.clock = new GameClock({
      ctx: opts.ctx,
      durationSec: opts.audioBuffer.duration,
      userOffsetSec: opts.userOffsetSec ?? 0,
    })
    this.judger = new Judger(opts.chart, opts.judgment ?? DEFAULT_JUDGMENT)
    this.scorer = new Scorer(opts.chart.notes.length)
    this.renderer = new CanvasRenderer(opts.canvas, opts.chart.columns, opts.theme ?? QQ_THEME)

    this.input = new InputManager(opts.canvas, {
      columns: opts.chart.columns,
      keyBindings: opts.keyBindings,
      // 传入 getter 而非快照值：判定必须读到"按下那一刻"的时钟
      getSongTime: () => this.clock.songTime(),
      onLaneDown: (lane, t) => this.handleLaneDown(lane, t),
      // 长按的生命周期跨按下与松开两端，两个回调都要接
      onLaneUp: (lane, t) => this.handleLaneUp(lane, t),
    })

    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onEscape)
  }

  start(): void {
    if (this.running) return
    this.running = true
    // 首帧没有上一帧可比，置 0 让 advanceDrums 走"按一个 60fps 帧算"的分支，
    // 否则上一局的残留值会算出一个巨大的 dt，光晕一上来就被衰减干净
    this.lastFrameMs = 0
    // leadSec 给音频图留出就绪时间；立刻 start 会丢开头一小段
    this.clock.start(this.opts.audioBuffer, this.opts.leadSec ?? 0.35)
    this.opts.onReady?.()
    this.loop()
  }

  destroy(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.input.destroy()
    this.clock.destroy()
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onEscape)
  }

  async togglePause(): Promise<void> {
    if (this.finished) return
    if (this.clock.isPaused) await this.clock.resume()
    else this.clock.pause()
  }

  setUserOffset(sec: number): void {
    this.clock.setUserOffset(sec)
  }

  get scoreSnapshot(): ScoreSnapshot {
    const s = this.scorer.snapshot()
    return {
      score: s.score,
      combo: s.combo,
      maxCombo: s.maxCombo,
      accuracy: s.accuracy,
      progress: this.judger.total > 0 ? s.judged / this.judger.total : 0,
    }
  }

  /**
   * 按键处理 —— 在输入事件回调里**同步**执行，不排队到下一帧。
   *
   * 这是判定精度的关键：事件回调里读到的 `currentTime` 就是按下那一刻的
   * 音频时钟，误差 <1ms。若改成"事件入队、下一帧统一处理"，就会引入
   * 最多一帧（16ms）的抖动，远超 Perfect 判定窗（±25ms）的一半。
   */
  private handleLaneDown(lane: number, songTimeSec: number): void {
    if (!this.running || this.finished || this.clock.isPaused) return

    const event = this.judger.handleInput(lane, songTimeSec)
    if (!event) return

    // 长按头部只进入 holding；不出判定特效、不计分，防止"点一下就算命中"。
    // 尾部仍按住时由 settleHolds 结算，提前松手则由 handleLaneUp 判 miss。
    if (event.deferred) return

    this.scorer.apply(event.judgment)

    this.effects.push({
      lane,
      judgment: event.judgment,
      startSec: songTimeSec,
    })
    this.lastDeltaSec = this.opts.showDelta ? event.deltaSec : null
  }

  /** 松开 —— 长按的"提前松手"在这里结算。同样跑在事件回调里，不排队到下一帧。 */
  private handleLaneUp(lane: number, songTimeSec: number): void {
    if (!this.running || this.finished || this.clock.isPaused) return

    for (const event of this.judger.handleRelease(lane, songTimeSec)) {
      this.scorer.apply(event.judgment)
      this.effects.push({
        lane,
        judgment: event.judgment,
        startSec: songTimeSec,
      })
    }
  }

  /**
   * 推进鼓点游标并衰减光晕能量。每帧一次。
   *
   * 时间是**音频时钟**（`songTime`）而不是墙钟：鼓点是音频上的时刻，用
   * `performance.now()` 比对会让两者随暂停/漂移错开。节流那一步才用墙钟，
   * 因为节流要约束的是"马达多久没停了"，那是个物理量。
   */
  private advanceDrums(songTimeSec: number): void {
    const nowMs = performance.timeOrigin + performance.now()
    // 帧间隔供光晕衰减使用。首帧没有上一帧，按一个 60fps 帧算，
    // 免得 dt 取 0 让衰减卡住。
    const dtSec = this.lastFrameMs > 0 ? (nowMs - this.lastFrameMs) / 1000 : 1 / 60
    this.lastFrameMs = nowMs

    if (this.clock.isPaused) {
      // 暂停时把光晕收干净：遮罩上残留一圈亮边会显得像渲染没清掉
      if (this.glow !== 0) {
        this.glow = 0
        this.opts.onGlow?.(0)
      }
      return
    }

    const hits = this.opts.drumHits
    if (hits && this.drumCursor > 0 && hits[this.drumCursor - 1].t > songTimeSec + 0.5) {
      // 时间倒流了（重新开局、时钟被外部重设）。游标停在旧位置会让
      // 之后所有鼓点都被判成"已跨过"而静默丢失，必须重置。
      this.drumCursor = 0
      this.glow = 0
    }

    if (hits) {
      // 标签页被挂起后 rAF 会停，恢复时一帧可能跨过几十个鼓点。
      // 这里不做每帧上限：推进指针本身几乎无成本，而光晕是取 max 不是累加，
      // 不会因为一次跨很多而失控。
      while (this.drumCursor < hits.length && hits[this.drumCursor].t <= songTimeSec) {
        this.fireDrum(hits[this.drumCursor])
        this.drumCursor++
      }
    }

    this.glow = Math.max(0, this.glow - GLOW_DECAY_PER_SEC * dtSec)
    this.opts.onGlow?.(this.glow)
  }

  /** 触发一次鼓点反馈：只看边框光晕。 */
  private fireDrum(hit: DrumHit): void {
    // 取 max 而非累加：密集鼓点下累加会让光晕瞬间打满并一直停在那儿，
    // 反而看不出节拍。取 max 保证每一击都是独立的一次"闪"。
    this.glow = Math.max(this.glow, pulseEnergy(hit.strength))
  }

  private loop = (): void => {
    if (!this.running) return

    const songTime = this.clock.songTime()

    // 漏判扫描：每帧一次。帧间隔（≤16ms）远小于判定窗（90ms），不会漏。
    if (!this.clock.isPaused) {
      const missed = this.judger.scanMisses(songTime)
      for (const rn of missed) {
        this.scorer.apply('miss')
        this.effects.push({
          lane: rn.note.col,
          judgment: 'miss',
          startSec: songTime,
        })
      }

      // 长按尾部结算：玩家一直按住不松时不会来松手事件，只能靠时间推进收尾
      for (const event of this.judger.settleHolds(songTime)) {
        this.scorer.apply(event.judgment)
        this.effects.push({
          lane: event.note.note.col,
          judgment: event.judgment,
          startSec: songTime,
        })
      }
    }

    // 鼓点反馈：推进游标 + 衰减光晕。只做氛围，完全不碰判定与计分。
    this.advanceDrums(songTime)

    // 清理过期特效。
    // 这里用的是**全局保留上限**（所有主题里该判定的最长寿命），不是当前主题的
    // 真实寿命——引擎不认识主题。真寿命由 renderer 按主题自行裁剪，所以这里刻意
    // 留得比实际长一点：少留会让特效提前消失，而且不会有任何报错。
    if (this.effects.length > 0) {
      this.effects = this.effects.filter(
        (fx) => songTime - fx.startSec < hitEffectLifeSec(fx.judgment),
      )
    }

    this.renderer.render({
      songTimeSec: songTime,
      notes: this.judger.allNotes,
      approachSec: this.opts.approachSec ?? 0.9,
      lanePressed: this.input.lanePressed,
      combo: this.scorer.snapshot().combo,
      score: this.scorer.snapshot().score,
      accuracy: this.scorer.snapshot().accuracy,
      effects: this.effects,
      paused: this.clock.isPaused,
      lastDeltaSec: this.lastDeltaSec,
    })
    this.input.resetVisualState()

    // 节流上报分数
    const nowMs = performance.timeOrigin + performance.now()
    if (nowMs - this.lastScoreEmitMs >= SCORE_THROTTLE_MS) {
      this.lastScoreEmitMs = nowMs
      this.opts.onScore?.(this.scoreSnapshot)
    }

    // 结束判定：音乐放完 + 所有音符都已定局
    if (!this.finished && songTime > this.opts.audioBuffer.duration && this.scorer.isComplete) {
      this.finish()
      return
    }
    // 兜底：音乐结束后多等 2 秒仍未定局（比如最后一个音符在极远处）也收尾
    if (!this.finished && songTime > this.opts.audioBuffer.duration + 2) {
      this.finish()
      return
    }

    this.rafId = requestAnimationFrame(this.loop)
  }

  private finish(): void {
    this.finished = true
    this.running = false
    const s = this.scorer.snapshot()
    this.opts.onFinish?.({
      score: s.score,
      maxCombo: s.maxCombo,
      accuracy: s.accuracy,
      grade: gradeOf(s.score),
      counts: s.counts,
      totalNotes: this.judger.total,
    })
  }

  private onResize = (): void => {
    this.renderer.resize()
  }

  private onEscape = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      e.preventDefault()
      void this.togglePause()
    }
  }
}

/** 从分数快照生成一句话总结，用于结算页。 */
export function summarizeScore(state: ScoreState, total: number): string {
  const acc = state.judged > 0 ? state.accuracy : 0
  if (total === 0) return '这份谱面没有音符'
  if (acc >= 0.98) return '几乎完美，这台设备配不上你'
  if (acc >= 0.9) return '非常稳的一局'
  if (acc >= 0.8) return '手感不错，再练练能上 A'
  if (acc >= 0.6) return '找到了节奏，继续'
  return '先把难度调低一档试试'
}
