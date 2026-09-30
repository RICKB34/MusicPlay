/**
 * 轨道分配 —— 产品核心竞争力的所在。
 *
 * 要解决的问题：我们**没有可靠的音高信息**（浏览器端复音音高提取做不准），
 * 那凭什么让谱面看起来"跟着音乐走"而不是"随机撒点"？
 *
 * 答案是把 STFT 里免费拿得到的听觉维度，映射到视觉上可预期的规律：
 *
 *   谱质心（音色明暗）  →  轨道左右位置
 *
 * 这不是随便定的映射，而是**听觉维度到视觉维度的同构**：玩家听到底鼓（低沉）
 * 时下意识知道音符在左边，听到镲片（明亮）时知道在右边。反复几次后就形成
 * "谱面在跟音乐走"的强烈感知。
 *
 * 其余规则（重拍锚定、反卡手、左右手均衡）都是在这条主轴上做修正。
 */

import { HOLD_TAIL_MIN_GAP_MS, type Note } from '../types'
import type { BeatGrid } from './grid'
import type { Slot } from './quantize'

export interface LaneAssignOptions {
  columns: 4 | 6
  /** 确定性随机种子，用音频指纹派生。保证同一首歌永远生成同一份谱面。 */
  seed: number
  /** 同一轨道连续出现的最小格点间隔。默认 2。 */
  minRepeatGapSteps?: number
  /** 同一轨道连击上限。默认 3。 */
  maxRunLength?: number
  /**
   * 左右手使用量差异超过此值时开始纠偏。默认 0.2。
   *
   * 阈值和权重是实测调出来的：最初用 0.25 / 权重 0.5，结果在"全曲单一音色"
   * 这类极端输入下四轨会塌缩到左半边两轨——左手使用量的惩罚不够强，
   * 压不过谱质心亲和度的梯度。调强后才真正把音符推向右手。
   */
  handBalanceThreshold?: number
  /**
   * 轨道"冷却"格点数。某条轨刚用过，在接下来这么多格点内会被轻微扣分，
   * 促使音符在音色信息不足时也能铺开。默认 6。
   */
  laneCooldownSteps?: number
  /**
   * 是否允许生成双押。默认开启。
   * 仅在合并的起音**音色跨度很大**时才判定为双押——保守策略，避免生成打不出的谱面。
   */
  allowChords?: boolean
  /**
   * 谱质心映射区间。留空则由本曲的音色分布自动推算（推荐）。
   * 显式指定主要用于测试与调试页的手动覆盖。
   */
  centroidRange?: CentroidRange
}

/** 谱质心的映射区间（Hz）。 */
export interface CentroidRange {
  lo: number
  hi: number
}

/**
 * 兜底的固定映射区间。**只在无法从歌曲自身推算时才用。**
 *
 * 端点依据：底鼓基频约 50-80Hz，镲片能量集中在 3-8kHz。
 */
export const DEFAULT_CENTROID_RANGE: CentroidRange = { lo: 200, hi: 6000 }

/**
 * 谱质心 → 目标轨道的单调映射。
 *
 * 低沉 → 左，明亮 → 右，中间线性插值。**区间由本曲自己决定**
 * （见 `computeCentroidRange`），而不是用固定的绝对频率。
 *
 * 为什么必须自适应：实测真实曲目后发现固定区间会严重塌缩——
 * 《卡农》（弦乐）的谱质心全曲只在 602-1094Hz 之间，而固定区间的
 * 低端是 200Hz，于是几乎所有音符都映射到最左轨，四轨使用率变成
 * **65%/2%/33%/0%**——一半轨道完全没用上，谱面极其单调。
 *
 * 归一化到歌曲自身的音色范围后，映射关系（相对明暗 → 左右）保持不变，
 * 但能真正铺满所有轨道。这与「把听觉维度映射到视觉维度」的初衷一致：
 * 玩家感知的是**相对**明暗，不是绝对频率。
 */
