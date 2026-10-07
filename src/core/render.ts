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
// 现成的粒子贴图，来自 Kenney Particle Pack（CC0）。来源与许可见
// src/assets/effects/README.md
import inkBlotSrc from '../assets/effects/smoke_09.png'
import inkPuffSrc from '../assets/effects/smoke_05.png'
import inkWispSrc from '../assets/effects/smoke_01.png'
import moteStarSrc from '../assets/effects/star_05.png'

/** 单个判定档位的特效几何参数。 */
export interface EffectProfile {
  lifeSec: number
  baseAlpha: number
  /** 判定线上那条光束的高度。 */
  beamHeight: number
  /** 判定线中心向外扩的圆环个数。 */
  ringCount: number
  /** 环绕圆环的放射辐条数。 */
  spokeCount: number
  labelSize: number
  showLabel: boolean
}

/**
 * 一次命中的几何上下文，交给主题的专属绘制函数（`EffectStyle.accent`）。
 *
 * 里面的量都是绘制时现算好的，accent 只管往上画，不碰游戏状态。
 */
export interface EffectAccentContext {
  ctx: CanvasRenderingContext2D
  /** 单轨宽度（CSS 像素）。所有尺寸都该按它的比例取，别写死像素。 */
  laneWidth: number
  /** 轨道中心 x。 */
  centerX: number
  /** 判定线 y。 */
  judgeY: number
  /** 轨道左边缘 x。 */
  x: number
  judgment: Judgment
  /** 归一化年龄，0 → 1。 */
  t: number
  /** 缓出进度（1-(1-t)³）。做位移/扩散用这个，比 t 快。 */
  eased: number
  /** 透明度，已按档位算好。 */
  alpha: number
  /** 该判定的颜色。 */
  color: string
  /**
   * 确定性伪随机源，返回 [0,1)。
   *
   * **不能用 Math.random**：特效每帧都要重画一遍，随机量必须由
   * (轨道, 开始时刻, 序号) 唯一决定，否则粒子会逐帧乱跳；
   * 顺带也让特效可重现。
   */
  rand: (index: number) => number
}

/** 主题的专属绘制函数。 */
export type EffectAccentFn = (c: EffectAccentContext) => void

/**
 * 一套主题的打击特效风格。
 *
 * 拆两层是为了不重复：`profiles` 是每个判定档位的基础几何，所有主题走同一套
 * 绘制流程；`accent` 才是主题真正独有的那一笔。只加色不改形的主题留空即可。
 *
 * **尺寸规则（硬约束）**：特效扩散到最大时，外包络半径不得超过单轨宽度的一半
 * （`laneWidth / 2`）。越界就会漫进隔壁轨道，把正在下落的音符盖住。
 * 所有尺寸都按 `laneWidth` 的比例写；有偏移的元素按"距离 + 自身半径"核算。
 */
export interface EffectStyle {
  profiles: Record<Judgment, EffectProfile>
  /**
   * 专属点缀，画在基础几何之上，四个判定档位都会调用。
   *
   * 由工厂函数创建，因此可以闭包持有预渲染的资源（水墨的墨迹贴图就是这么来的）。
   * 但**绝不能在模块加载时创建 canvas**——测试跑在 node 环境里，一碰 document 就崩。
   * 懒加载的写法见 `inkShapes()`。
   */
  accent?: EffectAccentFn
  /**
   * miss 时是否照常画基础几何的那个 X 叉。默认 true。
   * 想让 miss 也带上主题味道（比如说水墨的败笔）的主题把它关掉，自己画。
   */
  baseMiss?: boolean
}

/**
 * 32 位整数混合 hash → [0,1)。
 *
 * 纯函数，不用 Math.random / Date.now，所以同一组输入永远得同一个值——
 * 这是特效可重现的前提（见 `EffectAccentContext.rand`）。
 */
function rand2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 为一次命中建立随机源，rand(i) ∈ [0,1)。
 *
 * 种子只由 (轨道, 起始毫秒) 决定，不含任何环境熵——所以同一次特效在任何一帧
 * 重画都得到同一组随机数，粒子不会逐帧乱跳。序号 i 参与哈希，而不是"推进同一个
 * 随机流"，这样 accent 可以任意顺序、任意子集地取随机数，互不影响。
 */
export function makeRand(lane: number, startSec: number): (index: number) => number {
  const seed = (lane * 8192 + Math.round(startSec * 1000)) | 0
  return (i: number) => rand2(seed, i + 1)
}

/* ────────────────────── 现成的粒子贴图 ────────────────────── */

