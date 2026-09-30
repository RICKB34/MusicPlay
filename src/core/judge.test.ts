/**
 * 长按判定的验证。
 *
 * 判定层此前没有任何测试，而长按的生命周期（按下 → 按住 → 松手/到点）
 * 恰好是最容易出错的地方：状态机会不会卡住游标、断触会不会被结算两次、
 * 一直按住不松时谁来收尾。
 *
 * 这里把整条生命周期的每个分叉都钉住。
 */

import { describe, expect, it } from 'vitest'
import { Judger, Scorer, gradeOf } from './judge'
import { DEFAULT_JUDGMENT, type Chart, type Note } from '../types'

function chart(notes: Note[]): Chart {
  return {
    version: 1,
    meta: {
      title: 'test',
      audioFingerprint: 'fp',
      durationMs: 10_000,
      bpm: 120,
      bpmConfidence: 0.9,
      gridOffsetMs: 0,
      subdivision: 2,
      source: 'auto',
    },
    columns: 4,
    difficulty: 'normal',
    notes,
  }
}

/** 1.0s 起、持续 2s —— 尾部落在 3.0s。 */
const HOLD: Note = { t: 1000, col: 0, type: 1, d: 2000 }
const TAIL = 3.0

describe('tap 判定', () => {
  it('按下即定局，没有 deferred 标记', () => {
    const j = new Judger(chart([{ t: 1000, col: 0, type: 0 }]))
    const e = j.handleInput(0, 1.0)

    expect(e).not.toBeNull()
    expect(e!.deferred).toBeUndefined()
    expect(e!.note.state).toBe('hit')
    expect(e!.judgment).toBe('perfect')
  })
})

describe('长按判定', () => {
  it('按下进入 holding，头部延后计分', () => {
    const j = new Judger(chart([HOLD]))
    const e = j.handleInput(0, 1.0)

    expect(e!.deferred).toBe(true)
    expect(e!.note.state).toBe('holding')
    // 头判的等级被记下来，等尾部结算时沿用
    expect(e!.note.holdGrade).toBe('perfect')
  })

  it('一直按住：尾部到点自动结算，沿用头判等级', () => {
    const j = new Judger(chart([HOLD]))
    j.handleInput(0, 1.0)

    // 还没到尾，什么都不该发生
    expect(j.settleHolds(2.5)).toHaveLength(0)

    const settled = j.settleHolds(TAIL)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.judgment).toBe('perfect')
    expect(settled[0]!.note.state).toBe('hit')
  })

  it('断触封顶为 good，而不是 miss', () => {
    const j = new Judger(chart([HOLD]))
    j.handleInput(0, 1.0) // 头判 perfect

    // 1.5s 就松手，离尾部还差 1.5s —— 远超 holdReleaseMs
    const out = j.handleRelease(0, 1.5)

    expect(out).toHaveLength(1)
    // 玩家确实按住了头也按住了一段，不该否定掉已完成的部分
    expect(out[0]!.judgment).toBe('good')
    expect(out[0]!.note.state).toBe('hit')
  })

  it('断触之后不会被 settleHolds 结算第二次', () => {
    const j = new Judger(chart([HOLD]))
    j.handleInput(0, 1.0)
    j.handleRelease(0, 1.5)

    // 状态已经定局，尾部到点时不该再出一次判定（否则一个音符算两分）
    expect(j.settleHolds(3.5)).toHaveLength(0)
  })

  it('尾部容差内松手算完成，沿用头判等级', () => {
    const j = new Judger(chart([HOLD]))
    j.handleInput(0, 1.0)

    const out = j.handleRelease(0, 2.9) // 距尾部 100ms，在容差内

    expect(out).toHaveLength(1)
    expect(out[0]!.judgment).toBe('perfect')
  })

  it('容差边界：卡在 holdReleaseMs 两侧判定相反', () => {
    // cutoff = 松手时刻 + holdReleaseMs >= tailSec 才算完成
    const limit = TAIL - DEFAULT_JUDGMENT.holdReleaseMs / 1000 // 距尾部正好 holdReleaseMs

    const inside = new Judger(chart([HOLD]))
    inside.handleInput(0, 1.0)
    expect(inside.handleRelease(0, limit)[0]!.judgment).toBe('perfect')

    const outside = new Judger(chart([HOLD]))
    outside.handleInput(0, 1.0)
    expect(outside.handleRelease(0, limit - 0.01)[0]!.judgment).toBe('good')
  })

  it('长按之后的音符仍能被判定——游标要在 holding 处停住而不是越过', () => {
    const j = new Judger(
      chart([
        HOLD, // tail 3.0s
        { t: 1500, col: 1, type: 0 }, // 长按期间的另一条轨
      ]),
    )
    j.handleInput(0, 1.0) // 长按进入 holding

    const e = j.handleInput(1, 1.5)
    expect(e).not.toBeNull()
    expect(e!.judgment).toBe('perfect')
    expect(e!.note.note.col).toBe(1)
  })

  it('头部已过判定窗的长按不会被漏判扫描误伤', () => {
    const j = new Judger(chart([HOLD]))
    j.handleInput(0, 1.0) // 头部命中，进入 holding

    // 按住期间扫漏判：holding 不是 pending，不该被标 miss
    expect(j.scanMisses(2.0)).toHaveLength(0)
  })

  it('完全不按的长按会被扫成 miss', () => {
    const j = new Judger(chart([HOLD]))
    const missed = j.scanMisses(2.0) // 头部窗口早过了
    expect(missed).toHaveLength(1)
    expect(missed[0]!.judgment).toBe('miss')
  })
})

