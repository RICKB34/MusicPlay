/**
 * 长按判定 —— 从"这个音延续了多久"到"谱面上这个音符占多长"，并把被它代表的
 * 那些音符**从谱面里去掉**。
 *
 * ## 长按存在的意义是**简化**
 *
 * 这一条决定了本文件里所有的取舍。试玩反馈原话：
 *
 * > 屏幕上有 hold 的时候其他 track 上也有 tap，而且有时候 hold 后面跟着 tap，
 * > 很难兼顾。hold 存在的意义是简化复杂的长音……使其更容易被弹奏，
 * > 谱面更准确，而不是人为增加难度。
 *
 * 初版实现只给格点打标记、**一个音符都不删**，于是每条长按都是纯粹的
 * 手指占用增加——音符数没变，其中一些却从"点一下"变成"按住一段"。
 * 实测过：九个（曲目 × 难度）组合里八个的音符总数**一模一样**。
 * 那不是简化，是加压。所以现在长按会**吸收**它代表的音符。
 *
 * ## 吸收什么、保留什么
 *
 * 判据是"这是不是同一个持续织体的再触发"：
 *
 *   - **吸收**：落在长按区间内、自身延续也长、且**音色接近**的格点。
 *     这类是同一个长音的颤音/连弓换弓造成的重复触发，用一个长按代表它们
 *     更准确，也更好打。
 *   - **保留**：延续很短的格点（鼓点等打击乐）—— 它们是独立的声音，
 *     删掉谱面就失去节奏骨架了。
 *   - **保留**：音色差得远的持续音 —— 那是**另一条旋律线**的新音符，
 *     吸收掉等于把旋律吃掉。
 *
 * 最后一条是最容易出事的地方：连奏的人声/弦乐里每个音都"延续很长"，
 * 只看延续时长会把整条旋律糊成一个大长按。音色判据就是为了挡住它。
 *
 * ## 顺序
 *
 * `applyDifficulty → decideHolds → assignLanes`。长按占据轨道，轨道分配
 * 得先知道哪些音符是长按、各占多久才能避开。
 */

import type { Slot } from './quantize'
import type { BeatGrid } from './grid'
import type { HoldProfile } from './difficulty'

export interface HoldStats {
  /** 延续时长够格的格点数。 */
  candidates: number
  /** 最终判定为长按的数量。 */
  accepted: number
  /** 因为区间内（不可吸收的）音符太密而放弃的数量。 */
  rejectedBusy: number
  /** 被长按吸收、从谱面中移除的音符数。 */
  absorbed: number
}

export interface HoldResult {
  /** 吸收之后剩下的格点。**不是**输入的同一个数组。 */
  slots: Slot[]
  stats: HoldStats
}

/**
 * 吸收判据里允许的音色差异，按全曲谱质心跨度的比例表示。
 *
 * 0.25 意味着"音色差异不超过全曲明暗跨度的四分之一"才认为是同一个声音。
 * 在 4 轨映射下大约相当于"落在相邻轨以内"。
 *
 * 定得偏小是刻意的：**漏吸收只是少简化一点，误吸收会把旋律吃掉**，
 * 后者严重得多。
 */
const ABSORB_CENTROID_SPAN = 0.25

/** 该格点是否属于"同一个持续织体的再触发"，从而可以被长按吸收。 */
function canAbsorb(o: Slot, holdCentroid: number, minSustainMs: number, span: number): boolean {
  if (o.sustainMs < minSustainMs) return false
  return Math.abs(o.centroid - holdCentroid) <= ABSORB_CENTROID_SPAN * span
}

/**
 * 判定哪些格点成为长按，并吸收被它们代表的音符（原地写入 `slot.holdSteps`）。
 *
 * 返回**新的**格点数组——被吸收的不在里面。调用方必须用返回值，
 * 不能继续用传入的 `slots`。
 */