/**
 * 贴图来自 Kenney Particle Pack（CC0，见 src/assets/effects/README.md）。
 *
 * 这些形状原先是用 fbm 噪声现生成的，但代码画出来的"墨"怎么调都像一团带毛边的圆。
 * 现成素材是一张一张画出来的，形态上直接赢。
 *
 * 原图是白色灰度的，运行时按主题色染一份再画 —— 所以同一张图既能当墨，也能当霓虹光晕。
 */
type EffectTextureKey = 'inkBlot' | 'inkPuff' | 'inkWisp' | 'mote'

const TEXTURE_SRC: Record<EffectTextureKey, string> = {
  inkBlot: inkBlotSrc,
  inkPuff: inkPuffSrc,
  inkWisp: inkWispSrc,
  mote: moteStarSrc,
}

/**
 * 贴图池，懒加载。
 *
 * 模块加载时**绝不能**碰 Image / document —— 测试跑在 node 环境里，一碰就崩。
 * 所以拖到第一次真要画特效时才建。加载是异步的，没就绪时 accent 直接跳过：
 * 一局刚开始的头几帧可能没特效，之后就有了，比阻塞首帧强。
 */
let texturePool: Record<EffectTextureKey, HTMLImageElement> | null = null

function textures(): Record<EffectTextureKey, HTMLImageElement> {
  if (!texturePool) {
    const made = {} as Record<EffectTextureKey, HTMLImageElement>
    for (const key of Object.keys(TEXTURE_SRC) as EffectTextureKey[]) {
      const img = new Image()
      img.src = TEXTURE_SRC[key]
      made[key] = img
    }
    texturePool = made
  }
  return texturePool
}

/** 贴图是否已经解码完、可以画了。 */
function ready(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0
}

/** 染色缓存：同一张图 + 同一个颜色只做一次。 */
const tintCache = new Map<string, Map<EffectTextureKey, HTMLCanvasElement>>()

/**
 * 把白色贴图染成指定颜色。
 *
 * 先画原图、再用 `source-in` 在同一片 alpha 上填色 —— 等于"保留形状、换掉颜色"。
 */
function tinted(key: EffectTextureKey, color: string): HTMLCanvasElement | null {
  const img = textures()[key]
  if (!ready(img)) return null

  let byColor = tintCache.get(color)
  if (!byColor) {
    byColor = new Map()
    tintCache.set(color, byColor)
  }
  const hit = byColor.get(key)
  if (hit) return hit

  const cv = document.createElement('canvas')
  cv.width = img.naturalWidth
  cv.height = img.naturalHeight
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, cv.width, cv.height)
  byColor.set(key, cv)
  return cv
}

/** 按中心点缩放绘制一张贴图（可旋转、可纵向压扁）。 */
function drawTex(
  ctx: CanvasRenderingContext2D,
  tex: CanvasImageSource,
  cx: number,
  cy: number,
  size: number,
  rotation = 0,
  squashY = 1,
): void {
  ctx.save()
  ctx.translate(cx, cy)
  if (rotation !== 0) ctx.rotate(rotation)
  ctx.drawImage(tex, -size / 2, (-size * squashY) / 2, size, size * squashY)
  ctx.restore()
}

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
  /** 打击特效风格：每个判定档位的几何参数 + 该主题独有的点缀。 */
  effects: EffectStyle
}

/**
 * 特效的基础几何：所有主题的起点，就是改造前那套全局唯一的参数。
 *
 * 个别主题会在此基础上微调（见 `profilesWith`），但形状语言保持一致——
 * 主题之间的差异主要在 `EffectStyle.accent`，不在这些数值。
 */
const BASE_PROFILES: Record<Judgment, EffectProfile> = {
  perfect: {
    lifeSec: 0.62,
    baseAlpha: 0.95,
    beamHeight: 14,
    ringCount: 2,
    spokeCount: 8,
    labelSize: 13,
    showLabel: true,
  },
  great: {
    lifeSec: 0.46,
    baseAlpha: 0.78,
    beamHeight: 8,
    ringCount: 1,
    spokeCount: 4,
    labelSize: 11,
    showLabel: true,
  },
  good: {
    lifeSec: 0.3,
    baseAlpha: 0.48,
    beamHeight: 4,
    ringCount: 0,
    spokeCount: 0,
    labelSize: 9,
    showLabel: true,
  },
  miss: {
    lifeSec: 0.48,
    baseAlpha: 0.82,
    beamHeight: 0,
    ringCount: 0,
    spokeCount: 0,
    labelSize: 10,
    showLabel: false,
  },
}

/** 从基础几何派生一套主题参数：只覆盖传进来的档位与字段。 */
function profilesWith(
  patch: Partial<Record<Judgment, Partial<EffectProfile>>>,
): Record<Judgment, EffectProfile> {
  const out = {} as Record<Judgment, EffectProfile>
  for (const j of ['perfect', 'great', 'good', 'miss'] as const) {
    out[j] = { ...BASE_PROFILES[j], ...patch[j] }
  }
  return out
}

