/**
 * 全局类型定义 —— 被分析管线、谱面生成、游戏内核、网络层共享。
 *
 * 约定：
 *  - 分析管线内部一律用**秒**（浮点），与 Web Audio 的 currentTime 同单位。
 *  - 谱面（Chart）里一律用**整数毫秒**，便于 JSON 序列化与联机传输。
 *  - 两处单位不同是刻意的：分析要精度，谱面要可复现。
 */

// ─────────────────────────── 音频分析 ───────────────────────────

/** 一个起音（onset）事件，是谱面音符的原始素材。 */
export interface OnsetEvent {
  /** 起音时刻，秒（相对音频起点）。 */
  time: number
  /** 原始 spectral-flux 强度，未归一化。 */
  rawStrength: number
  /** 全曲归一化强度 [0,1]，用于难度分级与轨道分配。 */
  strength: number
  /** 谱质心（Hz），感知上的"音色明暗"。轨道分配的核心依据。 */
  centroid: number
  /** 低频段 20–250Hz 能量占比 [0,1]。底鼓检测。 */
  lowRatio: number
  /** 中频段 250–2000Hz 能量占比 [0,1]。 */
  midRatio: number
  /** 高频段 2000–8000Hz 能量占比 [0,1]。镲片检测。 */
  highRatio: number
  /**
   * 这个音延续了多久（毫秒）—— 长按判定的原料。
   *
   * 定义是"起音之后，**它自己所在的那个频段**的能量掉到起始值一半所用的时间"，
   * 不是全带能量（见 `onset.ts` 的 `measureSustainMs`）。
   *
   * 它只是给起音**多带一个字段**，不参与起音本身的拾取，所以现有谱面在
   * 不启用长按时逐字节不变。
   */
  sustainMs: number
}

/** 节拍网格细分。1=四分音 2=八分音 3=三连音 4=十六分音。 */
export type Subdivision = 1 | 2 | 3 | 4

/** 分析降级级别。数字越大越依赖兜底手段。 */
export type FallbackLevel =
  | 0 // 正常：库检测 + 自建网格自检通过
  | 1 // 倍频纠正：bpm 减半/加倍后取残差更小者
  | 2 // 纯起音自相关测速，放弃库的 bpm
  | 3 // 无网格模式：直接用 onset 时刻当音符
  | 4 // 手动兜底：用户在调试页拖 BPM / offset 滑块

export type AnalysisQuality = 'good' | 'degraded' | 'manual'

/** 分析质量自检结果，用于在 UI 上给出可信度提示。 */
export interface AnalysisDiagnostics {
  /** 所有 onset 量化残差的中位数（毫秒）。越小说明网格越贴合。 */
  medianResidualMs: number
  /** 残差在容差内的 onset 占比 [0,1]。 */
  withinToleranceRatio: number
  /** 综合质量判定。 */
  quality: AnalysisQuality
  /** 实际走到了降级链的哪一级。 */
  fallbackLevel: FallbackLevel
  /** 人类可读的诊断说明，直接显示在调试页。 */
  notes: string[]
}

/** 单曲分析完整产出。谱面生成的唯一输入。 */
export interface TrackAnalysis {
  /** 音频指纹：用于联机校验双方是否加载了同一个文件。 */
  fingerprint: string
  durationMs: number
  sampleRate: number
  /** 检测到的 BPM。 */
  bpm: number
  /** 测速置信度 [0,1]。低于 0.25 会触发降级链。 */
  bpmConfidence: number
  /** 拍点时刻数组（秒），相位已对齐。 */
  beats: number[]
  /** 第 0 拍时刻（秒），网格的相位基准。 */
  gridOffsetSec: number
  /** 网格细分：1=四分音, 2=八分音, 3=三连音, 4=十六分音。 */
  subdivision: 1 | 2 | 3 | 4
  onsets: OnsetEvent[]
  diagnostics: AnalysisDiagnostics
}

// ─────────────────────────── 谱面 ───────────────────────────

export type Difficulty = 'easy' | 'normal' | 'hard'

/** 音符类型。刻意用数字，对齐 Malody `.mc` 的紧凑表示。 */
export const NOTE_TAP = 0
export const NOTE_HOLD = 1

export interface Note {
  /** 音符到达判定线的时刻，整数毫秒。 */
  t: number
  /** 轨道索引，0 .. columns-1（0 在最左）。 */
  col: number
  /** 0 = tap, 1 = hold。 */
  type: 0 | 1
  /** hold 的持续时长（毫秒）。仅 type=1 时存在。 */
  d?: number
}

