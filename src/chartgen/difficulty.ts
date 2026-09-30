/**
 * 难度分级 —— 从"所有检测到的起音"里挑出"这个难度该有的音符"。
 *
 * 三个难度共用一条管线，只是参数不同。核心是三个滤波器：
 *   1. 强度阈值   —— 弱的起音不配成为音符
 *   2. 最小间隔   —— 两个音符挨得太近，手指来不及
 *   3. NPS 滑窗封顶 —— 每秒音符数上限
 *
 * 第 3 点用**滑窗剔除**而非全局缩放，效果是"副歌自动变密、主歌自动变疏"。
 * 这正是人工谱面的宏观节奏感，也是让谱面听起来不机械的关键。
 */

import type { Difficulty } from '../types'
import type { Slot } from './quantize'

/**
 * 长按参数。时长一律用**拍**表示，不用格点——
 * 格点长度随细分变化（十六分格只有四分格的四分之一），用格点会让同一套
 * 参数在不同细分下产出长度差四倍的长按。
 */
export interface HoldProfile {
  /** 能量延续超过这么多毫秒，才可能成为长按。 */
  minSustainMs: number
  /** 长按时长下限（拍）。太短的长按还不如做成短按。 */
  minBeats: number
  /** 长按时长上限（拍）。 */
  maxBeats: number
  /** 两个长按之间至少隔多少拍，避免整条谱变成一堵长按墙。 */
  gapBeats: number
  /**
   * 长按区间内允许的**其他音符**密度上限（个/秒）。
   *
   * **这是"长按是为了简化"这条原则的主要执行者。** 长按占住一根手指，
   * 若这段时间里本来就有很多音符，剩下三根手指要全扛下来——
   * 那长按就是在加压，与它存在的意义相反。所以密集段落一律不生成长按。
   *
   * 按"个/秒"而不是"个数"：区间越长自然包含越多音符，用绝对个数
   * 会把所有长按都卡掉。
   */
  maxHoldNps: number
}

export interface DifficultyProfile {
  /** 强度阈值（基于全曲 p95 归一化）。低于此值的起音被丢弃。 */
  strengthThreshold: number
  /** 每秒音符数上限。 */
  maxNps: number
  /** 两个音符之间的最小间隔（毫秒）。 */
  minGapMs: number
  /** 长按相关参数。 */
  hold: HoldProfile
}

/**
 * 数值来自音游手感经验：
 *   easy  —— 只留最突出的重音，慢到能看清每个音符
 *   normal—— 主流可玩区间，能跟上流行歌的鼓组
 *   hard  —— 保留大部分起音，需要一定手速
 */
export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    strengthThreshold: 0.55,
    maxNps: 2.0,
    minGapMs: 120,
    // 简单难度里一个长按应当是**休息点**：只认很明显的延续，离得远，周围还得空旷
    hold: { minSustainMs: 800, minBeats: 1, maxBeats: 2, gapBeats: 12, maxHoldNps: 1.5 },
  },
  normal: {
    strengthThreshold: 0.3,
    maxNps: 4.0,
    minGapMs: 70,
    hold: { minSustainMs: 600, minBeats: 1, maxBeats: 3, gapBeats: 8, maxHoldNps: 2.5 },
  },
  hard: {
    strengthThreshold: 0.12,
    maxNps: 7.0,
    minGapMs: 55,
    hold: { minSustainMs: 450, minBeats: 1, maxBeats: 4, gapBeats: 6, maxHoldNps: 3.5 },
  },
}

export interface DifficultyResult {
  slots: Slot[]
  /** 各滤波器丢弃的数量，用于调试页显示。 */
  droppedByStrength: number
  droppedByGap: number
  droppedByNps: number
}

export function applyDifficulty(slots: Slot[], profile: DifficultyProfile): DifficultyResult {
  // ── 滤波器 1：强度阈值 ──
  const byStrengths: Slot[] = []
  let droppedByStrength = 0
  for (const s of slots) {
    if (s.strength >= profile.strengthThreshold) byStrengths.push(s)
    else droppedByStrength++
  }

  // ── 滤波器 2：最小间隔（贪心，时间序）──
  // 违反间隔时保留更强的那个。因为已经按时间排序，只需和"上一个接受的"比较。
  const byGap: Slot[] = []
  let droppedByGap = 0
  const minGapSec = profile.minGapMs / 1000

  for (const s of byStrengths) {
    const last = byGap[byGap.length - 1]
    if (last && s.time - last.time < minGapSec) {
      // 新的更强就换掉上一个，否则丢弃新的
      if (s.strength > last.strength) {
        byGap[byGap.length - 1] = s
      }
      droppedByGap++
      continue
    }
    byGap.push(s)
  }

  // ── 滤波器 3：NPS 滑窗封顶 ──
  //
  // 关键设计：**只在入口处决策，绝不回溯删除已经接受的音符**。
  // 早期版本写成"窗口超限就剔除窗口内最弱者"，在强度相同时（`<` 永不成立）
  // 会恒定为剔除窗口里最老的那个，于是谱面被从头部一路排空——
  // 171 个起音只剩 4 个。这是个真实踩过的坑，所以这里用单遍入口判定。
  //
  // 另一处必须小心的地方：窗口**不能**用一个会被原地替换的数组来表示，
  // 那样它就不再按时间有序，"最老的"判断会失效（这是实测踩到的第二个坑）。
  // 这里改成每次从 `accepted` 尾部按时间回扫，天然保持有序语义。
  const accepted: Slot[] = []
  const rejected = new Set<Slot>()
  let droppedByNps = 0

  for (const s of byGap) {
    accepted.push(s)

    // 回扫最近 1 秒内尚未被剔除的音符。因为 accepted 按时间升序，
    // 一旦遇到早于窗口起点的就可以停——回扫长度受每秒音符数约束，很短。
    const lo = s.time - 1.0
    const inWindow: Slot[] = []
    for (let i = accepted.length - 1; i >= 0; i--) {
      const a = accepted[i]
      if (!a || a.time < lo) break
      if (!rejected.has(a)) inWindow.push(a)
    }

    if (inWindow.length > profile.maxNps) {
      // 剔除窗口内最弱者。强度全相同时退化为剔除窗口内最老者，
      // 结果是稳定的"每秒保留 cap 个"，不会排空整个谱面。
      let weakest = inWindow[0]
      for (const w of inWindow) {
        if (w && weakest && w.strength < weakest.strength) weakest = w
      }
      if (weakest) {
        rejected.add(weakest)
        droppedByNps++
      }
    }
  }

  return {
    slots: accepted.filter((s) => !rejected.has(s)),
    droppedByStrength,
    droppedByGap,
    droppedByNps,
  }
}
