/**
 * Canvas 2D 渲染。
 *
 * 为什么不用 Pixi.js：4-6 轨同屏最多百来个矩形，Canvas 2D 每秒能画几千个
 * 矩形，远未触及性能瓶颈。而音游真正的瓶颈是**时序精度**，不是填充率，
 * Pixi 优化的是后者，对本项目零收益。引入它反而要花 1 天集成 + 踩坑。
 *
 * 两条铁律：
 *   1. 音符位置**必须由 songTime 纯函数算出**，绝不能按帧累加——累加会漂移，
 *      跑几分钟后音符和音乐就对不上了。
 *   2. 速度用「接近时长」而非「每秒像素」定义，这样任何分辨率/屏幕比例下手感一致。
 */

import type { RuntimeNote } from './judge'
import { NOTE_HOLD, type Judgment } from '../types'

export interface RenderTheme {
  background: string
  laneBg: string
  laneBgAlt: string
  laneLine: string
  judgeLine: string
  noteFill: string
  noteBorder: string
  /** 长按尾杆的静态颜色。 */
  noteHold: string
  /** 长按头部填充，与 tap 区分开。 */
  noteHoldFill: string
  noteHoldBorder: string
  /** 正在被按住的长按尾杆。比 noteHold 亮，给出"确实按住了"的即时反馈。 */
  noteHoldActive: string
  laneGlow: string
  /** 判定线上未按下的轨道落点块。 */
  laneIdle: string
  textPrimary: string
  textDim: string
  /** 暂停时盖住画面的遮罩。必须与 textPrimary 有足够的反差，否则暂停文字读不出来。 */
  pauseScrim: string
  /** canvas 内文字的字体族。DOM 用 --font-ui，这里必须跟着主题走，否则两套字体。 */
  fontFamily: string
  /** 打击特效颜色。 */
  judgment: Record<Judgment, string>
}

/**
 * QQ 音乐主题：白底 + 品牌绿 #31c27c。
 *
 * 注意 #31c27c 的亮度偏高（L≈0.41），在白底上做**文字**只有 2.3:1，读不出来。
 * 所以品牌绿只用在音符、判定线这类大色块上，HUD 文字一律用深灰。
 *
 * 本对象与 src/styles.css 的 `:root` 主题块是一对，改色时两边要一起改。
 */
export const QQ_THEME: RenderTheme = {
  background: '#ffffff',
  laneBg: '#ffffff',
  laneBgAlt: '#f7f8fa',
  laneLine: 'rgba(0,0,0,0.06)',
  judgeLine: '#31c27c',
  noteFill: '#31c27c',
  noteBorder: 'rgba(0,0,0,0.10)',
  noteHold: 'rgba(49,194,124,0.28)',
  noteHoldFill: '#1fa76a',
  noteHoldBorder: 'rgba(0,0,0,0.10)',
  noteHoldActive: 'rgba(49,194,124,0.95)',
  laneGlow: 'rgba(49,194,124,0.16)',
  laneIdle: 'rgba(0,0,0,0.12)',
  textPrimary: '#1a1a1a',
  textDim: 'rgba(0,0,0,0.45)',
  pauseScrim: 'rgba(255,255,255,0.88)',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  judgment: {
    perfect: '#31c27c',
    great: '#0a7f4d',
    good: '#8a8f99',
    miss: '#d93025',
  },
}

/**
 * 赛博主题（Acid Graphics）：纯黑底 + 荧光色，音符用黑描边做出硬边质感。
 *
 * 本对象与 src/styles.css 的 `[data-theme='acid']` 主题块是一对，改色时两边要一起改。
 */
export const ACID_THEME: RenderTheme = {
  background: '#0a0a0a',
  laneBg: '#111111',
  laneBgAlt: '#161616',
  laneLine: 'rgba(57,255,20,0.08)',
  judgeLine: '#e6ff00',
  noteFill: '#39ff14',
  noteBorder: 'rgba(10,10,10,0.85)',
  noteHold: 'rgba(160,32,240,0.45)',
  noteHoldFill: '#a020f0',
  noteHoldBorder: 'rgba(10,10,10,0.9)',
  // 按住时翻成赛博粉，给出"确实按住了"的瞬时反差
  noteHoldActive: 'rgba(255,110,199,0.95)',
  laneGlow: 'rgba(57,255,20,0.28)',
  laneIdle: 'rgba(57,255,20,0.22)',
  textPrimary: '#39ff14',
  textDim: 'rgba(57,255,20,0.6)',
  pauseScrim: 'rgba(0,0,0,0.72)',
  fontFamily: 'ui-monospace, monospace',
  judgment: {
    perfect: '#39ff14',
    great: '#e6ff00',
    good: '#00ffff',
    miss: '#ff6ec7',
  },
}