export function centroidToLane(
  centroid: number,
  columns: number,
  range: CentroidRange = DEFAULT_CENTROID_RANGE,
): number {
  const span = Math.max(1, range.hi - range.lo)
  const t = Math.max(0, Math.min(1, (centroid - range.lo) / span))
  return Math.round(t * (columns - 1))
}

/**
 * 由本曲的谱质心分布推算映射区间。
 *
 * 取 p10 / p90 而非 min / max：**抗离群点**。一次爆音或一个异常的
 * 高频瞬态不该把整个映射区间拉偏。
 *
 * 音色范围过窄（几乎没有变化）时退回默认区间——否则会把纯噪声
 * 放大成"满轨分布"，制造出看似丰富实则随机的谱面。
 */
export function computeCentroidRange(centroids: number[]): CentroidRange {
  if (centroids.length < 8) return DEFAULT_CENTROID_RANGE

  const sorted = [...centroids].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const lo = at(0.1)
  const hi = at(0.9)

  // 下限取得很低（120Hz）是刻意的：这个分支的唯一职责是**防止除以零**，
  // 而不是判断"音色变化够不够大"。
  //
  // 早期用过 400Hz，结果把《卡农》这类弦乐（音色跨度约 350-490Hz）
  // 误判成"没有音色变化"而退回固定区间，重新塌缩。绝对值本身就不是
  // 正确的判据——350Hz 的跨度在 850Hz 附近是 **40% 的相对变化**，
  // 那是真实的音色差异，铺开到四条轨上恰恰是正确的做法。
  if (!(hi - lo > 120)) return DEFAULT_CENTROID_RANGE
  return { lo, hi }
}

/**
 * 判定为双押所需的谱质心跨度（Hz）。低于此值认为是同一击打的频谱扩散。
 *
 * 1500 时太保守——只有"底鼓 + 镲片"这类极端同格组合才触发，双押几乎不出现。
 * 降到 800 后，常见的"鼓点 + 人声/弦乐"同格组合也能拆成双押，出现频率提升，
 * 但仍被 `merged >= 2`（同格多起音）与 `pickChordLanes` 的"不相邻、不跨手"
 * 约束兜住，不会生成打不出的谱面。
 */
const CHORD_CENTROID_SPREAD = 800

// 评分权重。反卡手权重最高，因为它决定"能不能打"（底线）；
// 谱质心权重次之，它决定"像不像在跟音乐"（体验）。
const W_CENTROID = 1.0
const W_DOWNBEAT = 0.55
const W_JACK = 1.6
const W_RUN = 1.0
const W_HAND = 0.9
const W_RECENCY = 0.4
const W_JITTER = 0.08
/**
 * 轨道占用惩罚 —— 某条轨还被一个没结束的长按占着时的扣分。
 *
 * 罚得这么重（远超其他所有项）是因为这不是"手感不好"，而是**物理上按不出来**：
 * 一根手指按着长按，同轨又落一个音符，玩家没有第三只手。
 * 它等效于硬约束，留一点数值空间只是为了在所有轨道都被占住时仍能选出一个。
 */
const W_BUSY = 100

