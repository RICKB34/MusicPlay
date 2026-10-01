/**
 * 主题选择器：一个触发按钮 + 可展开的选项面板。
 *
 * 早先这里是 `.seg` 分段控件，主题横向排成一排。两个主题时装得下，第三个开始
 * 就挤成一条窄缝——放不下色卡，也放不下那句说明，而且每加一套主题都要重新
 * 算计宽度。现在加主题只往 `THEMES` 里加一项，这个文件一行都不用改。
 *
 * 面板展开后在**文档流内**（见 styles.css 的说明），所以没有浮层的定位与裁切问题。
 */

import { useEffect, useId, useRef, useState } from 'react'
import { THEMES, type ThemeKey } from '../state/theme'

interface Props {
  value: ThemeKey
  onChange: (key: ThemeKey) => void
  /** `inline`：跟随文档流；`compact`：选曲页右上角使用的紧凑浮层。 */
  variant?: 'inline' | 'compact'
}

/** 一排代表色的小圆点。`aria-hidden`：颜色是给眼睛看的，读屏读 label 就够了。 */
function Swatch({ colors }: { colors: readonly string[] }) {
  return (
    <span className="theme-dots" aria-hidden="true">
      {colors.map((c, i) => (
        <i key={`${c}-${i}`} style={{ background: c }} />
      ))}
    </span>
  )
}

export function ThemePicker({ value, onChange, variant = 'inline' }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const current = THEMES.find((t) => t.key === value) ?? THEMES[0]

  // 点面板外面就收起来。用 pointerdown 而非 click：click 要等抬手，
  // 而且拖选文字后松手也会触发，收起时机比用户预期晚一拍。
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // 展开后把焦点送进面板，键盘用户不必再按一次 Tab。
  // preventScroll：面板就在按钮正下方，替用户滚动反而会晃一下。
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.focus({ preventScroll: true })
  }, [open])

  function options(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.theme-option') ?? [])
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      // 不让 Escape 继续冒泡：外层可能还挂着别的 Esc 处理（退出游戏页之类）
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return

    e.preventDefault()
    const items = options()
    if (!items.length) return
    const idx = items.findIndex((b) => b === document.activeElement)
    const forward = e.key === 'ArrowDown'
    // 焦点还在触发按钮上时（idx === -1），下方向进第一项、上方向进最后一项
    const next = idx === -1 ? (forward ? 0 : items.length - 1) : (idx + (forward ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  // Tab 走出整个选择器就收起来。只管 Tab：点页面别处已经由上面的 pointerdown 兜了，
  // 而这里如果对"焦点离开"也一律关闭，点选项时的焦点转移会误伤。
  // relatedTarget 为 null（焦点移到了不可聚焦处或丢给 body）同样按离开处理。
  function onBlur(e: React.FocusEvent) {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false)
  }

  function choose(key: ThemeKey) {
    onChange(key)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      className={`theme-picker${variant === 'compact' ? ' theme-picker--compact' : ''}`}
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className="theme-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Swatch colors={current.swatch} />
        <span className="theme-name">{current.label}</span>
        <span className="theme-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="theme-menu" id={panelId} role="listbox" aria-label="主题" ref={listRef}>
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              className="theme-option"
              role="option"
              aria-selected={t.key === value}
              onClick={() => choose(t.key)}
            >
              <Swatch colors={t.swatch} />
              <span className="theme-text">
                <span className="theme-label">{t.label}</span>
                <span className="theme-desc">{t.description}</span>
              </span>
              <span className="theme-check" aria-hidden="true">
                ✓
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
