/**
 * 判定与计分。
 *
 * 关键设计：**判定是事件驱动的，不是帧驱动的**。
 * 玩家按下按键的那一刻，在输入回调里同步读时钟并立即判定，
 * 而不是等到下一帧 rAF 再处理。这样 rAF 抖动（甚至掉帧到 30fps）
 * 对判定精度的影响是零，只影响画面流畅度。
 *
 * 漏判扫描才走帧驱动：每帧检查是否有音符已经错过判定窗。
 * 因为帧间隔（≤16ms）远小于判定窗（90ms），不会漏。
 */

import type { Chart, Judgment, Note } from '../types'
import { DEFAULT_JUDGMENT, NOTE_HOLD, type JudgmentConfig } from '../types'

export type NoteState = 'pending' | 'holding' | 'hit' | 'missed'

/**
 * 长按提前松手的成功门槛。
 *
 * 按满三分之二后松手不再判 Miss，但只能封顶 Good；按得更久、进入尾部
 * 容差后才沿用头部判定的等级。这样既不要求玩家机械地按到最后一毫秒，
 * 又不会让头部点一下就成功。
 */
const HOLD_BREAK_SUCCESS_RATIO = 2 / 3

export interface RuntimeNote {
  note: Note
  /** 音符时刻（秒），避免每次判定都做 `/1000`。 */
  timeSec: number
  /** 长按的结束时刻（秒）。tap 与 `timeSec` 相同。 */
  tailSec: number
  state: NoteState
  judgment?: Judgment
  /**
   * 长按按下那一刻的判定，尾部结算时沿用它。
   *
   * 为什么整条长按只出一个判定：头判和尾判若各出一分，一个长按就会被算成
   * 两个音符，`judged` 会超过 `notes.length`，进度条与结束判定全乱；
   * 而"提前松手就把已加的分撤回"要动计分器内部状态，得不偿失。
   */
  holdGrade?: Judgment
}

export interface JudgmentEvent {
  note: RuntimeNote
  judgment: Judgment
  /** 偏差（秒）。正数表示玩家按晚了。 */
  deltaSec: number
  /**
   * 是否**延后计分**。
   *
   * 长按的头部为 true：按下只进入 holding，不出判定特效也不计分；
   * 后续按提前松手门槛或尾部容差结算一次。
   * 调用方看到这个标记就不该调 `Scorer.apply`。
   */
  deferred?: boolean
}

export class Judger {
  private readonly notes: RuntimeNote[]
  private readonly config: JudgmentConfig
  /** 第一个尚未定局的音符下标。音符按时间升序，所以判定只需从这个位置往后看。 */
  private cursor = 0

  constructor(chart: Chart, config: JudgmentConfig = DEFAULT_JUDGMENT) {
    this.config = config
    this.notes = chart.notes.map((note) => ({
      note,
      timeSec: note.t / 1000,
      tailSec: (note.t + (note.type === NOTE_HOLD ? (note.d ?? 0) : 0)) / 1000,
      state: 'pending' as NoteState,
    }))
  }

  get allNotes(): readonly RuntimeNote[] {
    return this.notes
  }

  get total(): number {
    return this.notes.length
  }