/* ══════════════ 各主题的专属特效 ══════════════
 *
 * 每个 accent 只负责画「这一击最像这个主题的那一笔」。光束、轨道光晕、圆环、
 * 辐条、标签这些基础几何由 drawBaseEffect 统一画完，主题不重复实现——所以加
 * 一套主题只需要写一小段 accent，而不是整套绘制。
 *
 * 这些函数都是纯的：只读上下文、只往 canvas 上画，不碰游戏状态，也不缓存跨帧
 * 的东西。同一特效在任何一帧重画都得到同样的结果。
 *
 * 尺寸一律按 laneWidth 取比例。写死像素会在 4 轨/6 轨或不同分辨率下走形。
 */

/**
 * 赛博：粒子迸发 + 扫描线冲击。
 *
 * 关键在 `lighter`（加色混合）——荧光色只有叠加才亮得起来，用普通 source-over
 * 画的绿点看着像贴纸。粒子还带尾迹（画 t-Δt 到 t 的一条短线），运动感全靠它。
 */
function acidAccent(): EffectAccentFn {
  return (c) => {
    const { ctx, laneWidth: lw, x, centerX, judgeY, eased, alpha, color, rand, t } = c

    // 单颗粒子在某一时刻的位置。写成 tt 的函数，尾迹就是同一条曲线的两点连线——
    // 不需要给粒子存历史状态，"无状态"这条底线保住了。
    const count = 14
    const particleAt = (i: number, tt: number) => {
      const e = 1 - Math.pow(1 - tt, 3)
      const angle = -Math.PI / 2 + (i / (count - 1) - 0.5) * 2.4 + (rand(i) - 0.5) * 0.45
      const dist = lw * (0.1 + e * 0.35) * (0.5 + rand(i + 32) * 0.5)
      return {
        px: centerX + Math.cos(angle) * dist,
        // 抛物线：y 上额外加下坠，粒子才像被抛出去而不是匀速散开
        py: judgeY + Math.sin(angle) * dist + lw * 0.3 * tt * tt,
      }
    }

    ctx.globalCompositeOperation = 'lighter'

    // 打底的中心光：现成的星芒贴图，比径向渐变更"炸"、更有形态
    const glowTex = tinted('mote', color)
    if (glowTex) {
      ctx.globalAlpha = alpha * 0.6 * (1 - t)
      drawTex(ctx, glowTex, centerX, judgeY, lw * 1.0)
    }

    ctx.strokeStyle = color
    ctx.fillStyle = color
    for (let i = 0; i < count; i++) {
      const head = particleAt(i, t)
      const tail = particleAt(i, Math.max(0, t - 0.09))
      const size = Math.max(1.5, lw * 0.05 * (1 - t * 0.55))

      // 尾迹：加色混合下自然成一道光刃
      ctx.globalAlpha = alpha * 0.55
      ctx.lineWidth = size * 0.7
      ctx.beginPath()
      ctx.moveTo(tail.px, tail.py)
      ctx.lineTo(head.px, head.py)
      ctx.stroke()

      // 粒子本体：方块 —— 圆角在这套主题里是违和的
      ctx.globalAlpha = alpha * 0.95
      ctx.fillRect(head.px - size / 2, head.py - size / 2, size, size)
    }

    // 扫描线切片：呼应 DOM 那边的 --scanline
    for (let k = 0; k < 4; k++) {
      const rise = lw * (0.12 + k * 0.17) * (0.3 + eased)
      ctx.globalAlpha = alpha * 0.3
      ctx.fillRect(x + 2, judgeY - rise, lw - 4, Math.max(1, lw * 0.016))
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}

/**
 * 水墨：命中处洇开一团墨。
 *
 * 两层结构：
 *   ① 卫星墨点 —— 两三种烟形交错甩在旁边，位置/大小/旋转由确定性随机决定
 *   ② 主墨团   —— 直接用现成的烟雾贴图，边缘本来就是蓬的，不用自己画
 *
 * 墨色取判定色（perfect 是苔绿、miss 是朱红），所以好球坏球是两种颜色的墨。
 *
 * 贴图自身画布有透明边距、内容大约只占中间七成，所以这里的 size 是"贴图尺寸"，
 * 视觉上的墨团会小一圈 —— 调大小时按这个比例换算。
 */
function inkAccent(): EffectAccentFn {
  return (c) => {
    const { ctx, laneWidth: lw, centerX, judgeY, eased, alpha, color, rand, t } = c
    const blot = tinted('inkBlot', color)
    if (!blot) return // 贴图还没解码完，这一帧跳过

    // 墨在纸上是要洇开的：半径一路往外涨，浓度同时掉下来。
    // 用 0.7 系数而不是 1-t，是为了让墨迹比几何更"赖"一会儿。
    const fade = 1 - t * 0.7
    const spread = 0.45 + eased * 0.85

    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = color
    ctx.strokeStyle = color

    if (c.judgment === 'miss') {
      // 败笔：墨溅歪了 —— 一小团散在轨道外侧。
      // 不画 X 叉（主题把 baseMiss 关了），让"错"由墨本身说出来。
      const side = rand(3) < 0.5 ? -1 : 1
      ctx.globalAlpha = alpha * 0.75 * fade
      drawTex(
        ctx,
        blot,
        centerX + side * lw * 0.125,
        judgeY + lw * 0.1,
        lw * 0.69 * spread,
        rand(13) * Math.PI * 2,
      )

      return
    }

    // ① 卫星墨点先画，让主墨团压在上面
    const satellites: EffectTextureKey[] = ['inkWisp', 'inkPuff', 'inkWisp']
    for (let i = 0; i < satellites.length; i++) {
      const tex = tinted(satellites[i], color)
      if (!tex) continue
      const angle = rand(i + 40) * Math.PI * 2
      const dist = lw * 0.19 * spread * (0.4 + rand(i + 60) * 0.7)
      const size = lw * (0.225 + rand(i + 80) * 0.2) * spread
      ctx.globalAlpha = alpha * 0.4 * fade
      drawTex(
        ctx,
        tex,
        centerX + Math.cos(angle) * dist,
        // y 压到 0.66：宣纸上墨是横向洇得开的
        judgeY + Math.sin(angle) * dist * 0.66,
        size,
        rand(i + 100) * Math.PI * 2,
        0.72,
      )
    }

    // ② 主墨团
    ctx.globalAlpha = alpha * 0.85 * fade
    drawTex(ctx, blot, centerX, judgeY, lw * (0.69 + eased * 0.56), rand(9) * Math.PI * 2, 0.78)
  }
}

/**
 * 画一片樱花花瓣。
 *
 * 形状是樱花特有的：根部收成尖（连花心那头），外缘鼓圆，而**顶端有一个
 * 小小的 V 形缺口**——这个缺口是樱花和桃花、梅花区分开的地方，少了它
 * 就只是一片普通花瓣。
 */
function petalPath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath()
  ctx.moveTo(0, r)
  ctx.quadraticCurveTo(r * 0.95, r * 0.3, r * 0.8, -r * 0.55)
  ctx.quadraticCurveTo(r * 0.55, -r, 0, -r * 0.78)
  ctx.quadraticCurveTo(-r * 0.55, -r, -r * 0.8, -r * 0.55)
  ctx.quadraticCurveTo(-r * 0.95, r * 0.3, 0, r)
  ctx.closePath()
}

/** 画一颗四角星（sparkle）：四条内凹的边，漫画里"闪亮"的标准画法。 */
function sparklePath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath()
  ctx.moveTo(0, -r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.quadraticCurveTo(0, 0, 0, r)
  ctx.quadraticCurveTo(0, 0, -r, 0)
  ctx.quadraticCurveTo(0, 0, 0, -r)
  ctx.closePath()
}

/**
 * 少女漫画：樱花花瓣飘散 + 金色四角闪光。
 *
 * 这两样是这一风格最有辨识度的符号——花瓣是散点装饰，四角 sparkle 是
 * "闪亮登场"的经典画法（注意不是圆形光斑：圆光斑在漫画语汇里代表的是
 * 汗滴或阴影，完全不是一回事）。底下垫一层大范围低透明度的粉光当柔焦底片。
 *
 * 花瓣用贝塞尔画成一尖一圆的水滴形，而且**一边转一边落**——漫画里的花瓣是
 * 飘下来的，不是像弹片那样往外炸的，所以 y 方向额外加了下坠。
 */
function shoujoAccent(): EffectAccentFn {
  return (c) => {
    const { ctx, laneWidth: lw, centerX, judgeY, eased, alpha, color, rand, t } = c

    if (c.judgment === 'miss') {
      // 失误：花瓣蔫了 —— 只有两片，往两侧慢慢垂下去
      ctx.fillStyle = color
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1
        ctx.globalAlpha = alpha * 0.72 * (1 - t * 0.5)
        ctx.save()
        ctx.translate(centerX + side * lw * (0.1 + eased * 0.16), judgeY + eased * lw * 0.16)
        ctx.rotate(side * (0.5 + eased * 0.7))
        petalPath(ctx, lw * 0.07)
        ctx.fill()
        ctx.restore()
      }
      return
    }

    // ① 柔焦粉光打底
    const glow = ctx.createRadialGradient(centerX, judgeY, 0, centerX, judgeY, lw * 0.5)
    glow.addColorStop(0, color)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = alpha * 0.3 * (1 - t)
    ctx.fillStyle = glow
    ctx.fillRect(centerX - lw * 0.5, judgeY - lw * 0.5, lw, lw)

    // ② 樱花花瓣：翻滚着飘落
    //
    // 自然感来自三件事，缺一样就会露馅：
    //   a. **绕自身长轴翻滚**（ctx.scale(cos(spin), 1)）。只在画面平面内 rotate
    //      的精灵，看上去是纸屑或风车 —— 这是花瓣和纸片的真正分界线：翻滚到
    //      cos 过零时花瓣缩成一条边，翻到负值则水平镜像、等于看到背面。
    //   b. **侧滑与翻滚同相位**（sin(spin)）。花瓣"侧着切风"时滑得最快、正面
    //      朝前时几乎停住。这里千万不能换成独立的 sin(t) —— 那就成了被风吹，
    //      而不是自己在飘。
    //   c. **每片的速度参数全部独立随机**。共用任何一个参数，整片花瓣会在大约
    //      两秒内被眼睛识破是"一段向下滚动的纹理"。
    ctx.fillStyle = color
    for (let i = 0; i < 4; i++) {
      const spinRate = 4.5 + rand(i) * 3.5
      const rollRate = (rand(i + 20) - 0.5) * 2.4
      const slipAmp = lw * (0.05 + rand(i + 40) * 0.08)
      const fall = lw * (0.18 + rand(i + 60) * 0.14)
      const r = lw * (0.05 + rand(i + 80) * 0.028)

      // 出射点：从判定点往外散一小段
      const a0 = (Math.PI * 2 * i) / 4 + rand(i + 100) * 0.8 - Math.PI / 2
      const r0 = lw * (0.05 + rand(i + 120) * 0.09)
      const originX = centerX + Math.cos(a0) * r0
      const originY = judgeY + Math.sin(a0) * r0 * 0.6

      const spin = rand(i + 140) * Math.PI * 2 + t * spinRate
      const roll = rand(i + 160) * Math.PI * 2 + t * rollRate
      const slip = Math.sin(spin) * slipAmp

      ctx.globalAlpha = alpha * (0.9 - i * 0.1) * (1 - t * 0.55)
      ctx.save()
      ctx.translate(originX + slip, originY + t * fall)
      ctx.rotate(roll)
      const tumble = Math.cos(spin)
      ctx.scale(tumble, 1)
      // 翻到背面时压暗一档：正反两面同色的话，翻滚会看着像平面在缩放
      if (tumble < 0) ctx.globalAlpha *= 0.6
      petalPath(ctx, r)
      ctx.fill()
      ctx.restore()
    }

    // ③ 金色四角闪光。用 shadowBlur 让它真的"亮"，而不是画个黄星星了事
    ctx.fillStyle = '#fde68a'
    ctx.shadowColor = '#fde68a'
    ctx.shadowBlur = lw * 0.07
    for (let i = 0; i < 3; i++) {
      const angle = rand(i + 120) * Math.PI * 2
      const dist = lw * (0.1 + eased * 0.2) * (0.6 + rand(i + 140) * 0.6)
      // 透明度微微脉冲：漫画里的闪光是一跳一跳的，不是恒定亮度地淡出
      const flicker = 0.62 + 0.38 * Math.abs(Math.sin(t * 7 + i * 2.1))
      ctx.globalAlpha = alpha * 0.95 * (1 - t) * flicker
      ctx.save()
      ctx.translate(
        centerX + Math.cos(angle) * dist,
        judgeY + Math.sin(angle) * dist * 0.75,
      )
      ctx.rotate(rand(i + 180) * Math.PI)
      sparklePath(ctx, lw * (0.03 + rand(i + 160) * 0.025) * (0.6 + eased * 0.5))
      ctx.fill()
      ctx.restore()
    }
    ctx.shadowBlur = 0
  }
}