/**
 * 粘土拟态主题（Claymorphism）：奶油粉底 + 糖果色音符，圆润柔软。
 *
 * 与另外两套的关键差别是**对比来源反过来了**：QQ 是白底绿块、赛博是黑底荧光，
 * 两者都靠高饱和色块在低亮度背景上跳出来；粘土主题的背景本身是浅粉，音符再用
 * 浅粉就糊成一片。所以这里音符用中饱和的 pink-400/500 压深，轨道底用接近白的
 * #fff7fb —— 靠**明度差**而不是色相差把音符托起来。
 *
 * 画布画不出内外阴影（那是 DOM 的 box-shadow 干的活），所以粘土感由 DOM 那半边
 * 承担，这里只负责配色与字体不打架。文字用 pink-900/800，在浅粉底上是 7:1 以上。
 *
 * 本对象与 src/styles.css 的 `[data-theme='clay']` 主题块是一对，改色时两边要一起改。
 */
export const CLAY_THEME: RenderTheme = {
  background: '#fdf2f8',
  laneBg: '#fff7fb',
  laneBgAlt: '#fce7f3',
  laneLine: 'rgba(190,24,93,0.10)',
  judgeLine: '#f472b6',
  noteFill: '#f472b6',
  noteBorder: 'rgba(190,24,93,0.28)',
  noteHold: 'rgba(244,114,182,0.35)',
  noteHoldFill: '#ec4899',
  noteHoldBorder: 'rgba(190,24,93,0.30)',
  // 按住时翻成莓紫，和粉色的长按头拉开明度差
  noteHoldActive: 'rgba(168,85,247,0.92)',
  laneGlow: 'rgba(244,114,182,0.22)',
  laneIdle: 'rgba(131,24,67,0.16)',
  textPrimary: '#831843',
  textDim: 'rgba(131,24,67,0.62)',
  pauseScrim: 'rgba(253,242,248,0.90)',
  fontFamily: "ui-rounded, 'Varela Round', 'Quicksand', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  judgment: {
    perfect: '#db2777',
    great: '#a855f7',
    good: '#b45309',
    miss: '#dc2626',
  },
}

/**
 * 霓虹复古主题（Vaporwave）：深紫底 + 粉青双色霓虹。
 *
 * 画布这边最要紧的是**音符本身要体现双色重影**——这是蒸汽波的辨识点，
 * 而 canvas 画不出发光（box-shadow 是 DOM 的活）。所以改用描边做重影：
 * 霓虹粉的音符 + 青色描边，一个色块上同时出现两个霓虹色，等价于 DOM 那边的
 * "粉光晕 + 青偏移"。
 *
 * 判定线取青色而非粉色，是为了和粉色音符拉开——这套主题整屏都是粉的时候，
 * 音游最需要的"音符在哪里、判定线在哪里"会糊掉。
 *
 * 本对象与 src/styles.css 的 `[data-theme='vapor']` 主题块是一对，改色时两边要一起改。
 */
export const VAPORWAVE_THEME: RenderTheme = {
  background: '#1a0a2e',
  laneBg: '#22103c',
  laneBgAlt: '#2a1048',
  laneLine: 'rgba(255,113,206,0.12)',
  judgeLine: '#01cdfe',
  noteFill: '#ff71ce',
  noteBorder: 'rgba(1,205,254,0.85)',
  noteHold: 'rgba(185,103,255,0.45)',
  noteHoldFill: '#b967ff',
  noteHoldBorder: 'rgba(1,205,254,0.7)',
  // 按住时翻成霓虹绿，和粉/紫都能拉开
  noteHoldActive: 'rgba(5,255,161,0.92)',
  laneGlow: 'rgba(255,113,206,0.28)',
  laneIdle: 'rgba(1,205,254,0.22)',
  textPrimary: '#ff71ce',
  textDim: 'rgba(185,103,255,0.85)',
  pauseScrim: 'rgba(18,8,34,0.88)',
  fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, 'Sarasa Mono SC', 'Microsoft YaHei', monospace",
  judgment: {
    perfect: '#05ffa1',
    great: '#01cdfe',
    good: '#fffb96',
    miss: '#ff5f7e',
  },
}

