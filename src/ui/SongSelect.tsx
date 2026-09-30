/**
 * 选曲与参数设置页。
 */

import { useRef } from 'react'
import type { Difficulty } from '../types'
import type { Settings } from '../state/settings'
import { keyHint } from '../core/input'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  analyzing: boolean
  progress: { stage: string; ratio: number }
  error: string | null
  songTitle: string | null
  onFile: (file: File, difficulty: Difficulty, columns: 4 | 6) => void
  onCalibrate: () => void
  onDebug: () => void
  onBattle: () => void
  onPlayExisting: () => void
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
}

export function SongSelect(props: Props) {
  const { settings, onChange, analyzing, progress, error, songTitle } = props
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="screen">
      <h1>选一首歌</h1>
      <p className="muted">
        支持 MP3 / WAV / M4A。FLAC 在部分浏览器（尤其 Safari）无法解码，遇到问题请先转成 MP3。
      </p>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="card">
        <h2>难度</h2>
        <div className="seg">
          {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
            <button
              key={d}
              data-active={settings.difficulty === d}
              onClick={() => onChange({ difficulty: d })}
            >
              {DIFFICULTY_LABELS[d]}
            </button>
          ))}
        </div>

        <h2 style={{ marginTop: 16 }}>轨道数</h2>
        <div className="seg">
          {([4, 6] as const).map((c) => (
            <button key={c} data-active={settings.columns === c} onClick={() => onChange({ columns: c })}>
              {c}K
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          键位：{keyHint(settings.columns)}
        </p>
      </div>

      <div className="card">
        <h2>分析精度</h2>
        <div className="seg">
          {(['fast', 'balanced', 'precise', 'demo'] as const).map((p) => (
            <button
              key={p}
              data-active={settings.analysisProfile === p}
              onClick={() => onChange({ analysisProfile: p })}
              title={p === 'demo' ? '只分析前 90 秒，设备性能弱时用' : undefined}
            >
              {p === 'fast' ? '快' : p === 'balanced' ? '标准' : p === 'precise' ? '精细' : '演示'}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          手机卡顿或想让演示秒开，选「快」或「演示」（只分析前 90 秒）。
        </p>
      </div>

      {analyzing ? (
        <div className="card">
          <h2>正在分析…</h2>
          <div className="progress">
            <div style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            {progress.stage || '准备中'} · {Math.round(progress.ratio * 100)}%
          </p>
          <p className="muted">全曲离线分析，4 分钟的歌在桌面约 2-4 秒。</p>
        </div>
      ) : (
        <button
          className="primary"
          style={{ padding: 16, fontSize: 16 }}
          onClick={() => inputRef.current?.click()}
        >
          选择本地音乐文件
        </button>
      )}

      {songTitle && !analyzing && (
        <button onClick={props.onPlayExisting}>继续玩「{songTitle}」</button>
      )}

      <button style={{ padding: 14 }} onClick={props.onBattle}>
        双人对战 · 用同一份谱面比一场
      </button>

      <div className="row">
        <button className="ghost" onClick={props.onCalibrate}>
          延迟校准
        </button>
        <button className="ghost" onClick={props.onDebug}>
          调试工具
        </button>
      </div>

      <p className="muted">
        延迟校准很重要：蓝牙耳机和有线音箱的输出延迟能差 100ms 以上，不校准的话判定会完全不对。
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/flac,audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f, settings.difficulty, settings.columns)
          // 重置以便同一个文件能再次选择
          e.target.value = ''
        }}
      />
    </div>
  )
}