/** mulberry32 —— 5 行的确定性 PRNG。谱面可复现是联机对战的硬性前提。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function handOf(lane: number, columns: number): 0 | 1 {
  return lane < columns / 2 ? 0 : 1
}

export function assignLanes(
  slots: Slot[],
  grid: BeatGrid,
  opts: LaneAssignOptions,
): Note[] {
  const cols = opts.columns
  const minRepeatGap = opts.minRepeatGapSteps ?? 2
  const maxRun = opts.maxRunLength ?? 3
  const handThreshold = opts.handBalanceThreshold ?? 0.2
  const cooldownSteps = opts.laneCooldownSteps ?? 6
  const allowChords = opts.allowChords ?? true
  // 自适应映射区间：按本曲自己的音色分布归一化，避免真实曲目塌缩。
  //
  // ⚠️ 调用方应当传入**全曲所有起音**推算出的区间，而不是让这里从 slots 现算。
  // 因为 slots 已经过难度筛选，简单难度只留下最突出的那些音，音色分布更窄，
  // 会误触发"范围过窄"的兜底而退回固定区间——结果同一首歌换个难度，
  // 映射区间就变了，简单难度反而塌缩（实测《卡农》easy 就是 65%/2%/33%/0%）。
  // 映射区间应当是**歌曲的属性**，与难度无关。
  const range = opts.centroidRange ?? computeCentroidRange(slots.map((s) => s.centroid))

  const rand = mulberry32(opts.seed)
  const notes: Note[] = []

  let lastLane = -1
  let lastK = -Infinity
  let runLength = 0
  // 左右手使用量的指数滑动平均，用于均衡纠偏
  const handUsage: [number, number] = [0.5, 0.5]
  const HAND_EMA = 0.12
  // 每条轨最后被使用的格点索引，用于冷却扣分
  const lastUsedK = new Array<number>(cols).fill(-Infinity)

  // ── 长按占用：每条轨在被占用的格点之前不能再落音符 ──
  // 长按占住 [k, k+holdSteps]，之后还要留出松手再按的间隔（HOLD_TAIL_MIN_GAP_MS）
  const gapSteps = Math.max(1, Math.ceil(HOLD_TAIL_MIN_GAP_MS / 1000 / grid.gridStepSec))
  const laneBusyUntil = new Array<number>(cols).fill(-Infinity)

  for (const slot of slots) {
    const targetLane = centroidToLane(slot.centroid, cols, range)
    const onBarLine = grid.isBarLine(slot.k)
    const stepGap = slot.k - lastK

    // ── 双押判定（两条来源）──
    // ① 被动：合并了多个起音、且音色跨度足够大 —— 音频里真的有两个音同时响。
    // ② 主动：小节线的强拍 —— 把单个强音符拆成双押，作为节奏强调（见下方 isInjectedChord）。
    // 长按一律不做双押：「按住这条轨的同时再按另一条」对玩家太苛刻，
    // 而且断触时该松哪根手指也说不清。
    const isPassiveChord =
      allowChords &&
      (slot.holdSteps ?? 0) === 0 &&
      slot.merged >= 2 &&
      slot.centroidMax - slot.centroidMin >= CHORD_CENTROID_SPREAD
    const isInjectedChord =
      allowChords && (slot.holdSteps ?? 0) === 0 && !isPassiveChord && onBarLine

    let chosen: number[]

    if (isPassiveChord) {
      chosen = pickChordLanes(slot, cols, targetLane, range)
    } else {
      const mainLane = pickSingleLane({
        cols,
        targetLane,
        onBarLine,
        slotK: slot.k,
        stepGap,
        lastLane,
        runLength,
        minRepeatGap,
        maxRun,
        handUsage,
        handThreshold,
        lastUsedK,
        cooldownSteps,
        busyUntil: laneBusyUntil,
        rand,
      })
      chosen = [mainLane]
      if (isInjectedChord) {
        // 主轨仍走正常评分（反卡手/左右手均衡都生效），副轨挑一条不相邻、跨手、
        // 且未被长按占用的轨道。找不到就保持单押——宁可不注入，也不硬塞打不出的双押。
        const second = pickSecondaryLane(mainLane, cols, laneBusyUntil, slot.k)
        if (second != null) chosen = [mainLane, second].sort((a, b) => a - b)
      }
    }

    // 双押可能因约束退化成单轨，这里兜底
    if (chosen.length === 0) chosen = [targetLane]

    const holdSteps = slot.holdSteps ?? 0
    for (let i = 0; i < chosen.length; i++) {
      const lane = chosen[i]!
      const n: Note = {
        t: Math.round(slot.time * 1000),
        col: lane,
        type: 0,
      }
      // 长按只落在主轨（上面已经保证长按不做双押，所以 chosen 只有一条）
      if (holdSteps > 0 && i === 0) {
        n.type = 1
        n.d = Math.round(holdSteps * grid.gridStepSec * 1000)
      }
      notes.push(n)
    }

    // ── 更新状态（用主轨，即最强的那个）──
    const primary = chosen[0]
    if (primary === lastLane && stepGap < minRepeatGap + 1) runLength++
    else runLength = primary === lastLane ? runLength + 1 : 1
    lastLane = primary
    lastK = slot.k

    // 长按占住这条轨：占用区间 + 松手再按的间隔
    if (holdSteps > 0) {
      laneBusyUntil[primary] = slot.k + holdSteps + gapSteps
    }

    // 更新左右手使用量与各轨冷却时间
    for (const lane of chosen) {
      const h = handOf(lane, cols)
      handUsage[h] = handUsage[h] * (1 - HAND_EMA) + 1 * HAND_EMA
      handUsage[1 - h] = handUsage[1 - h] * (1 - HAND_EMA)
      lastUsedK[lane] = slot.k
    }
  }

  return notes
}

interface SingleLaneContext {
  cols: number
  targetLane: number
  onBarLine: boolean
  slotK: number
  stepGap: number
  lastLane: number
  runLength: number
  minRepeatGap: number
  maxRun: number
  handUsage: [number, number]
  handThreshold: number
  lastUsedK: number[]
  cooldownSteps: number
  /** 每条轨被长按占用到哪个格点为止。 */
  busyUntil: number[]
  rand: () => number
}