/**
 * 命中瞬间的像素爆炸图案。8×8 位图，`X` 表示画一格。
 *
 * 用图案而不是"一圈方块"，是因为像素游戏的爆炸本来就是**手绘逐帧**的——
 * 玩家一眼就能认出这种阶梯状轮廓。三帧从小到大推进。
 */
const PIXEL_BURST_FRAMES: readonly (readonly string[])[] = [
  [
    '........',
    '........',
    '...XX...',
    '..XXXX..',
    '..XXXX..',
    '...XX...',
    '........',
    '........',
  ],
  [
    '...XX...',
    '..XXXX..',
    '.XXXXXX.',
    'XXXXXXXX',
    'XXXXXXXX',
    '.XXXXXX.',
    '..XXXX..',
    '...XX...',
  ],
  [
    'X..XX..X',
    '.XXXXXX.',
    'XX.XX.XX',
    '.XXXXXX.',
    'XXXXXXXX',
    '.XXXXXX.',
    'XX.XX.XX',
    'X..XX..X',
  ],
]

/**
 * 像素：俄罗斯方块式的消行闪光 + 8-bit 逐帧爆炸。
 *
 * 之前那版是"八个方块朝八个方向散开"，本质上是通用粒子加了个网格吸附，
 * 看着随机，不像任何一款经典游戏。现在换成像素游戏真正在用的两种语言：
 *
 *   ① 消行闪光 —— 判定线上一条亮横条瞬间铺开，借用俄罗斯方块的"行清除"
 *   ② 爆炸图案 —— 手绘 8×8 位图，三帧推进，是 8-bit 爆炸的标准画法
 *
 * 坐标一律吸附网格、透明度量化成档：像素游戏里没有渐变，只有一格一格。
 */
