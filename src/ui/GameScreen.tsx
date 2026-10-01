/**
 * 游戏页 —— 一个**薄壳**。
 *
 * 这个文件里没有任何 setState 参与游戏循环。RhythmGame 是一个普通 class，
 * 自己持有 rAF 循环和全部游戏状态。React 只负责在挂载时创建它、
 * 卸载时销毁它，以及显示开局倒计时、对手进度这类低频 UI（≤4Hz）。
 *
 * 依赖数组恒为空：游戏期间绝不重挂载，否则音频会断、状态会丢。
 */

import { useEffect, useRef, useState } from 'react'
import type { Chart, DrumHit, ScoreSnapshot } from '../types'
import type { Settings } from '../state/settings'
import { getAudioContext } from '../state/audioContext'
import { RhythmGame, type GameResult } from '../core/engine'
import { renderThemeOf } from '../state/theme'
import type { BattleClient } from '../net/client'

export interface BattleContext {
  client: BattleClient
  /** 服务器权威时间轴上的开局时刻，已换算成本地单调时钟（毫秒）。 */
  startAtLocalMs: number
  /** 对手昵称/标识（本版本用 playerId）。 */
  opponentLabel: string
}

interface Props {
  chart: Chart
  audioBuffer: AudioBuffer
  settings: Settings
  /**
   * 鼓点序列，从原曲分析得到的起音中筛选。
   * 空数组或 undefined = 不启用震动与光晕。
   */
  drumHits?: readonly DrumHit[]
  battle?: BattleContext
  onFinish: (result: GameResult) => void
  onExit: () => void
}

/** 单人模式的固定提前量。 */
const SOLO_LEAD_SEC = 3