export interface ChartMeta {
  title: string
  audioFingerprint: string
  durationMs: number
  bpm: number
  bpmConfidence: number
  /** 第 0 拍时刻（毫秒）。 */
  gridOffsetMs: number
  subdivision: 1 | 2 | 3 | 4
  /** 自动生成，还是用户在调试页手工调过参数。 */
  source: 'auto' | 'manual-tuned'
}

/**
 * 谱面。刻意对齐 Malody `.mc` 的 `columns + notes(time, column, type)` 形状，
 * 熟悉音游谱面格式的人 5 分钟能上手。
 *
 * 确定性要求：同一份音频 + 同一难度 + 同一种子，必须生成**完全相同**的谱面，
 * 否则双人对战两人谱面不一致，功能直接失效。
 */
export interface Chart {
  version: 1
  meta: ChartMeta
  columns: 4 | 6
  difficulty: Difficulty
  /** 按 t 升序排列。 */
  notes: Note[]
}

// ─────────────────────────── 鼓点反馈 ───────────────────────────

/**
 * 一个鼓点 —— 从原曲的起音列表中筛出的击打时刻。
 *
 * 它和谱面是**两套独立的东西**，刻意解耦：
 *  - 谱面音符密度由难度决定；
 *  - 鼓点由音乐本身的打击乐特征决定。
 *
 * 所以鼓点只服务于氛围类反馈（震动 + 边框光晕），**绝不参与判定或计分**。
 * 玩家漏掉一个音符不该少一次震动，震动的节拍感来自音乐而不是操作。
 *
 * 时间单位是**秒**（与 Web Audio 时钟同单位），不是谱面的毫秒——
 * 它由音频分析产出、被音频时钟消费，全程不经过序列化。
 */
export interface DrumHit {
  /** 击打时刻，秒（相对音频起点）。 */
  t: number
  /** 归一化强度 [0,1]。用于调制震动时长与光晕亮度。 */
  strength: number
}

// ─────────────────────────── 判定与计分 ───────────────────────────

export type Judgment = 'perfect' | 'great' | 'good' | 'miss'

export interface JudgmentConfig {
  perfectMs: number
  greatMs: number
  goodMs: number
  /**
   * 长按松手的容差（毫秒）。
   *
   * 尾判问的是"有没有坚持住"，不是"按得准不准"，所以它比 `goodMs` 宽得多。
   * 松手时若离尾部还差得比这个远，就是断触并判 Miss。
   *
   * 135ms 是 `goodMs`(90) 的 **1.5 倍**，对齐 osu!mania ScoreV2/lazer 的尾判窗。
   * 历史：初版取 120ms（1.33×）实测偏严苛，放宽到 180ms（2×）后反馈"太松，
   * 差一截松手也判对，没有'必须按住到尾'的约束感"，于是收到 1.5× 这档中间带。
   */
  holdReleaseMs: number
}

export const DEFAULT_JUDGMENT: JudgmentConfig = {
  perfectMs: 25,
  greatMs: 50,
  goodMs: 90,
  holdReleaseMs: 135,
}

/**
 * 长按尾部之后至少要留出的间隔（毫秒），供玩家松手再按。
 *
 * 取值依据：松手容差（`holdReleaseMs` 135）与判定窗（`goodMs` 90）之和约 225ms，
 * 取 235 留一点余量。轨道分配用它算出"这条轨被长按占用到什么时候"，
 * 避免下一个音符卡在玩家还没松手的时刻。
 *
 * ⚠️ 它与 `holdReleaseMs` 是**耦合**的：放宽松手容差就必须同步放大它，
 * 否则会出现"玩家还在容差内可以松手，但同轨下一个音符已经落下来了"——
 * 那等于把长按尾判的宽容度从轨道分配那一侧又收回去了。
 */
export const HOLD_TAIL_MIN_GAP_MS = 235

// ─────────────────────────── 联机协议 ───────────────────────────

export interface ScoreSnapshot {
  score: number
  combo: number
  maxCombo: number
  accuracy: number
  /** 已打过的音符数，用于画进度条。 */
  progress: number
}

// ─────────────────────────── 音频来源抽象 ───────────────────────────

/**
 * 音频来源抽象 —— 当前只有"本地文件"一种实现。
 *
 * 保留这个接口是为了将来能挂上别的来源（例如桌面端用 tabCapture 抓取，
 * 或从 IndexedDB 缓存恢复）。核心分析管线只依赖 AudioBuffer，不关心它从哪来。
 */
export interface AudioSource {
  readonly kind: string
  /** 拿到可供播放与分析的 AudioBuffer。 */
  load(ctx: BaseAudioContext): Promise<AudioBuffer>
  /** 用于缓存与联机校验的稳定标识。 */
  fingerprint(): Promise<string>
}