/**
 * 像素艺术风（Pixel Art）：PICO-8 调色板 + 硬边阴影 + 零圆角，浅色底。
 *
 * 画布这边靠**高饱和纯色 + 深色描边**造像素块感——canvas 画不出硬边偏移阴影
 * 那种"左上亮、右下投影"的立体，但粗描边 + 纯色块在浅底上已经足够像 8-bit 精灵。
 * 判定线取 PICO-8 的蓝而非红：音符是红的，判定线再用红就分不出谁是谁。
 *
 * 本对象与 src/styles.css 的 `[data-theme='pixel']` 主题块是一对，改色时两边要一起改。
 */
export const PIXEL_THEME: RenderTheme = {
  background: '#f4f4f4',
  laneBg: '#ffffff',
  laneBgAlt: '#e8e8e8',
  laneLine: 'rgba(26,28,44,0.14)',
  judgeLine: '#29adff',
  noteFill: '#ff004d',
  noteBorder: '#1a1c2c',
  noteHold: 'rgba(126,37,83,0.35)',
  noteHoldFill: '#7e2553',
  noteHoldBorder: '#1a1c2c',
  noteHoldActive: 'rgba(0,228,54,0.9)',
  laneGlow: 'rgba(41,173,255,0.20)',
  laneIdle: 'rgba(26,28,44,0.22)',
  textPrimary: '#1a1c2c',
  textDim: 'rgba(26,28,44,0.62)',
  pauseScrim: 'rgba(244,244,244,0.92)',
  fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, 'Sarasa Mono SC', 'Microsoft YaHei', monospace",
  judgment: {
    perfect: '#00e436',
    great: '#29adff',
    good: '#ffa300',
    miss: '#ff004d',
  },
}

/**
 * 水墨画风（Ink Wash）：宣纸底 + 墨色字 + 苔绿/茶褐点缀。
 *
 * 这套主题的风险是**整个画面糊成一片灰**——它本来就禁止高饱和色和重阴影，
 * 音游又需要音符在轨道上一眼可辨。所以音符取苔绿 #6b7b6e 而不是纯墨色：
 * 墨色留给文字和判定线，"有颜色的那一个"就是音符。长按头再压深一档到 #55634f，
 * 靠明度差而不是色相差区分 tap 与 hold。
 *
 * 本对象与 src/styles.css 的 `[data-theme='ink']` 主题块是一对，改色时两边要一起改。
 */
export const INK_THEME: RenderTheme = {
  background: '#f8f5f0',
  laneBg: '#fdfbf7',
  laneBgAlt: '#f3efe8',
  laneLine: 'rgba(44,44,44,0.09)',
  judgeLine: '#55634f',
  noteFill: '#6b7b6e',
  noteBorder: 'rgba(44,44,44,0.30)',
  noteHold: 'rgba(107,123,110,0.30)',
  noteHoldFill: '#55634f',
  noteHoldBorder: 'rgba(44,44,44,0.35)',
  noteHoldActive: 'rgba(44,44,44,0.85)',
  laneGlow: 'rgba(107,123,110,0.18)',
  laneIdle: 'rgba(44,44,44,0.16)',
  textPrimary: '#2c2c2c',
  textDim: 'rgba(44,44,44,0.6)',
  pauseScrim: 'rgba(248,245,240,0.92)',
  fontFamily: "Georgia, 'Songti SC', 'STSong', 'SimSun', 'Microsoft YaHei', serif",
  judgment: {
    perfect: '#55634f',
    great: '#6b7b6e',
    good: '#7d6b56',
    miss: '#8c3a2e',
  },
}

const JUDGMENT_LABELS: Record<Judgment, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
}

interface EffectProfile {
  lifeSec: number
  baseAlpha: number
  beamHeight: number
  laneGlowHeight: number
  ringCount: number
  spokeCount: number
  labelSize: number
  showLabel: boolean
}

