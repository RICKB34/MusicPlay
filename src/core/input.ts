/**
 * 输入层 —— 统一处理桌面键盘与手机多点触摸。
 *
 * 两个必须处理的坑：
 *
 * 1. **键盘自动重复**：按住不放时浏览器会持续派发 `keydown`。
 *    不检查 `e.repeat` 的话，一个长按会被当成几十次击打，判定全乱。
 *    另外必须用 `e.code`（物理键位）而非 `e.key`（受输入法/键盘布局影响）。
 *
 * 2. **触摸的多点与手势**：必须用指针事件（`pointerdown`）而非 `touchstart`，
 *    因为 `pointerId` 天然区分多指，且配 CSS `touch-action: none` 后
 *    不再需要 `passive: false` + `preventDefault()` 来阻止滚动和双击缩放，
 *    代码路径唯一。`pointercancel` 也必须处理，否则手指滑出元素后
 *    该轨道会永远卡在"按下"状态。
 *
 * 默认键位选 D F J K（4K）/ S D F J K L（6K）：跨越键盘左右两区，
 * 规避廉价薄膜键盘的按键冲突（鬼键）。玩家可以在设置里逐轨改键。
 */

import { buildKeymap, DEFAULT_KEY_BINDINGS } from './keymap'

export type LaneHandler = (lane: number, songTimeSec: number) => void

export interface InputOptions {
  columns: 4 | 6
  /** 每轨的 KeyboardEvent.code。不传或长度不匹配时使用默认键位。 */
  keyBindings?: readonly string[]
  /** 读取当前歌曲时刻（秒）。判定就在输入回调里同步用它。 */
  getSongTime: () => number
  onLaneDown: LaneHandler
  onLaneUp?: LaneHandler
}

export class InputManager {
  private readonly el: HTMLElement
  private readonly opts: InputOptions
  private readonly keymap: Record<string, number>
  /** pointerId → 轨道。支持多指同时按住不同轨道。 */
  private readonly activePointers = new Map<number, number>()
  /** 当前被键盘按住的轨道集合，用于过滤自动重复。 */
  private readonly heldKeys = new Set<string>()
  private disposed = false

  /** 各轨道当前的按下状态，渲染层用它画按键高亮。 */
  readonly lanePressed: boolean[]

  constructor(el: HTMLElement, opts: InputOptions) {
    this.el = el
    this.opts = opts
    const keys = opts.keyBindings?.length === opts.columns
      ? opts.keyBindings
      : DEFAULT_KEY_BINDINGS[opts.columns]
    this.keymap = buildKeymap(keys)
    this.lanePressed = new Array(opts.columns).fill(false)

    el.style.touchAction = 'none'
    el.style.userSelect = 'none'
    ;(el.style as CSSStyleDeclaration & { webkitTouchCallout?: string }).webkitTouchCallout = 'none'
    el.style.webkitUserSelect = 'none'

    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    // 切窗口/失焦时强制释放所有按键，防止卡键
    window.addEventListener('blur', this.releaseAll)
  }

  destroy(): void {
    if (this.disposed) return
    this.disposed = true
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('pointerup', this.onPointerUp)
    this.el.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.releaseAll)
    this.activePointers.clear()
    this.heldKeys.clear()
  }

  /** 由渲染层在每帧开始时调用，重置视觉高亮。 */
  resetVisualState(): void {
    for (let i = 0; i < this.lanePressed.length; i++) this.lanePressed[i] = false
    for (const lane of this.activePointers.values()) this.lanePressed[lane] = true
    for (const code of this.heldKeys) {
      const lane = this.keymap[code]
      if (lane != null) this.lanePressed[lane] = true
    }
  }

  /** 把坐标映射到轨道。 */
  private laneFromX(clientX: number): number | null {
    const rect = this.el.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = (clientX - rect.left) / rect.width
    if (ratio < 0 || ratio > 1) return null
    const lane = Math.floor(ratio * this.opts.columns)
    return Math.max(0, Math.min(this.opts.columns - 1, lane))
  }

  private onPointerDown = (e: PointerEvent): void => {
    const lane = this.laneFromX(e.clientX)
    if (lane === null) return
    // 防止触摸时触发页面滚动/缩放（CSS touch-action 之外的双保险）
    e.preventDefault()
    this.activePointers.set(e.pointerId, lane)
    this.lanePressed[lane] = true
    // 捕获指针：手指滑出元素仍能收到 pointerup
    try {
      this.el.setPointerCapture(e.pointerId)
    } catch {
      // 某些浏览器在合成事件上会抛，忽略
    }
    // ★ 关键：在事件回调里同步读时钟并判定，不等下一帧
    this.opts.onLaneDown(lane, this.opts.getSongTime())
  }

  private onPointerUp = (e: PointerEvent): void => {
    const lane = this.activePointers.get(e.pointerId)
    if (lane == null) return
    this.activePointers.delete(e.pointerId)
    this.lanePressed[lane] = false
    try {
      this.el.releasePointerCapture(e.pointerId)
    } catch {
      // 忽略
    }
    this.opts.onLaneUp?.(lane, this.opts.getSongTime())
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // ★ 坑 1：不检查 repeat 的话，按住不放会被当成几十次击打
    if (e.repeat) return
    if (e.metaKey || e.ctrlKey || e.altKey) return

    const lane = this.keymap[e.code]
    if (lane == null) return

    e.preventDefault()
    // 二次保险：即使浏览器没设 repeat，同一物理键也不重复触发
    if (this.heldKeys.has(e.code)) return
    this.heldKeys.add(e.code)
    this.lanePressed[lane] = true

    this.opts.onLaneDown(lane, this.opts.getSongTime())
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const lane = this.keymap[e.code]
    if (lane == null) return
    this.heldKeys.delete(e.code)
    this.lanePressed[lane] = false
    this.opts.onLaneUp?.(lane, this.opts.getSongTime())
  }

  private releaseAll = (): void => {
    const t = this.opts.getSongTime()
    for (const lane of this.activePointers.values()) {
      this.lanePressed[lane] = false
      this.opts.onLaneUp?.(lane, t)
    }
    this.activePointers.clear()
    for (const code of this.heldKeys) {
      const lane = this.keymap[code]
      if (lane != null) {
        this.lanePressed[lane] = false
        this.opts.onLaneUp?.(lane, t)
      }
    }
    this.heldKeys.clear()
  }
}