describe('Scorer —— 满分 10000 的判定权重计分', () => {
  it('全 PERFECT = 10000 分（即使满分不能被音符数整除）', () => {
    const s = new Scorer(3)
    s.apply('perfect')
    s.apply('perfect')
    s.apply('perfect')

    const snap = s.snapshot()
    expect(snap.score).toBe(10000)
    expect(snap.accuracy).toBe(1)
    expect(snap.counts).toEqual({ perfect: 3, great: 0, good: 0, miss: 0 })
  })

  it('PERFECT/GREAT/GOOD 分别按 1 / 0.8 / 0.6 倍计分', () => {
    const s = new Scorer(3)
    s.apply('perfect')
    s.apply('great')
    s.apply('good')

    const snap = s.snapshot()
    // (1 + 0.8 + 0.6) / 3 × 10000 = 8000
    expect(snap.score).toBe(8000)
    expect(snap.accuracy).toBe(1)
    expect(snap.counts).toEqual({ perfect: 1, great: 1, good: 1, miss: 0 })
  })

  it('全 GREAT = 8000 分，全 GOOD = 6000 分', () => {
    const greats = new Scorer(5)
    const goods = new Scorer(5)
    for (let i = 0; i < 5; i++) {
      greats.apply('great')
      goods.apply('good')
    }

    expect(greats.snapshot().score).toBe(8000)
    expect(goods.snapshot().score).toBe(6000)
  })

  it('MISS 不得分但计入命中率分母', () => {
    const s = new Scorer(4)
    s.apply('perfect')
    s.apply('perfect')
    s.apply('miss')
    s.apply('perfect')

    const snap = s.snapshot()
    expect(snap.score).toBe(7500)
    expect(snap.combo).toBe(1)
    expect(snap.maxCombo).toBe(2)
    expect(snap.accuracy).toBeCloseTo(0.75, 6)
  })

  it('连击不影响得分——同样判定，无论是否断连，分数相同', () => {
    const a = new Scorer(5)
    a.apply('perfect')
    a.apply('perfect')
    a.apply('perfect')
    a.apply('perfect')
    a.apply('miss')

    const b = new Scorer(5)
    b.apply('perfect')
    b.apply('miss')
    b.apply('perfect')
    b.apply('perfect')
    b.apply('perfect')

    // 都是 4 PERFECT + 1 MISS → 10000 × 4/5 = 8000，与连击无关
    expect(a.snapshot().score).toBe(8000)
    expect(b.snapshot().score).toBe(8000)
    // 但连击确实不同（说明分数只看命中，不看连击）
    expect(a.snapshot().maxCombo).toBe(4)
    expect(b.snapshot().maxCombo).toBe(3)
  })
})

describe('gradeOf —— 按总分评级', () => {
  it('满分 P，9000/8000/7000/6000 分档 S/A/B/C，6000 以下 D', () => {
    expect(gradeOf(10000)).toBe('P')
    expect(gradeOf(9999)).toBe('S')
    expect(gradeOf(9000)).toBe('S')
    expect(gradeOf(8999)).toBe('A')
    expect(gradeOf(8000)).toBe('A')
    expect(gradeOf(7999)).toBe('B')
    expect(gradeOf(7000)).toBe('B')
    expect(gradeOf(6999)).toBe('C')
    expect(gradeOf(6000)).toBe('C')
    expect(gradeOf(5999)).toBe('D')
    expect(gradeOf(0)).toBe('D')
  })
})