function pixelAccent(): EffectAccentFn {
  return (c) => {
    const { ctx, laneWidth: lw, centerX, judgeY, eased, alpha, color, t } = c

    // 落到半像素上会被抗锯齿糊掉，"硬边"就没了 —— 像素风唯一不能妥协的地方
    const grid = Math.max(2, Math.round(lw * 0.05))
    const snap = (v: number) => Math.round(v / grid) * grid
    // 淡出也量化成 4 档
    const aq = Math.round(alpha * 4) / 4

    ctx.fillStyle = color

    // ① 消行：一条亮横条在判定线上铺开，后半程快速收掉
    const barH = Math.max(2, grid)
    const barW = snap(lw * (0.1 + eased * 0.39))
    ctx.globalAlpha = aq * (1 - t * t)
    ctx.fillRect(snap(centerX - barW / 2), snap(judgeY - barH / 2), barW, barH)

    // ② 8-bit 爆炸图案，三帧推进
    const frame = PIXEL_BURST_FRAMES[t < 0.34 ? 0 : t < 0.67 ? 1 : 2]
    const cell = Math.max(grid, Math.min(grid * 2, snap(lw * (0.0225 + eased * 0.04))))
    const cells = frame.length
    const ox = snap(centerX - (cells * cell) / 2)
    const oy = snap(judgeY - (cells * cell) / 2)
    ctx.globalAlpha = aq * 0.85
    for (let r = 0; r < cells; r++) {
      const row = frame[r]
      for (let col = 0; col < cells; col++) {
        if (row[col] === 'X') {
          ctx.fillRect(ox + col * cell, oy + r * cell, cell, cell)
        }
      }
    }
  }
}