export function decideHolds(
  slots: Slot[],
  grid: BeatGrid,
  profile: HoldProfile,
  /**
   * 谱质心映射区间。**必须由全曲所有起音推算**（`computeCentroidRange`），
   * 不能在这里从 slots 现算：难度筛选之后格点可能很少，
   * `computeCentroidRange` 会退回默认区间（跨度 5800Hz），
   * 那个阈值宽到几乎什么都吸收——旋律会被整段吃掉。
   *
   * 与"映射区间是歌曲属性，与难度无关"是同一条原则（见 `lanes.ts` 的说明）。
   */
  centroidRange: { lo: number; hi: number },
): HoldResult {
  const stepSec = grid.gridStepSec
  const stepMs = stepSec * 1000
  const sub = grid.subdivision
  const minSteps = Math.max(1, Math.round(profile.minBeats * sub))
  const maxSteps = Math.max(minSteps, Math.round(profile.maxBeats * sub))
  const gapSteps = Math.max(1, Math.round(profile.gapBeats * sub))

  const centroidSpan = Math.max(1, centroidRange.hi - centroidRange.lo)

  let candidates = 0
  let accepted = 0
  let rejectedBusy = 0
  let lastHoldK = -Infinity
  /** 上一个长按覆盖到哪个格点。长按之间不能重叠——重叠意味着同一时刻两条长按在响。 */
  let lastHoldEndK = -Infinity

  // ── 第一遍：决定哪些格点做长按 ──
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!
    s.holdSteps = 0

    if (!(s.sustainMs >= profile.minSustainMs)) continue
    candidates++

    // 不能落进上一个长按的区间里：否则会出现两条重叠的长按
    if (s.k <= lastHoldEndK) continue

    // 两个长按之间保持距离：否则一旦某段音乐持续音很多，
    // 整条谱会变成一堵长按墙——看起来"全是长按"，手却一直腾不出来
    if (s.k - lastHoldK < gapSteps) continue

    const raw = Math.round(s.sustainMs / stepMs)

    // 低于下限就**放弃**，不能抬到下限——那会让长按比声音本身还长，
    // 尾巴挂在空气里，玩家不知道该不该松手。
    // 下限在这里是"够不够格做一个长按"的门槛，不是可以拉伸的目标。
    if (raw < minSteps) continue

    const steps = Math.min(maxSteps, raw)
    const endK = s.k + steps

    // ── 繁忙段落不生成长按 ──
    // 只统计**不会被吸收**的音符：那些才是玩家按住时真要用别的手指打的。
    // 如果它们已经很密，长按就是在加压，与它的意义相反。
    let remaining = 0
    for (let j = i + 1; j < slots.length; j++) {
      const o = slots[j]!
      if (o.k > endK) break
      if (!canAbsorb(o, s.centroid, profile.minSustainMs, centroidSpan)) remaining++
    }
    const spanSec = steps * stepSec
    if (remaining / spanSec > profile.maxHoldNps) {
      rejectedBusy++
      continue
    }

    s.holdSteps = steps
    lastHoldK = s.k
    lastHoldEndK = endK
    accepted++
  }

  // ── 第二遍：吸收 ──
  // 长按按 k 升序且互不相邻（gapBeats 保证），用单指针扫一遍即可。
  const holds = slots.filter((s) => (s.holdSteps ?? 0) > 0)
  const out: Slot[] = []
  let absorbed = 0
  let hi = 0

  for (const s of slots) {
    // 长按本身永远不被吸收
    if ((s.holdSteps ?? 0) > 0) {
      out.push(s)
      continue
    }

    while (hi < holds.length && holds[hi]!.k + holds[hi]!.holdSteps! < s.k) hi++
    const h = holds[hi]

    if (h && s.k > h.k && s.k <= h.k + h.holdSteps!) {
      if (canAbsorb(s, h.centroid, profile.minSustainMs, centroidSpan)) {
        absorbed++
        continue
      }
    }
    out.push(s)
  }

  return { slots: out, stats: { candidates, accepted, rejectedBusy, absorbed } }
}
