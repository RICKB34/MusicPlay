/**
 * AudioContext 单例。
 *
 * iOS Safari 的硬性限制：AudioContext 初始状态是 `suspended`，
 * **必须在用户手势（点击/触摸）的回调里创建或 `resume()`** 才能出声。
 * 而且 iOS 上 `sampleRate` 常为 48000 且不可指定——所以全链路统一
 * 使用 `ctx.sampleRate`，不做重采样，避免引入重采样误差。
 *
 * 另一个 iOS 坑：来电、切后台会中断音频且**不会自动恢复**，
 * 所以监听 `statechange` 暴露给 UI 提示用户点击继续。
 */

let instance: AudioContext | null = null
const stateListeners = new Set<(state: AudioContextState) => void>()

export function getAudioContext(): AudioContext {
  if (instance) return instance

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('这个浏览器不支持 Web Audio API')

  instance = new Ctor()
  instance.addEventListener('statechange', () => {
    for (const fn of stateListeners) fn(instance!.state)
  })
  return instance
}

/**
 * 在用户手势里调用，解锁音频。
 *
 * 必须在 `pointerdown` / `click` 这类真实手势回调里同步调用，
 * 放到 `await` 之后调用会被 iOS 判定为非手势上下文而失败。
 */
export async function unlockAudio(): Promise<AudioContext> {
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') {
    await ctx.resume()
  }
  return ctx
}

export function onAudioStateChange(fn: (state: AudioContextState) => void): () => void {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}

export function isAudioRunning(): boolean {
  return instance?.state === 'running'
}
