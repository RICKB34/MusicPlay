/**
 * 进入站点与页面切换动画。
 *
 * 首次加载是一个可交互的品牌加载器；页面跳转则用分栏帘幕遮住换页瞬间，
 * 避免 React 状态切换时出现内容闪动。两者都只消费现有主题变量。
 */

import { useEffect, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

const CURTAIN_COUNT = 6
const EQ_BAR_COUNT = 14

export type TransitionPhase = 'prepare' | 'cover' | 'reveal'

interface EntryLoaderProps {
  onComplete: () => void
}

export function EntryLoader({ onComplete }: EntryLoaderProps) {
  const [progress, setProgress] = useState(0)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const startedAt = performance.now()
    /** 从进入 loading 到 Home 露出，总共约 2 秒。 */
    const duration = 1380
    const holdMs = 100
    const exitMs = 520
    let frame = 0
    let holdTimer = 0
    let finishTimer = 0

    const tick = (now: number) => {
      const raw = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - raw, 5)
      setProgress(Math.min(100, Math.round(eased * 100)))

      if (raw < 1) {
        frame = window.requestAnimationFrame(tick)
        return
      }

      holdTimer = window.setTimeout(() => {
        setLeaving(true)
        finishTimer = window.setTimeout(onComplete, exitMs)
      }, holdMs)
    }

    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(holdTimer)
      window.clearTimeout(finishTimer)
    }
  }, [onComplete])

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width - 0.5
    const y = (event.clientY - rect.top) / rect.height - 0.5
    event.currentTarget.style.setProperty('--pointer-x', `${(x * 20).toFixed(2)}px`)
    event.currentTarget.style.setProperty('--pointer-y', `${(y * 12).toFixed(2)}px`)
  }

  return (
    <div
      className={`entry-loader${leaving ? ' is-leaving' : ''}`}
      onPointerMove={handlePointerMove}
      role="status"
      aria-label={`正在加载 Rhythm Forge，${progress}%`}
    >
      <div className="entry-loader__curtains" aria-hidden="true">
        {Array.from({ length: CURTAIN_COUNT }, (_, i) => (
          <span
            key={i}
            style={
              {
                '--i': i,
                '--exit-y': i % 2 === 0 ? '-108%' : '108%',
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div className="entry-loader__content" aria-hidden="true">
        <div className="entry-loader__meta">
          <span>RF / AUDIO SYSTEM</span>
          <span>HK · 2026</span>
        </div>

        <div className="entry-loader__center">
          <div className="entry-loader__eq">
            {Array.from({ length: EQ_BAR_COUNT }, (_, i) => (
              <i key={i} style={{ '--i': i } as CSSProperties} />
            ))}
          </div>
          <div className="entry-loader__title">
            <span>RHYTHM</span>
            <span>FORGE</span>
          </div>
        </div>

        <div className="entry-loader__footer">
          <span>BUILDING THE NEXT TRACK</span>
          <span className="entry-loader__count">{String(progress).padStart(3, '0')}%</span>
        </div>
      </div>

      <div className="entry-loader__progress">
        <i style={{ transform: `scaleX(${progress / 100})` }} />
      </div>
    </div>
  )
}

interface ScreenTransitionProps {
  phase: TransitionPhase
  label: string
}

export function ScreenTransition({ phase, label }: ScreenTransitionProps) {
  return (
    <div className={`screen-transition is-${phase}`} aria-hidden="true">
      <div className="screen-transition__curtains">
        {Array.from({ length: CURTAIN_COUNT }, (_, i) => (
          <span key={i} style={{ '--i': i } as CSSProperties} />
        ))}
      </div>
      <div className="screen-transition__prompt">
        <i />
        <span>{label} / READY</span>
      </div>
      <div className="screen-transition__label">
        <span>RF</span>
        <strong>{label}</strong>
      </div>
    </div>
  )
}