function pickSingleLane(ctx: SingleLaneContext): number {
  const {
    cols,
    targetLane,
    onBarLine,
    slotK,
    stepGap,
    lastLane,
    runLength,
    minRepeatGap,
    maxRun,
    handUsage,
    handThreshold,
    lastUsedK,
    cooldownSteps,
    busyUntil,
    rand,
  } = ctx

  let bestLane = targetLane
  let bestScore = -Infinity

  // 注意：循环里每次都调用一次 rand()，与最终选中哪条轨无关。
  // 这保证了 PRNG 消耗次数只取决于输入，谱面因此可复现。
  for (let lane = 0; lane < cols; lane++) {
    let score = 0

    // 1. 谱质心亲和度：主轴
    score += W_CENTROID * (1 - Math.abs(lane - targetLane) / Math.max(1, cols - 1))

    // 2. 重拍锚定外侧轨：让小节边界在视觉上清晰，建立"重拍在两边"的肌肉记忆
    if (onBarLine) {
      score += W_DOWNBEAT * (lane === 0 || lane === cols - 1 ? 1 : 0)
    }

    // 3. 反卡手：同轨快速重复是明确的"打不出来"配置，必须重罚
    if (lane === lastLane) {
      if (stepGap < minRepeatGap) score -= W_JACK
      if (runLength >= maxRun) score -= W_RUN
    }

    // 4. 左右手均衡：防止长段落把一侧手指累垮
    const h = handOf(lane, cols)
    const imbalance = handUsage[h] - handUsage[1 - h]
    if (imbalance > handThreshold) score -= W_HAND * (imbalance - handThreshold) * 4

    // 5. 轨道冷却：某条轨刚用过就轻微扣分。
    //    音色信息不足时（比如整段都是同一个音色），全靠这条把音符铺开，
    //    否则四轨会塌缩到相邻两轨来回打。
    const sinceUsed = slotK - (lastUsedK[lane] ?? -Infinity)
    if (sinceUsed < cooldownSteps) {
      score -= W_RECENCY * (1 - sinceUsed / cooldownSteps)
    }

    // 7. 轨道占用 —— 这条轨还压着一个没结束的长按。
    //    不是"手感差"，是物理上按不出来，见 W_BUSY 的说明。
    if (slotK < (busyUntil[lane] ?? -Infinity)) score -= W_BUSY

    // 8. 确定性抖动：打破平局，避免总是在两条等价轨里固定选一条
    score += rand() * W_JITTER

    if (score > bestScore) {
      bestScore = score
      bestLane = lane
    }
  }

  return bestLane
}

/**
 * 双押轨道选择。
 *
 * 约束（都来自"好不好打"）：
 *   - 两条轨不能相邻（相邻轨要并拢两根手指，极易误触）
 *   - 不能跨越左右手分界（跨手双押很难协调）
 * 候选组合按"跨度大者优先"排序，4K 下首选 {0,3}。
 */