  /**
   * 处理一次按键。
   *
   * 在该轨道上、判定窗内找**时间最接近**的未定局音符。时间最接近而非最早，
   * 是因为玩家可能同时看到两个音符，按下的意图显然是更近的那个。
   */
  handleInput(lane: number, songTimeSec: number): JudgmentEvent | null {
    const windowSec = this.config.goodMs / 1000
    const lo = songTimeSec - windowSec
    const hi = songTimeSec + windowSec

    let best: RuntimeNote | null = null
    let bestDelta = Infinity

    // 从游标开始向后扫描，直到超出窗口上界
    for (let i = this.cursor; i < this.notes.length; i++) {
      const rn = this.notes[i]
      if (!rn) continue
      if (rn.timeSec > hi) break
      if (rn.state !== 'pending') continue
      if (rn.note.col !== lane) continue
      if (rn.timeSec < lo) continue

      const delta = Math.abs(rn.timeSec - songTimeSec)
      if (delta < bestDelta) {
        bestDelta = delta
        best = rn
      }
    }

    if (!best) return null

    const deltaSec = songTimeSec - best.timeSec
    const judgment = this.classify(Math.abs(deltaSec))

    // 长按：进入 holding，等尾部再结算；头部本身不产生判定结果（deferred）。
    if (best.note.type === NOTE_HOLD && (best.note.d ?? 0) > 0) {
      best.state = 'holding'
      best.holdGrade = judgment
      this.advanceCursor()
      return { note: best, judgment, deltaSec, deferred: true }
    }

    best.state = 'hit'
    best.judgment = judgment
    this.advanceCursor()

    return { note: best, judgment, deltaSec }
  }

  /**
   * 松开某个轨道 —— 长按"提前松手"的判定在这里。
   *
   * 为什么走事件而不是每帧采样按键状态：玩家可能只松开一两帧就重新按下，
   * 帧驱动（±16ms 采样）会完全漏掉这次断触。松手是明确的用户事件，用它最准。
   */
  handleRelease(lane: number, songTimeSec: number): JudgmentEvent[] {
    const out: JudgmentEvent[] = []
    // 尾判是"有没有坚持住"，容差比 good 判定窗宽得多——见 holdReleaseMs
    const cutoff = songTimeSec + this.config.holdReleaseMs / 1000

    for (let i = this.cursor; i < this.notes.length; i++) {
      const rn = this.notes[i]
      if (!rn || rn.state !== 'holding' || rn.note.col !== lane) continue

      if (rn.tailSec > cutoff) {
        // ── 断触（hold break）──
        //
        // 按满三分之二后提前松手：算完成，但只给最低的 Good。
        // 不到三分之二：按断触处理，判 Miss 并断 combo。
        const durationSec = rn.tailSec - rn.timeSec
        const heldSec = songTimeSec - rn.timeSec
        const heldEnough = durationSec > 0 && heldSec >= durationSec * HOLD_BREAK_SUCCESS_RATIO

        if (heldEnough) {
          rn.state = 'hit'
          rn.judgment = 'good'
          out.push({ note: rn, judgment: 'good', deltaSec: 0 })
        } else {
          // 状态标 'missed' 而非 'hit'：这条长按就此定局，不该再被
          // `settleHolds` 扫到第二次。
          rn.state = 'missed'
          rn.judgment = 'miss'
          out.push({ note: rn, judgment: 'miss', deltaSec: 0 })
        }
      } else {
        // 已经在容差内 → 算完成，沿用头判的等级
        rn.state = 'hit'
        rn.judgment = rn.holdGrade ?? 'good'
        out.push({ note: rn, judgment: rn.judgment, deltaSec: 0 })
      }
    }
    if (out.length > 0) this.advanceCursor()
    return out
  }

  /**
   * 结算尾部已到、且玩家仍按住的长按 —— 每帧调用。
   *
   * 玩家一直按住不松，就永远不会来松手事件，必须靠时间推进收尾。
   * 提前松手的情形已经被 `handleRelease` 结算掉了，不会走到这里。
   */
  settleHolds(songTimeSec: number): JudgmentEvent[] {
    const out: JudgmentEvent[] = []
    for (let i = this.cursor; i < this.notes.length; i++) {
      const rn = this.notes[i]
      if (!rn || rn.state !== 'holding') continue
      if (rn.tailSec > songTimeSec) continue

      rn.state = 'hit'
      rn.judgment = rn.holdGrade ?? 'good'
      out.push({ note: rn, judgment: rn.judgment, deltaSec: 0 })
    }
    if (out.length > 0) this.advanceCursor()
    return out
  }

