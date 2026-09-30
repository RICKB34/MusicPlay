/**
 * 主题注册表。
 *
 * 六套主题：
 *   - qq    ：QQ 音乐风格（默认），白底 + 品牌绿 #31c27c，简约
 *   - acid  ：赛博风格（Acid Graphics），纯黑底 + 荧光色 + 直角硬阴影
 *   - clay  ：粘土拟态（Claymorphism），奶油粉底 + 超大圆角 + 内外阴影组合
 *   - vapor ：霓虹复古（Vaporwave），深紫底 + 粉青双色霓虹 + 网格线
 *   - pixel ：像素艺术风（Pixel Art），PICO-8 调色板 + 4px 粗边框 + 硬边阴影
 *   - ink   ：水墨画风（Ink Wash），宣纸底 + 墨色 + 细边框 + 大留白
 *
 * 主题的 DOM 那半边由 `<html data-theme>` + `src/styles.css` 的主题块驱动；
 * canvas 那半边需要真实颜色值，拿不到 CSS 变量（每帧读 getComputedStyle 会强制
 * 样式重算），所以在这里用 JS 对象提供。两边是一对，改色时**要一起改**。
 *
 * 加一套主题要动四处，缺一处就是半个主题：
 *   1. 这里（key / label / 说明 / 色卡 / 状态栏色）
 *   2. `core/render.ts` 的 RenderTheme 对象
 *   3. `styles.css` 的主题块（变量名要**逐一**配齐，见 theme.test.ts）
 *   4. 无——`normalizeThemeKey` 按 THEMES 自动收敛，不用改
 */

import {
  ACID_THEME,
  CLAY_THEME,
  INK_THEME,
  PIXEL_THEME,
  QQ_THEME,
  VAPORWAVE_THEME,
  type RenderTheme,
} from '../core/render'

export type ThemeKey = 'qq' | 'acid' | 'clay' | 'vapor' | 'pixel' | 'ink'

export interface ThemeDef {
  key: ThemeKey
  /** 选择器里显示的名字。 */
  label: string
  /** 一句话说明，展开面板里显示。 */
  description: string
  /**
   * 色卡：3-4 个能代表该主题的颜色，在选项里画成一排小圆点。
   * 让用户不用逐个切过去看就知道大概长什么样。
   */
  swatch: readonly string[]
  /** 移动端状态栏 / 浏览器地址栏颜色，同步给 <meta name="theme-color">。 */
  statusBar: string
  render: RenderTheme
}

export const THEMES: readonly ThemeDef[] = [
  {
    key: 'qq',
    label: 'QQ 音乐',
    description: '白底 + 品牌绿，界面与游戏画面统一。',
    swatch: ['#ffffff', '#31c27c', '#0a7f4d'],
    statusBar: '#31c27c',
    render: QQ_THEME,
  },
  {
    key: 'acid',
    label: '赛博',
    description: '纯黑底 + 荧光色，直角硬阴影与扫描线叠加。',
    swatch: ['#0a0a0a', '#39ff14', '#a020f0'],
    statusBar: '#0a0a0a',
    render: ACID_THEME,
  },
  {
    key: 'clay',
    label: '粘土拟态',
    description: '奶油粉底 + 超大圆角，内外阴影堆出软糯的 3D 立体感。',
    swatch: ['#fce7f3', '#f472b6', '#fde68a'],
    statusBar: '#fce7f3',
    render: CLAY_THEME,
  },
  {
    key: 'vapor',
    label: '霓虹复古',
    description: '深紫底 + 粉青双色霓虹，网格线与扫描线叠出 VHS 质感。',
    swatch: ['#1a0a2e', '#ff71ce', '#01cdfe'],
    statusBar: '#1a0a2e',
    render: VAPORWAVE_THEME,
  },
  {
    key: 'pixel',
    label: '像素艺术',
    description: 'PICO-8 调色板 + 4px 粗边框 + 硬边偏移阴影，零圆角零过渡。',
    swatch: ['#f4f4f4', '#ff004d', '#29adff'],
    statusBar: '#f4f4f4',
    render: PIXEL_THEME,
  },
  {
    key: 'ink',
    label: '水墨画风',
    description: '宣纸底 + 墨色字，细边框与 700ms 晕染，留白即设计。',
    swatch: ['#f8f5f0', '#2c2c2c', '#6b7b6e'],
    statusBar: '#f8f5f0',
    render: INK_THEME,
  },
]

export const DEFAULT_THEME_KEY: ThemeKey = 'qq'

/**
 * 把外部来源的值收敛成合法主题。
 *
 * `loadSettings()` 是 `{...DEFAULT, ...parsed}` 的浅合并、不校验字段，
 * 旧存档或手改过的 localStorage 都可能塞进任意字符串。非法值会让
 * `<html data-theme>` 落不到任何主题块上——好在 :root 兜底持有 QQ 全套变量，
 * 但仍然应该在入口处收敛掉。
 *
 * 按 THEMES 收敛而不是写死字面量：加主题时这里自动跟上，
 * 不会出现"新主题加进了列表、却因为忘了改这里而永远切不过去"。
 */
export function normalizeThemeKey(value: unknown): ThemeKey {
  return THEMES.some((t) => t.key === value) ? (value as ThemeKey) : DEFAULT_THEME_KEY
}

export function themeDefOf(key: ThemeKey): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]
}

export function renderThemeOf(key: ThemeKey): RenderTheme {
  return themeDefOf(key).render
}