/**
 * 霓虹复古：双色分离重影 + 信号不稳的横切。
 *
 * 主题的辨识点是"粉光晕 + 青偏移"，所以让粉青两个错位光束先分离再合拢，
 * 再叠几条跳动的横切线，像显像管没对齐。同样走 `lighter`，霓虹不发光就不叫霓虹。
 */
function vaporAccent(): EffectAccentFn {
  return (c) => {
    const { ctx, laneWidth: lw, centerX, judgeY, alpha, color, rand, t, eased } = c

    const barW = lw * 0.6
    const barH = Math.max(2, lw * 0.06 * (1 - t))
    // 错位量按 12 段跳变，做出信号不稳的断续感，而不是平滑滑开
    const step = Math.floor(t * 12)
    const shift = (Math.round(rand(step) * 4) - 2) * lw * 0.04
    // 先分离再合拢
    const split = Math.sin(Math.PI * t * 1.15) * lw * 0.07

    ctx.globalCompositeOperation = 'lighter'

    // 青色残影。取值与 VAPORWAVE_THEME.judgeLine 一致 —— 改主题配色时两边要一起改
    ctx.globalAlpha = alpha * 0.42
    ctx.fillStyle = '#01cdfe'
    ctx.fillRect(centerX - barW / 2 + shift - split, judgeY - barH, barW, barH * 2)

    // 主色压在另一边，偏移方向相反
    ctx.globalAlpha = alpha * 0.5
    ctx.fillStyle = color
    ctx.fillRect(centerX - barW / 2 + shift + split, judgeY - barH, barW, barH * 2)

    // VHS 横切：几条细线以不同速度上浮
    for (let k = 0; k < 3; k++) {
      const rise = lw * (0.2 + k * 0.22) * (0.25 + eased)
      ctx.globalAlpha = alpha * (0.3 - k * 0.07)
      ctx.fillStyle = k === 1 ? '#ff71ce' : color
      ctx.fillRect(centerX - barW / 2, judgeY - rise, barW, Math.max(1, lw * 0.014))
    }

    ctx.globalCompositeOperation = 'source-over'
  }
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
  // 基准主题：不加 accent，观感与改造前逐像素一致
  effects: { profiles: BASE_PROFILES },
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
  effects: {
    // 粒子要飞完一整趟抛物线，比基准多给一点时间
    profiles: profilesWith({ perfect: { lifeSec: 0.68 }, great: { lifeSec: 0.52 } }),
    accent: acidAccent(),
  },
}

