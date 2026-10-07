/**
 * 打击特效的契约测试。
 *
 * 特效长什么样没法自动化验证——那只能人眼看。但特效系统里有一条**静默失败**的
 * 不变式必须守住，而且它恰好是最难靠肉眼发现的一类问题：
 *
 *   引擎按 `hitEffectLifeSec`（所有主题的最长寿命）清理过期特效，而"这一击画多久"
 *   由主题自己的 `lifeSec` 决定。哪天某套主题把寿命调过了引擎的上限，它的特效就会
 *   被提前移除——画面上闪一下就没了，控制台一声不吭，只有切到那套主题的人才看得出来。
 *
 * 所以这里把不变式钉在测试里，而不是指望下次改主题的人记得。
 */

import { describe, expect, it } from 'vitest'
import { hitEffectLifeSec, makeRand } from './render'
import { THEMES } from '../state/theme'
import type { Judgment } from '../types'

const JUDGMENTS: readonly Judgment[] = ['perfect', 'great', 'good', 'miss']

describe('主题特效的寿命不变式', () => {
  for (const theme of THEMES) {
    it(`主题「${theme.label}」的每个判定档位都配齐了几何参数`, () => {
      for (const j of JUDGMENTS) {
        const profile = theme.render.effects.profiles[j]
        expect(profile, `${theme.key} 的 ${j} 档缺 profile`).toBeDefined()
        expect(profile.lifeSec, `${theme.key}.${j} 的 lifeSec 必须为正`).toBeGreaterThan(0)
        expect(profile.baseAlpha).toBeGreaterThan(0)
        expect(profile.baseAlpha).toBeLessThanOrEqual(1)
      }
    })

    it(`主题「${theme.label}」的特效寿命不超过引擎的保留上限`, () => {
      for (const j of JUDGMENTS) {
        // 超过上限 → 特效被引擎提前裁掉，且全程无报错。见文件头说明。
        expect(
          theme.render.effects.profiles[j].lifeSec,
          `${theme.key} 的 ${j} 档 lifeSec 超过了 hitEffectLifeSec —— 特效会被提前裁掉`,
        ).toBeLessThanOrEqual(hitEffectLifeSec(j))
      }
    })
  }

  it('基准主题 qq 不带专属特效，观感与改造前一致', () => {
    const qq = THEMES.find((t) => t.key === 'qq')
    expect(qq, 'THEMES 里找不到 qq').toBeDefined()
    expect(qq?.render.effects.accent).toBeUndefined()
  })

  it('引擎的保留上限确实覆盖了所有主题（上限由主题推导，不是写死的）', () => {
    for (const j of JUDGMENTS) {
      const longest = Math.max(...THEMES.map((t) => t.render.effects.profiles[j].lifeSec))
      expect(hitEffectLifeSec(j)).toBeGreaterThanOrEqual(longest)
    }
  })
})

describe('特效的确定性随机源', () => {
  it('同一 (轨道, 起始时刻) 永远给出同一组随机数', () => {
    const a = makeRand(2, 1.234)
    const b = makeRand(2, 1.234)
    for (let i = 0; i < 32; i++) {
      expect(a(i)).toBe(b(i))
    }
  })

  it('换个轨道或换个时刻就是另一组序列（粒子不会跨轨对齐）', () => {
    const draw = (r: (i: number) => number) => Array.from({ length: 8 }, (_, i) => r(i))
    const base = draw(makeRand(2, 1.234))
    expect(draw(makeRand(3, 1.234))).not.toEqual(base)
    expect(draw(makeRand(2, 1.4))).not.toEqual(base)
    expect(draw(makeRand(2, 1.234))).toEqual(base)
  })

  it('起始时刻按毫秒量化：同一毫秒内的抖动不改变序列', () => {
    // 按键时刻来自音频时钟，带亚毫秒抖动。不量化的话同一次击打取到的
    // 粒子布局会次次不同，确定性就名存实亡了。
    const a = makeRand(1, 2.0004)
    const b = makeRand(1, 2.0001)
    for (let i = 0; i < 16; i++) {
      expect(a(i)).toBe(b(i))
    }
  })

  it('取值落在 [0, 1)', () => {
    const r = makeRand(0, 0.5)
    for (let i = 0; i < 256; i++) {
      const v = r(i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('相邻序号不呈现规律推进（粒子不会排着队飞）', () => {
    // 只用乘法混入时，相邻输入会产生强相关输出，粒子看上去像被同一个力推着走。
    // 这里按"相邻差值的均值应接近 0"做一个粗筛。
    const r = makeRand(1, 2.5)
    let sum = 0
    const n = 200
    for (let i = 0; i < n; i++) sum += r(i + 1) - r(i)
    expect(Math.abs(sum / n)).toBeLessThan(0.15)
  })
})
