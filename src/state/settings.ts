/**
 * 玩家设置的持久化。
 *
 * 全部走 localStorage —— 需要长期保存的只有几个标量。
 * 分析结果与谱面缓存将来走 IndexedDB（可能几十 MB），那是另一回事。
 */

import type { Difficulty } from '../types'
import { DEFAULT_THEME_KEY, normalizeThemeKey, type ThemeKey } from './theme'

export interface Settings {
  /** 用户延迟校准偏置（毫秒）。正数表示玩家偏慢。 */
  userOffsetMs: number
  /** 音符从出现到判定线的时长（毫秒）。越小越难。 */
  approachMs: number
  /** 轨道数。 */
  columns: 4 | 6
  /** 上次选择的难度。 */
  difficulty: Difficulty
  /** 是否显示判定偏差数值（调试用）。 */
  showDelta: boolean
  /** 分析档位。移动端卡顿时降到 fast 或 demo。 */
  analysisProfile: 'fast' | 'balanced' | 'precise' | 'demo'
  /**
   * 视觉主题。默认 QQ 音乐风（这是给 QQ 音乐的 demo），赛博风为可选项。
   * 同时影响 DOM 样式与游戏画布，见 `theme.ts`。
   */
  theme: ThemeKey
}

export const DEFAULT_SETTINGS: Settings = {
  userOffsetMs: 0,
  approachMs: 900,
  columns: 4,
  difficulty: 'normal',
  showDelta: false,
  analysisProfile: 'balanced',
  theme: DEFAULT_THEME_KEY,
}

const KEY = 'rhythm-forge:settings:v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings> & { chartSource?: unknown }
    delete parsed.chartSource
    // 逐字段回落，避免旧版本存档缺字段导致 undefined 扩散。
    // theme 额外做一次收敛：它会被直接写进 <html data-theme>，脏值不能放行。
    return { ...DEFAULT_SETTINGS, ...parsed, theme: normalizeThemeKey(parsed.theme) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // 隐私模式下 localStorage 可能不可写，静默失败即可
  }
}

/**
 * 首次使用时的延迟估计。
 *
 * 用 `baseLatency + outputLatency` 作为初值。典型值参考：
 *   桌面有线键盘 + 音箱  → 0-30ms
 *   蓝牙耳机            → 80-200ms
 *   手机触摸            → 30-80ms
 * 这只是初值，玩家仍应在校准页跑一遍——校准能一次性吸收
 * 音频输出 + 输入采样 + 显示 + 个人反应偏置的总和。
 */
export function estimateInitialOffsetMs(ctx: AudioContext): number {
  const c = ctx as AudioContext & { outputLatency?: number }
  const total = (c.outputLatency ?? 0) + (ctx.baseLatency ?? 0)
  return Math.round(total * 1000)
}
