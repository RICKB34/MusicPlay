/**
 * 起始页 —— 存在的唯一理由是 **iOS 的音频解锁**。
 *
 * iOS Safari 要求 AudioContext 必须在用户手势的回调里被创建或 `resume()`，
 * 否则整个应用静音且不报错。所以第一屏必须是一个"点击开始"的按钮，
 * 在它的 pointerdown 里同步调用 `unlockAudio()`。
 */

import type { ThemeKey } from '../state/theme'
import { ThemePicker } from './ThemePicker'

interface StartScreenProps {
  onStart: () => void
  onUnlock: () => void
  error: string | null
  theme: ThemeKey
  onThemeChange: (theme: ThemeKey) => void
}

export function StartScreen({
  onStart,
  onUnlock,
  error,
  theme,
  onThemeChange,
}: StartScreenProps) {
  return (
    <div
      className="screen home-screen"
      style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}
    >
      <div className="home-theme">
        <ThemePicker value={theme} onChange={onThemeChange} variant="compact" />
      </div>

      <div className="brand">Rhythm Forge</div>
      <p style={{ maxWidth: 'min(420px, 100%)' }}>
        选一首你本地的音乐，自动识别它的节奏与音色，生成一份可玩的 4 轨下落式音游谱面。
        <br />
        手机和电脑都能用，还能和朋友用同一份谱面对战。
      </p>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', maxWidth: 'min(420px, 100%)' }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      <button
        className="primary"
        style={{ padding: '16px 40px', fontSize: 17, marginTop: 8 }}
        onPointerDown={onUnlock}
        onClick={onStart}
      >
        点击开始
      </button>

      <p className="muted" style={{ maxWidth: 'min(400px, 100%)' }}>
        首次点击会激活音频系统（iOS 的系统限制）。音频只在你本机处理，不会上传。
      </p>
    </div>
  )
}