export function GameScreen({
  chart,
  audioBuffer,
  settings,
  drumHits,
  battle,
  onFinish,
  onExit,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<RhythmGame | null>(null)
  /** 边框光晕层。引擎每帧直接写它的 opacity，见下面的 onGlow。 */
  const glowRef = useRef<HTMLDivElement>(null)
  const [countdown, setCountdown] = useState(0)
  const [opponent, setOpponent] = useState<ScoreSnapshot | null>(null)
  const [opponentDone, setOpponentDone] = useState(false)

  // 用 ref 持有最新回调，避免放进依赖数组导致游戏重挂载
  const finishRef = useRef(onFinish)
  finishRef.current = onFinish
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  /**
   * 开局提前量。
   *
   * 单人模式用固定 3 秒。对战模式必须由**服务器时间轴**换算：
   * 双方各自把同一个 `startAtServerMs` 映射成本地 ctx 时刻，
   * 才能保证同一小节同时到达判定线。
   */
  const leadSec = (() => {
    if (!battle) return SOLO_LEAD_SEC
    const nowLocalMs = performance.timeOrigin + performance.now()
    const remain = (battle.startAtLocalMs - nowLocalMs) / 1000
    // 网络延迟导致剩余时间不足时，保底 0.3 秒，避免 start() 传入过去时刻
    return Math.max(0.3, remain)
  })()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const game = new RhythmGame({
      canvas,
      chart,
      audioBuffer,
      ctx: getAudioContext(),
      approachSec: settings.approachMs / 1000,
      userOffsetSec: settings.userOffsetMs / 1000,
      leadSec,
      showDelta: settings.showDelta,
      // 主题只在挂载时读一次。依赖数组恒为空是刻意的——把 settings.theme 加进去
      // 会在切主题时重挂载游戏，音频图重连、当前这局直接报废。
      theme: renderThemeOf(settings.theme),
      drumHits,
      // 直接写 DOM，绝不 setState：这是 60fps 的回调，进 React 就是每帧一次
      // 重渲染，正是 engine.ts 开头那段注释要避免的事。
      onGlow: (intensity) => {
        const el = glowRef.current
        if (!el) return
        // 归零时顺手收回合成层，别让一个全屏元素一直占着 GPU
        if (intensity <= 0) {
          if (el.style.opacity !== '0') el.style.opacity = '0'
          return
        }
        el.style.opacity = intensity.toFixed(3)
      },
      onFinish: (r) => {
        // 对战模式上报成绩
        battle?.client.finish(r.score, r.accuracy, r.maxCombo, r.counts)
        finishRef.current(r)
      },
      onScore: battle
        ? (snapshot) => {
            battle.client.sendScore(snapshot)
          }
        : undefined,
    })
    gameRef.current = game
    game.start()

    return () => {
      game.destroy()
      gameRef.current = null
    }
    // 依赖数组恒为空 —— 游戏期间绝不重挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 订阅对手分数（对战模式）
  useEffect(() => {
    if (!battle) return
    const client = battle.client
    const prev = {
      onOpponentScore: undefined as undefined | ((s: ScoreSnapshot) => void),
    }
    void prev
    // 通过重新绑定回调实现订阅：BattleClient 的回调是单一的，
    // 这里直接把监听挂到它的内部回调上（见 net/client.ts 的 setBattleObserver）
    return client.observe({
      onOpponentScore: (s) => setOpponent(s),
      onOpponentFinished: () => setOpponentDone(true),
    })
  }, [battle])

  // 倒计时显示。只影响视觉提示，不参与判定——判定读的是音频时钟。
  useEffect(() => {
    const total = Math.ceil(leadSec)
    setCountdown(total)
    if (total <= 0) return
    const id = setInterval(() => {
      setCountdown((c) => (c <= 1 ? 0 : c - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [leadSec])

  return (
    <div className="game-host">
      <canvas ref={canvasRef} className="game-canvas" />

      {/*
        鼓点光晕。颜色完全交给 CSS —— 它取的是主题的 --accent，所以切主题
        自动跟随，引擎只负责逐帧写 opacity 这一个数。没有鼓点时停在 0，
        不可见也不占合成开销。
      */}
      <div ref={glowRef} className="drum-glow" aria-hidden="true" />

      {battle && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(320px, 70%)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 3 }}>
            对手 {battle.opponentLabel} · {opponent ? opponent.score.toLocaleString() : '0'}
            {opponentDone && ' （已完成）'}
          </div>
          <div className="progress" style={{ height: 4 }}>
            <div style={{ width: `${Math.round((opponent?.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {countdown > 0 && (
        <div
          className="overlay"
          style={{ background: 'var(--overlay-scrim-soft)', pointerEvents: 'none' }}
        >
          <div>
            <div style={{ fontSize: 92, fontWeight: 800, lineHeight: 1 }}>
              {countdown > 1 ? countdown - 1 : '开始'}
            </div>
            <p style={{ marginTop: 14 }}>
              {chart.notes.length} 个音符 · {chart.meta.bpm.toFixed(0)} BPM · {chart.columns}K
              {battle && ' · 对战模式'}
            </p>
            {/* 有没有鼓点从画面上看不出来——没有鼓点时光晕只是安静地停在 0，
                和坏了长得一模一样。所以这里明说数量，省得排查时往算法上猜。
                一个鼓点都没有只可能是这首曲子本身缺打击乐（弦乐、纯人声之类），
                不是配置问题。 */}
            <p
              style={{
                marginTop: 6,
                fontSize: 13,
                color: drumHits && drumHits.length > 0 ? 'var(--success)' : 'var(--text-dim)',
              }}
            >
              {drumHits && drumHits.length > 0
                ? `鼓点反馈 · ${drumHits.length} 个鼓点`
                : '无鼓点反馈（这首曲子的打击乐特征不明显）'}
            </p>
          </div>
        </div>
      )}

      <div style={{ position: 'absolute', top: 10, right: 12 }}>
        <button
          className="ghost"
          style={{ minHeight: 34, padding: '6px 12px', fontSize: 13 }}
          onClick={() => void gameRef.current?.togglePause()}
        >
          暂停
        </button>
      </div>

      <div style={{ position: 'absolute', bottom: 10, right: 12 }}>
        <button
          className="ghost"
          style={{ minHeight: 34, padding: '6px 12px', fontSize: 13 }}
          onClick={() => exitRef.current()}
        >
          退出
        </button>
      </div>
    </div>
  )
}