/**
 * 少女漫画（Shoujo Manga）：珍珠白底 + 樱花粉 + 薰衣草紫。
 *
 * 与另外两套的关键差别是**对比来源反过来了**：QQ 是白底绿块、赛博是黑底荧光，
 * 两者都靠高饱和色块在低亮度背景上跳出来；粘土主题的背景本身是浅粉，音符再用
 * 浅粉就糊成一片。所以这里音符用中饱和的 pink-400/500 压深，轨道底用接近白的
 * #fff7fb —— 靠**明度差**而不是色相差把音符托起来。
 *
 * 画布画不出内外阴影（那是 DOM 的 box-shadow 干的活），所以粘土感由 DOM 那半边
 * 承担，这里只负责配色与字体不打架。文字用 pink-900/800，在浅粉底上是 7:1 以上。
 *
 * 本对象与 src/styles.css 的 `[data-theme='shoujo']` 主题块是一对，改色时两边要一起改。
 */
export const SHOUJO_THEME: RenderTheme = {
  background: '#fff5f7',
  laneBg: '#ffffff',
  laneBgAlt: '#fff0f4',
  laneLine: 'rgba(255, 183, 197, 0.35)',
  judgeLine: '#b9a5f0',
  noteFill: '#ff8fab',
  noteBorder: 'rgba(200, 90, 125, 0.35)',
  noteHold: 'rgba(255, 143, 171, 0.3)',
  noteHoldFill: '#f47fa5',
  noteHoldBorder: 'rgba(200, 90, 125, 0.4)',
  // 按住时翻成薰衣草紫，和粉色音符拉开明度差
  noteHoldActive: 'rgba(167, 139, 250, 0.9)',
  laneGlow: 'rgba(255, 183, 197, 0.3)',
  laneIdle: 'rgba(200, 90, 125, 0.22)',
  textPrimary: '#4a5568',
  textDim: 'rgba(74, 85, 104, 0.6)',
  pauseScrim: 'rgba(255, 245, 247, 0.92)',
  fontFamily: "'Quicksand', 'Nunito', ui-rounded, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  judgment: {
    perfect: '#ff8fab',
    great: '#a78bfa',
    good: '#f9a8d4',
    miss: '#c088a8',
  },
  effects: {
    // 花瓣要飘完才落定，比基准长一些
    profiles: profilesWith({
      perfect: { lifeSec: 0.8, baseAlpha: 0.92 },
      great: { lifeSec: 0.66, baseAlpha: 0.8 },
      good: { lifeSec: 0.5 },
      miss: { lifeSec: 0.6 },
    }),
    accent: shoujoAccent(),
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
  effects: {
    profiles: profilesWith({ perfect: { lifeSec: 0.7 } }),
    accent: vaporAccent(),
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
  effects: {
    // 像素风干脆利落：比基准更短，跳格淡出不该拖沓
    profiles: profilesWith({ perfect: { lifeSec: 0.58 }, great: { lifeSec: 0.44 } }),
    accent: pixelAccent(),
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
  effects: {
    // 墨要时间洇开，所以寿命比别的主题长得多（呼应 DOM 那边的 700ms 晕染）
    profiles: profilesWith({
      perfect: { lifeSec: 0.95, baseAlpha: 0.85 },
      great: { lifeSec: 0.74, baseAlpha: 0.72 },
      good: { lifeSec: 0.5 },
      miss: { lifeSec: 0.72 },
    }),
    accent: inkAccent(),
    // 败笔也是墨，不画 X 叉 —— 交给 accent 自己说
    baseMiss: false,
  },
}

const JUDGMENT_LABELS: Record<Judgment, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
}

/** 全部主题。用来推导特效寿命的全局上限——加主题时记得同步。 */
const ALL_RENDER_THEMES: readonly RenderTheme[] = [
  QQ_THEME,
  ACID_THEME,
  SHOUJO_THEME,
  VAPORWAVE_THEME,
  PIXEL_THEME,
  INK_THEME,
]

/**
 * 各判定的**全局保留上限**（秒），模块加载时算一次。
 *
 * 引擎清理过期特效时只看判定档、不知道当前主题（那个 filter 在 engine 的 loop 里），
 * 所以这里取的是所有主题在该档的**最长**寿命，而不是某一套主题的真实寿命。真正的
 * 裁剪由 `drawEffects` 按主题自己的 `lifeSec` 做。
 *
 * 按 ALL_RENDER_THEMES 推导而不是写死数字：加主题时自动跟上，不会出现"新主题寿命
 * 更长、特效被引擎提前裁掉、画面上却毫无报错"这种极难查的问题。代价只是特效对象
 * 在数组里多留几十毫秒（同屏最多几十个对象，可忽略）。
 */
const MAX_EFFECT_LIFE_SEC: Record<Judgment, number> = (() => {
  const out = {} as Record<Judgment, number>
  for (const j of ['perfect', 'great', 'good', 'miss'] as const) {
    out[j] = Math.max(...ALL_RENDER_THEMES.map((t) => t.effects.profiles[j].lifeSec))
  }
  return out
})()

export function hitEffectLifeSec(judgment: Judgment): number {
  return MAX_EFFECT_LIFE_SEC[judgment]
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

  /**
   * 一次命中的**基础几何**：判定线上的一道光束 + 判定文字；miss 则画 X 叉。
   *
   * 所有主题共用这一段，主题之间的差异全部由 `EffectStyle.accent` 在上面叠加。
   *
   * 判定线**外面那圈方框已经去掉**：原来这里有个 120px 高、占满整轨宽度的竖向
   * 光晕，它是整个特效里最大的一块，会盖住正在下落的音符。判定线中心的圆环、
   * 放射辐条和横条都保留（尺寸比改动前小 25%）。
   */
  private drawBaseEffect(c: EffectAccentContext, profile: EffectProfile): void {
    const { ctx, x, centerX, judgeY, laneWidth: lw, judgment, t, eased, alpha } = c

    if (judgment === 'miss') {
      const reach = lw * (0.075 + eased * 0.09)
      ctx.globalAlpha = alpha
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.moveTo(centerX - reach, judgeY - reach)
      ctx.lineTo(centerX + reach, judgeY + reach)
      ctx.moveTo(centerX + reach, judgeY - reach)
      ctx.lineTo(centerX - reach, judgeY + reach)
      ctx.stroke()
      return
    }

    // 判定线上的一条横条，两侧随命中往外扩一点点
    const expand = eased * lw * 0.08
    ctx.globalAlpha = alpha
    ctx.fillRect(
      x + lw * 0.08 - expand / 2,
      judgeY - profile.beamHeight / 2,
      lw * 0.84 + expand,
      profile.beamHeight,
    )

    // 判定线中心的圆环 —— 命中时一圈圈往外扩
    for (let ring = 0; ring < profile.ringCount; ring++) {
      const radius = lw * (0.045 + eased * (0.15 + ring * 0.075))
      ctx.globalAlpha = alpha * (1 - ring * 0.38)
      ctx.lineWidth = Math.max(1, (3 - ring) * (1 - t))
      ctx.beginPath()
      ctx.arc(centerX, judgeY, radius, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 环绕圆环的放射辐条
    if (profile.spokeCount > 0) {
      const inner = lw * (0.06 + eased * 0.03)
      const outer = inner + lw * (0.06 + eased * 0.075)
      ctx.globalAlpha = alpha * 0.72
      ctx.lineWidth = judgment === 'perfect' ? 2.2 : 1.5
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
      ctx.fillText(JUDGMENT_LABELS[judgment], centerX, judgeY - 24 - eased * 9)
    }
  }

  private drawEffects(state: RenderState): void {
    const ctx = this.ctx
    const lw = this.laneWidth
    const judgeY = this.judgeLineY
    const style = this.theme.effects

    for (const fx of state.effects) {
      const age = state.songTimeSec - fx.startSec
      // 超龄用**主题自己的**寿命判断。引擎那张表只是保守的保留上限——
      // 引擎不认识主题，也不该认识（见 hitEffectLifeSec 的说明）。
      const life = style.profiles[fx.judgment].lifeSec
      if (age < 0 || age > life) continue

      const t = age / life
      const profile = style.profiles[fx.judgment]
      const x = fx.lane * lw
      const c: EffectAccentContext = {
        ctx,
        laneWidth: lw,
        centerX: x + lw / 2,
        judgeY,
        x,
        judgment: fx.judgment,
        t,
        eased: 1 - Math.pow(1 - t, 3),
        alpha: (1 - t) * profile.baseAlpha,
        color: this.theme.judgment[fx.judgment],
        rand: makeRand(fx.lane, fx.startSec),
      }

      ctx.save()
      ctx.lineCap = 'round'
      ctx.strokeStyle = c.color
      ctx.fillStyle = c.color

      // miss 的基础几何（那个 X 叉）可以关掉，交给主题自己画
      if (fx.judgment !== 'miss' || style.baseMiss !== false) {
        this.drawBaseEffect(c, profile)
      }
      // 专属点缀叠在基础几何之上，四个判定档位都会调用
      style.accent?.(c)

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