const EFFECT_PROFILES: Record<Judgment, EffectProfile> = {
  perfect: {
    lifeSec: 0.62,
    baseAlpha: 0.95,
    beamHeight: 18,
    laneGlowHeight: 120,
    ringCount: 2,
    spokeCount: 8,
    labelSize: 13,
    showLabel: true,
  },
  great: {
    lifeSec: 0.46,
    baseAlpha: 0.78,
    beamHeight: 10,
    laneGlowHeight: 36,
    ringCount: 1,
    spokeCount: 4,
    labelSize: 11,
    showLabel: true,
  },
  good: {
    lifeSec: 0.3,
    baseAlpha: 0.48,
    beamHeight: 5,
    laneGlowHeight: 0,
    ringCount: 0,
    spokeCount: 0,
    labelSize: 9,
    showLabel: false,
  },
  miss: {
    lifeSec: 0.48,
    baseAlpha: 0.82,
    beamHeight: 0,
    laneGlowHeight: 0,
    ringCount: 0,
    spokeCount: 0,
    labelSize: 10,
    showLabel: false,
  },
}

export function hitEffectLifeSec(judgment: Judgment): number {
  return EFFECT_PROFILES[judgment].lifeSec
}

export interface HitEffect {
  lane: number
  judgment: Judgment
  /** 特效开始时刻（歌曲时间，秒）。 */
  startSec: number
}

