import { useEffect, useState } from 'react'
import { DEFAULT_KEY_BINDINGS, isBindableKeyCode, keyLabel, type KeyColumns } from '../core/keymap'

interface Props {
  columns: KeyColumns
  value: readonly string[]
  onChange: (bindings: string[]) => void
}

export function KeyBindingEditor({ columns, value, onChange }: Props) {
  const [capturing, setCapturing] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setCapturing(null)
    setNotice(null)
  }, [columns])

  useEffect(() => {
    if (capturing === null) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()

      if (e.code === 'Escape') {
        setCapturing(null)
        setNotice(null)
        return
      }

      if (!isBindableKeyCode(e.code)) {
        setNotice('这个键不能用于游戏，请换一个。')
        return
      }

      const next = [...value]
      const previous = next[capturing] ?? ''
      const conflict = next.findIndex((code, index) => index !== capturing && code === e.code)
      next[capturing] = e.code
      if (conflict >= 0) next[conflict] = previous

      onChange(next)
      setCapturing(null)
      setNotice(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, onChange, value])

  return (
    <div className="keybindings">
      <div
        className="keybinding-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {value.map((code, lane) => {
          const isCapturing = capturing === lane
          return (
            <button
              key={lane}
              type="button"
              className="keybinding-key"
              data-capturing={isCapturing}
              aria-pressed={isCapturing}
              aria-label={`第 ${lane + 1} 轨按键：${keyLabel(code)}`}
              title={isCapturing ? '按下新按键，Esc 取消' : '点击后按下这个轨道要使用的键'}
              onClick={() => {
                setNotice(null)
                setCapturing((current) => (current === lane ? null : lane))
              }}
            >
              <span className="keybinding-key__lane">第 {lane + 1} 轨</span>
              <strong className="keybinding-key__value">
                {isCapturing ? '按键…' : keyLabel(code)}
              </strong>
            </button>
          )
        })}
      </div>

      <div className="keybinding-actions">
        <span className="muted">
          {capturing === null ? '点击一个键位，再按下想使用的键。' : '请按下新按键，Esc 取消。'}
        </span>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            onChange([...DEFAULT_KEY_BINDINGS[columns]])
            setCapturing(null)
            setNotice(null)
          }}
        >
          恢复默认
        </button>
      </div>

      {notice && <p className="keybinding-notice">{notice}</p>}
    </div>
  )
}
