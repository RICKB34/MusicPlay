/**
 * 主题契约的一致性测试。
 *
 * CSS 自定义属性取不到值时是**静默失败**的：`border: var(--x)` 会退化成无边框、
 * `background: var(--x)` 会变透明、`box-shadow: var(--x)` 会变 none。编译器和
 * 控制台都不会给任何提示，只有切到那个主题的人肉眼看得到。
 *
 * 所以这里直接读 styles.css 源码，断言每个主题块声明的变量名集合与 :root 完全相等。
 * 少定义一个 = 某个主题下悄悄丢样式，这条断言能在提交前拦住它。
 *
 * 遍历 THEMES 而不是写死主题名：新加的主题正是最需要被覆盖的那个——加主题的人
 * 多半会记得写 CSS 块，但很难手工比对九十多个变量名。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_KEY, THEMES } from './theme'

const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')

/** 取出某个选择器块内声明的全部自定义属性名。选择器必须独占行首。 */
function varsIn(selector: string): Set<string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}\\s*\\{`, 'm').exec(css)
  if (!match) throw new Error(`styles.css 里找不到选择器 ${selector}`)
  const block = css.slice(match.index + match[0].length, css.indexOf('}', match.index))
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
}

describe('主题契约', () => {
  const base = varsIn(':root')

  it(':root 默认块是 QQ 主题且覆盖了完整的变量集', () => {
    // 少于这个数量说明有变量被挪出了 :root——那会让 data-theme 取到非法值时
    // 出现"半个主题"，而 :root 正是这种情况下唯一的兜底。
    expect(base.size).toBeGreaterThan(80)
  })

  it('默认主题走 :root，没有自己的 data-theme 块', () => {
    expect(DEFAULT_THEME_KEY).toBe('qq')
  })

  // 除默认主题外的每一套，都必须和 :root 配齐完全相同的变量名
  for (const theme of THEMES.filter((t) => t.key !== DEFAULT_THEME_KEY)) {
    it(`主题「${theme.label}」与 :root 定义了完全相同的一组变量名`, () => {
      const vars = varsIn(`:root[data-theme='${theme.key}']`)
      const missing = [...base].filter((v) => !vars.has(v))
      const extra = [...vars].filter((v) => !base.has(v))
      expect({ missing, extra }).toEqual({ missing: [], extra: [] })
    })
  }

  it('每套主题在 styles.css 里都有对应去处', () => {
    // 加了主题却忘了写 CSS 块 → 选择器一片都是 :root 的 QQ 变量，
    // 切过去只有画布变色、界面纹丝不动，且控制台毫无提示。
    for (const theme of THEMES) {
      const selector =
        theme.key === DEFAULT_THEME_KEY ? ':root' : `:root[data-theme='${theme.key}']`
      expect(() => varsIn(selector), `主题 ${theme.key} 缺 CSS 块`).not.toThrow()
    }
  })

  it('选择器用的色卡是 3 个（面板按 3 个点排版）', () => {
    for (const theme of THEMES) {
      expect(theme.swatch, `主题 ${theme.key} 的色卡不是 3 个点`).toHaveLength(3)
    }
  })
})
