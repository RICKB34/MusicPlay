/**
 * 谱面序列化 —— 用于联机传输与本地缓存。
 *
 * 4 分钟的歌约 1200 个音符，JSON 后约 40KB，WebSocket 直接传毫无压力。
 * 不做二进制压缩：省下的那点带宽不值得引入编解码复杂度。
 */

import type { Chart, Note } from '../types'

export const CHART_VERSION = 1

export function serializeChart(chart: Chart): string {
  return JSON.stringify(chart)
}

export function deserializeChart(json: string): Chart {
  const raw = JSON.parse(json) as unknown
  return validateChart(raw)
}

/**
 * 校验并规范化谱面。
 *
 * 联机时会收到**对方**发来的谱面，属于不可信输入，必须校验——
 * 一个格式不对的谱面会让游戏在跑起来之后才崩，现场演示时非常难排查。
 */
export function validateChart(raw: unknown): Chart {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('谱面格式错误：不是对象')
  }
  const c = raw as Partial<Chart>

  if (c.version !== CHART_VERSION) {
    throw new Error(`谱面版本不匹配：期望 ${CHART_VERSION}，收到 ${c.version}`)
  }
  if (c.columns !== 4 && c.columns !== 6) {
    throw new Error(`非法轨道数：${c.columns}`)
  }
  if (!c.meta || typeof c.meta.audioFingerprint !== 'string') {
    throw new Error('谱面缺少音频指纹')
  }
  if (!Array.isArray(c.notes)) {
    throw new Error('谱面缺少 notes')
  }

  const notes: Note[] = c.notes.map((n, i) => {
    if (typeof n?.t !== 'number' || typeof n?.col !== 'number') {
      throw new Error(`第 ${i} 个音符格式错误`)
    }
    if (n.col < 0 || n.col >= (c.columns as number)) {
      throw new Error(`第 ${i} 个音符轨道越界：${n.col}`)
    }
    const note: Note = {
      t: Math.round(n.t),
      col: Math.round(n.col),
      type: n.type === 1 ? 1 : 0,
    }
    if (note.type === 1 && typeof n.d === 'number') note.d = Math.round(n.d)
    return note
  })

  // 音游内核假定 notes 按时间升序，这里强制保证——
  // 收到乱序谱面时自动修好，而不是让判定逻辑默默出错。
  notes.sort((a, b) => a.t - b.t || a.col - b.col)

  return {
    version: CHART_VERSION,
    meta: c.meta,
    columns: c.columns,
    difficulty: c.difficulty ?? 'normal',
    notes,
  }
}

/** 谱面统计，用于结果页与调试页展示。 */
export function chartStats(chart: Chart) {
  const notes = chart.notes
  const first = notes[0]?.t ?? 0
  const last = notes[notes.length - 1]?.t ?? 0
  const spanSec = Math.max(0.001, (last - first) / 1000)
  return {
    noteCount: notes.length,
    density: notes.length / spanSec,
    firstNoteMs: first,
    lastNoteMs: last,
  }
}