function pickChordLanes(
  slot: Slot,
  cols: number,
  fallbackLane: number,
  range: CentroidRange,
): number[] {
  const lowLane = centroidToLane(slot.centroidMin, cols, range)
  const highLane = centroidToLane(slot.centroidMax, cols, range)

  // 低沉的音在左、明亮的音在右——与单轨映射保持一致，避免破坏玩家的直觉
  if (lowLane !== highLane) {
    const lo = Math.min(lowLane, highLane)
    const hi = Math.max(lowLane, highLane)
    const nonAdjacent = hi - lo >= 2
    const sameHand = handOf(lo, cols) === handOf(hi, cols)
    if (nonAdjacent && !sameHand) return [lo, hi].sort((a, b) => a - b)
  }

  // 退化：按"不相邻 + 不跨手"的经典组合挑一组
  const half = cols / 2
  const combos: [number, number][] =
    cols === 4
      ? [
          [0, 3],
          [0, 2],
          [1, 3],
        ]
      : [
          [0, 5],
          [1, 5],
          [0, 4],
          [1, 4],
          [0, 3],
          [2, 5],
        ]

  for (const [a, b] of combos) {
    if (a >= cols || b >= cols) continue
    if (handOf(a, cols) === handOf(b, cols)) continue
    if (b - a < 2) continue
    void half
    return [a, b]
  }

  return [fallbackLane]
}

/**
 * 主动注入双押的副轨选择。
 *
 * 约束与被动双押一致（不相邻、跨手），另外副轨不能还压着一个没结束的长按。
 * 优先选离主轨最远的候选——手型更开、读谱更清楚。找不到就返回 null，
 * 调用方退化成单押（宁可不注入，也不硬塞一个打不出的双押）。
 */
function pickSecondaryLane(
  primary: number,
  cols: number,
  busyUntil: number[],
  slotK: number,
): number | null {
  let best: number | null = null
  let bestGap = -1
  for (let lane = 0; lane < cols; lane++) {
    if (lane === primary) continue
    if (handOf(lane, cols) === handOf(primary, cols)) continue
    if (Math.abs(lane - primary) < 2) continue
    if (slotK < (busyUntil[lane] ?? -Infinity)) continue
    const gap = Math.abs(lane - primary)
    if (gap > bestGap) {
      bestGap = gap
      best = lane
    }
  }
  return best
}

/**
 * 谱面质量自检 —— 把"看着像不像随机"变成可判定的数字。
 *
 * 一份好的谱面应该：四轨使用率大致均衡（各 15-35%），
 * 且相邻音符的轨道差**很少为 0**（即很少同轨连击）。
 * 如果分布接近均匀随机，说明谱质心映射或反卡手没生效。
 */
export interface LaneQualityReport {
  /** 各轨道使用占比。 */
  laneUsage: number[]
  /** 同轨连续出现的次数。 */
  jackCount: number
  /** 相邻音符轨道差的平均值。健康的谱面应有明显峰值且均值 > 0.5。 */
  meanLaneDelta: number
  /**
   * 是否存在使用率超过 50% 的轨道（说明轨道分配塌缩了）。
   *
   * 阈值定在 50% 而非更低：真实音乐里某一轨被偏重是正常的
   * （比如副歌底鼓密集时左侧轨偏多），只要没有单轨吃掉大半就不算塌缩。
   */
  collapsed: boolean
}

export function reportLaneQuality(notes: Note[], columns: number): LaneQualityReport {
  const usage = new Array(columns).fill(0)
  let jackCount = 0
  let deltaSum = 0
  let deltaN = 0
  let prev = -1

  for (const n of notes) {
    usage[n.col] = (usage[n.col] ?? 0) + 1
    if (prev >= 0) {
      const d = Math.abs(n.col - prev)
      deltaSum += d
      deltaN++
      if (d === 0) jackCount++
    }
    prev = n.col
  }

  const total = Math.max(1, notes.length)
  const laneUsage = usage.map((u) => u / total)
  return {
    laneUsage,
    jackCount,
    meanLaneDelta: deltaN > 0 ? deltaSum / deltaN : 0,
    collapsed: laneUsage.some((u) => u > 0.5),
  }
}