  /**
   * 扫描已经错过判定窗的音符，标记为 Miss。
   *
   * 每帧调用一次。返回本次新漏掉的音符，供引擎更新连击与特效。
   */
  scanMisses(songTimeSec: number): RuntimeNote[] {
    const windowSec = this.config.goodMs / 1000
    const deadline = songTimeSec - windowSec
    const missed: RuntimeNote[] = []

    for (let i = this.cursor; i < this.notes.length; i++) {
      const rn = this.notes[i]
      if (!rn) continue
      if (rn.timeSec > deadline) break
      if (rn.state !== 'pending') continue
      rn.state = 'missed'
      rn.judgment = 'miss'
      missed.push(rn)
    }

    this.advanceCursor()
    return missed
  }

  /**
   * 把游标推进到第一个**尚未定局**的音符。
   *
   * `holding` 也要停下来：它虽然已经被按下，但还没结算，
   * `handleRelease` / `settleHolds` 仍需要从游标处扫到它。
   */
  private advanceCursor(): void {
    while (this.cursor < this.notes.length) {
      const st = this.notes[this.cursor]?.state
      if (st === 'pending' || st === 'holding') break
      this.cursor++
    }
  }

  private classify(absDeltaSec: number): Judgment {
    const ms = absDeltaSec * 1000
    if (ms <= this.config.perfectMs) return 'perfect'
    if (ms <= this.config.greatMs) return 'great'
    return 'good'
  }
}

// ─────────────────────────── 计分 ───────────────────────────

export interface ScoreState {
  score: number
  combo: number
  maxCombo: number
  /** 各判定的计数。 */
  counts: Record<Judgment, number>
  /** 命中率 [0,1]；GOOD/GREAT/PERFECT 都算命中，不参与分值加权。 */
  accuracy: number
  /** 已定局的音符数。 */
  judged: number
}

/** 满分 —— 所有音符全 PERFECT 时的总分，也是评级的基准刻度。 */
export const MAX_SCORE = 10000

/** 判定对应的单音符得分倍率。 */
export const JUDGMENT_SCORE_MULTIPLIER: Record<Judgment, number> = {
  perfect: 1,
  great: 0.8,
  good: 0.6,
  miss: 0,
}

export class Scorer {
  private score = 0
  private combo = 0
  private maxCombo = 0
  /** 命中的音符数。accuracy = hitCount / judged，即"命中率"。 */
  private hitCount = 0
  private judged = 0
  private readonly counts: Record<Judgment, number> = {
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
  }
  /** 每个音符的满分值 = 满分平均分配。全 PERFECT 时总和恰好回到 MAX_SCORE。 */
  private readonly perNote: number

  constructor(private readonly totalNotes: number) {
    this.perNote = totalNotes > 0 ? MAX_SCORE / totalNotes : 0
  }

  apply(judgment: Judgment): void {
    this.judged++
    this.counts[judgment]++

    if (judgment === 'miss') {
      this.combo = 0
      return
    }

    this.combo++
    if (this.combo > this.maxCombo) this.maxCombo = this.combo

    // 满分固定 10000，平均摊到每个音符，再乘判定倍率：
    // PERFECT 1.0 / GREAT 0.8 / GOOD 0.6 / MISS 0。
    this.hitCount++
    this.score += this.perNote * JUDGMENT_SCORE_MULTIPLIER[judgment]
  }

  snapshot(): ScoreState {
    return {
      score: Math.round(this.score),
      combo: this.combo,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      accuracy: this.judged > 0 ? this.hitCount / this.judged : 1,
      judged: this.judged,
    }
  }

  /** 是否已经打完所有音符。 */
  get isComplete(): boolean {
    return this.judged >= this.totalNotes
  }
}

/** 按总分评级。满分 `MAX_SCORE`：P=满分，S=9000+，A=8000+，B=7000+，C=6000+，余下 D。 */
export function gradeOf(score: number): string {
  if (score >= MAX_SCORE) return 'P'
  if (score >= 9000) return 'S'
  if (score >= 8000) return 'A'
  if (score >= 7000) return 'B'
  if (score >= 6000) return 'C'
  return 'D'
}