export interface RenderState {
  songTimeSec: number
  notes: readonly RuntimeNote[]
  /** 音符从出现到抵达判定线的时长（秒）。越小越难。 */
  approachSec: number
  lanePressed: boolean[]
  combo: number
  score: number
  accuracy: number
  effects: readonly HitEffect[]
  /** 暂停时覆盖一层暗色遮罩。 */
  paused?: boolean
  /** 判定偏差显示（秒），用于调试手感。null 表示不显示。 */
  lastDeltaSec?: number | null
}

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly columns: number
  private theme: RenderTheme
  private cssWidth = 0
  private cssHeight = 0
  private dpr = 1

  constructor(canvas: HTMLCanvasElement, columns: number, theme: RenderTheme = QQ_THEME) {
    this.canvas = canvas
    this.columns = columns
    this.theme = theme
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文')
    this.ctx = ctx
    this.resize()
    // alpha:false 的上下文在首帧之前的内容是黑的（不透明上下文没有"透明"可言）。
    // 浅色主题下这会让开局闪一下黑，所以先按主题色铺一层底。
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight)
  }

  /**
   * 适配尺寸与高 DPI。
   *
   * DPR **上限取 2**：3x 手机上 Canvas 2D 的填充率会真的成为瓶颈，
   * 而音游画面并不需要 3x 的锐度——音符是大色块，不是细文字。
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const cssW = Math.max(1, rect.width)
    const cssH = Math.max(1, rect.height)
    const dpr = Math.min(2, window.devicePixelRatio || 1)

    if (cssW === this.cssWidth && cssH === this.cssHeight && dpr === this.dpr) return

    this.cssWidth = cssW
    this.cssHeight = cssH
    this.dpr = dpr
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 判定线的 y 坐标（CSS 像素）。放在 85% 处：下方留空间放 HUD，且避开手指遮挡。 */
  private get judgeLineY(): number {
    return this.cssHeight * 0.85
  }

  private get laneWidth(): number {
    return this.cssWidth / this.columns
  }

  render(state: RenderState): void {
    this.resize()
    const ctx = this.ctx
    const w = this.cssWidth
    const h = this.cssHeight

    ctx.fillStyle = this.theme.background
    ctx.fillRect(0, 0, w, h)

    this.drawLanes(state)
    this.drawNotes(state)
    this.drawJudgeLine(state)
    this.drawEffects(state)
    this.drawHud(state)

    if (state.paused) {
      ctx.fillStyle = this.theme.pauseScrim
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = this.theme.textPrimary
      ctx.textAlign = 'center'
      ctx.font = `600 28px ${this.theme.fontFamily}`
      ctx.fillText('已暂停', w / 2, h / 2 - 10)
      ctx.font = `400 15px ${this.theme.fontFamily}`
      ctx.fillStyle = this.theme.textDim
      ctx.fillText('按 Esc 或点击继续', w / 2, h / 2 + 22)
    }
  }

  private drawLanes(state: RenderState): void {
    const ctx = this.ctx
    const lw = this.laneWidth
    const h = this.cssHeight

    for (let i = 0; i < this.columns; i++) {
      const x = i * lw
      ctx.fillStyle = i % 2 === 0 ? this.theme.laneBg : this.theme.laneBgAlt
      ctx.fillRect(x, 0, lw, h)

      if (state.lanePressed[i]) {
        ctx.fillStyle = this.theme.laneGlow
        ctx.fillRect(x, 0, lw, h)
      }

      if (i > 0) {
        ctx.strokeStyle = this.theme.laneLine
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
    }
  }

  private drawNotes(state: RenderState): void {
    const ctx = this.ctx
    const lw = this.laneWidth
    const judgeY = this.judgeLineY
    // 「接近时长」→ 像素速度：保证任意分辨率下手感一致
    const pxPerSec = judgeY / Math.max(0.05, state.approachSec)
    const noteH = Math.max(14, Math.min(30, lw * 0.32))
    const pad = Math.max(3, lw * 0.08)

    for (const rn of state.notes) {
      if (rn.state === 'hit' || rn.state === 'missed') continue

      const x = rn.note.col * lw + pad
      const wid = lw - pad * 2
      const isHold = rn.note.type === NOTE_HOLD && (rn.note.d ?? 0) > 0

      // ── 正在按住的长按：头部锁在判定线上，尾巴随时间被"吃掉" ──
      // 不能沿用普通音符的 y 公式——那会让头部继续往下飘出屏幕，
      // 玩家看不到自己正按着什么。
      if (rn.state === 'holding') {
        const remaining = rn.tailSec - state.songTimeSec
        if (remaining > 0) {
          const tailY = judgeY - remaining * pxPerSec
          ctx.fillStyle = this.theme.noteHoldActive
          ctx.fillRect(x, tailY, wid, judgeY - tailY)
        }
        continue
      }

      const dt = rn.timeSec - state.songTimeSec
      // 还没进入视野（上方）就跳过；已经越过判定线太多的也跳过
      if (dt > state.approachSec) continue

      const y = judgeY - dt * pxPerSec
      if (y < -noteH * 2 || y > this.cssHeight + noteH * 2) continue

      // 长按：先画尾杆。**与头部同宽**——两者拼起来才是一根完整的条；
      // 比头部窄的尾巴看起来像是接错了东西。
      if (isHold) {
        const durSec = (rn.note.d ?? 0) / 1000
        const tailY = y - durSec * pxPerSec
        ctx.fillStyle = this.theme.noteHold
        ctx.fillRect(x, tailY, wid, y - tailY)
      }

      // 直角块 —— Acid Graphics 不用圆角
      ctx.fillStyle = isHold ? this.theme.noteHoldFill : this.theme.noteFill
      ctx.fillRect(x, y - noteH / 2, wid, noteH)

      ctx.strokeStyle = isHold ? this.theme.noteHoldBorder : this.theme.noteBorder
      ctx.lineWidth = 1.5
      ctx.strokeRect(x, y - noteH / 2, wid, noteH)
    }
  }

  private drawJudgeLine(state: RenderState): void {
    const ctx = this.ctx
    const y = this.judgeLineY
    ctx.strokeStyle = this.theme.judgeLine
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(this.cssWidth, y)
    ctx.stroke()

    // 每条轨道在判定线上画一个小方块，让玩家看清落点
    const lw = this.laneWidth
    for (let i = 0; i < this.columns; i++) {
      const x = i * lw
      ctx.fillStyle = state.lanePressed[i] ? this.theme.noteFill : this.theme.laneIdle
      ctx.fillRect(x + lw * 0.18, y - 4, lw * 0.64, 8)
    }
  }

  private drawEffects(state: RenderState): void {
    const ctx = this.ctx
    const lw = this.laneWidth
    const judgeY = this.judgeLineY

    for (const fx of state.effects) {
      const age = state.songTimeSec - fx.startSec
      const profile = EFFECT_PROFILES[fx.judgment]
      const life = profile.lifeSec
      if (age < 0 || age > life) continue
      const t = age / life
      const eased = 1 - Math.pow(1 - t, 3)
      const alpha = (1 - t) * profile.baseAlpha
      const color = this.theme.judgment[fx.judgment]

      const x = fx.lane * lw
      const centerX = x + lw / 2

      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = color
      ctx.fillStyle = color

      if (fx.judgment === 'miss') {
        const reach = lw * (0.1 + eased * 0.12)
        ctx.globalAlpha = alpha
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(centerX - reach, judgeY - reach)
        ctx.lineTo(centerX + reach, judgeY + reach)
        ctx.moveTo(centerX + reach, judgeY - reach)
        ctx.lineTo(centerX - reach, judgeY + reach)
        ctx.stroke()
      } else {
        const expand = eased * lw * (0.18 + profile.ringCount * 0.12)

        if (profile.laneGlowHeight > 0) {
          const glowHeight = profile.laneGlowHeight * eased
          ctx.globalAlpha = alpha * (fx.judgment === 'perfect' ? 0.22 : 0.12)
          ctx.fillRect(x + 2, judgeY - glowHeight, lw - 4, glowHeight * 2)
        }

        ctx.globalAlpha = alpha
        ctx.fillRect(
          x + lw * 0.08 - expand / 2,
          judgeY - profile.beamHeight / 2,
          lw * 0.84 + expand,
          profile.beamHeight,
        )

        for (let ring = 0; ring < profile.ringCount; ring++) {
          const radius = lw * (0.06 + eased * (0.2 + ring * 0.1))
          ctx.globalAlpha = alpha * (1 - ring * 0.38)
          ctx.lineWidth = Math.max(1, (3 - ring) * (1 - t))
          ctx.beginPath()
          ctx.arc(centerX, judgeY, radius, 0, Math.PI * 2)
          ctx.stroke()
        }

        if (profile.spokeCount > 0) {
          const inner = lw * (0.08 + eased * 0.04)
          const outer = inner + lw * (0.08 + eased * 0.1)
          ctx.globalAlpha = alpha * 0.72
          ctx.lineWidth = fx.judgment === 'perfect' ? 2.2 : 1.5
          for (let spoke = 0; spoke < profile.spokeCount; spoke++) {
            const angle = (Math.PI * 2 * spoke) / profile.spokeCount - Math.PI / 2
            ctx.beginPath()
            ctx.moveTo(centerX + Math.cos(angle) * inner, judgeY + Math.sin(angle) * inner)
            ctx.lineTo(centerX + Math.cos(angle) * outer, judgeY + Math.sin(angle) * outer)
            ctx.stroke()
          }
        }

        if (profile.showLabel) {
          ctx.globalAlpha = alpha
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.font = `800 ${profile.labelSize}px ${this.theme.fontFamily}`
          ctx.fillText(
            JUDGMENT_LABELS[fx.judgment],
            centerX,
            judgeY - 30 - eased * 12,
          )
        }
      }

      ctx.globalAlpha = 1
      ctx.restore()
    }
  }

  private drawHud(state: RenderState): void {
    const ctx = this.ctx
    const w = this.cssWidth

    ctx.textAlign = 'left'
    ctx.fillStyle = this.theme.textPrimary
    ctx.font = `600 26px ${this.theme.fontFamily}`
    // 对战页顶部中央有对手分数与进度条；自己的 HUD 下移，避免窄屏互相遮挡。
    ctx.fillText(String(state.score).padStart(5, '0'), 16, 62)

    ctx.font = `400 13px ${this.theme.fontFamily}`
    ctx.fillStyle = this.theme.textDim
    ctx.fillText(`${(state.accuracy * 100).toFixed(2)}%`, 16, 82)

    // 连击：只在 2 以上显示，避免干扰
    if (state.combo >= 2) {
      ctx.textAlign = 'center'
      ctx.fillStyle = this.theme.textPrimary
      ctx.font = `700 34px ${this.theme.fontFamily}`
      ctx.fillText(String(state.combo), w / 2, this.cssHeight * 0.42)
      ctx.font = `500 12px ${this.theme.fontFamily}`
      ctx.fillStyle = this.theme.textDim
      ctx.fillText('COMBO', w / 2, this.cssHeight * 0.42 + 18)
    }

    // 判定偏差（调试用，校准时打开）
    if (state.lastDeltaSec != null) {
      ctx.textAlign = 'right'
      ctx.font = `400 13px ${this.theme.fontFamily}`
      ctx.fillStyle = this.theme.textDim
      ctx.fillText(`${(state.lastDeltaSec * 1000).toFixed(0)}ms`, w - 16, 38)
    }
  }
}

export { JUDGMENT_LABELS }
