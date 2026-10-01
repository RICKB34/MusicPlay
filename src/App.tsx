/**
 * 应用外壳与页面路由。
 *
 * 刻意不用 react-router：只有 7 个页面，一个 useState 足够，
 * 省掉一个依赖和一层抽象。
 *
 * 这里承载的是**跨页面的共享状态**（当前歌曲、分析结果、谱面、对战上下文），
 * 而游戏运行时的状态完全在 RhythmGame 内部，绝不放进这里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisProfile } from './analysis/analyzeTrack'
import type { Chart, Difficulty, DrumHit, TrackAnalysis } from './types'
import { decodeArrayBuffer, describeDecodeError, type DecodedAudio } from './analysis/decode'
import { runAnalysis } from './analysis/analyzeClient'
import { drumHitsFromOnsets } from './analysis/drumHit'
import { generateChart, type GenerateResult } from './chartgen/generate'
import { loadSettings, saveSettings, type Settings } from './state/settings'
import { themeDefOf } from './state/theme'
import { getAudioContext, onAudioStateChange, unlockAudio } from './state/audioContext'
import { StartScreen } from './ui/StartScreen'
import { SongSelect } from './ui/SongSelect'
import { GameScreen, type BattleContext } from './ui/GameScreen'
import { Results } from './ui/Results'
import { Calibration } from './ui/Calibration'
import { DebugChart } from './ui/DebugChart'
import { Lobby, type BattleStart } from './ui/Lobby'
import { EntryLoader, ScreenTransition, type TransitionPhase } from './ui/Transitions'
import type { GameResult } from './core/engine'
import type { BattlePlayerResult } from './net/protocol'

type Screen = 'start' | 'select' | 'game' | 'result' | 'calibrate' | 'debug' | 'lobby'

export interface LoadedSong {
  decoded: DecodedAudio
  analysis: TrackAnalysis
  generated: GenerateResult
  fileName: string
  /** 原始音频字节。双人对战时由房主中转给加入者。 */
  sourceBytes: ArrayBuffer
  /**
   * 鼓点序列，用于游戏中的震动与边框光晕。
   *
   * 从原曲分析得到的起音中筛选，空数组是合法状态，表示这首歌没有明显的
   * 打击乐特征，不是出错。
   */
  drumHits: DrumHit[]
}

/** 空鼓点数组的共享实例，避免每次渲染都新建一个。 */
const NO_DRUM_HITS: DrumHit[] = []

export function App() {
  const [screen, setScreen] = useState<Screen>('start')
  const [booted, setBooted] = useState(false)
  const [transition, setTransition] = useState<{
    phase: TransitionPhase
    label: string
  } | null>(null)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [song, setSong] = useState<LoadedSong | null>(null)
  /** 对战开局数据。非空表示当前这一局是对战。 */
  const [battlePlay, setBattlePlay] = useState<BattleStart | null>(null)
  const [battleFinal, setBattleFinal] = useState<{
    players: BattlePlayerResult[]
    winnerId: string | null
  } | null>(null)
  const [result, setResult] = useState<GameResult | null>(null)
  const [audioState, setAudioState] = useState<AudioContextState>('suspended')

  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState({ stage: '', ratio: 0 })
  const [error, setError] = useState<string | null>(null)
  const transitionTimers = useRef<{
    prepare: number | null
    cover: number | null
    reveal: number | null
  }>({
    prepare: null,
    cover: null,
    reveal: null,
  })

  const handleBootComplete = useCallback(() => setBooted(true), [])

  /**
   * 所有页面跳转都从这里过：先给点击一个明确的反馈阶段，再让帘幕盖住旧页面，
   * 遮满后换 screen，最后缓慢退场露出新页面。
   */
  const navigate = useCallback(
    (next: Screen, label: string) => {
      if (next === screen || transition !== null) return

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const prepareMs = reducedMotion ? 120 : 380
      const coverMs = reducedMotion ? 390 : 1020
      const revealMs = reducedMotion ? 430 : 1050

      setTransition({ phase: 'prepare', label })
      transitionTimers.current.prepare = window.setTimeout(() => {
        setTransition({ phase: 'cover', label })
        transitionTimers.current.cover = window.setTimeout(() => {
          setScreen(next)
          setTransition({ phase: 'reveal', label })
          transitionTimers.current.reveal = window.setTimeout(() => {
            setTransition(null)
          }, revealMs)
        }, coverMs)
      }, prepareMs)
    },
    [screen, transition],
  )

  useEffect(
    () => () => {
      if (transitionTimers.current.prepare !== null) {
        window.clearTimeout(transitionTimers.current.prepare)
      }
      if (transitionTimers.current.cover !== null) {
        window.clearTimeout(transitionTimers.current.cover)
      }
      if (transitionTimers.current.reveal !== null) {
        window.clearTimeout(transitionTimers.current.reveal)
      }
    },
    [],
  )

  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  // 主题落到 <html data-theme>，由 styles.css 的主题块消费。
  // 游戏画布的那一半在 GameScreen 里单独取（canvas 拿不到 CSS 变量）。
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    // 浏览器地址栏/移动端状态栏的颜色。静态 meta 跟不上主题，这里同步一次。
    // 颜色写在 ThemeDef 里而不是在这里做三元：三套主题起就该有出处了。
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeDefOf(settings.theme).statusBar)
  }, [settings.theme])

  useEffect(() => onAudioStateChange(setAudioState), [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  /** 用户手势内解锁音频 —— iOS 必需。 */
  const handleStart = useCallback(async () => {
    try {
      await unlockAudio()
      setAudioState(getAudioContext().state)
      navigate('select', 'SELECT')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [navigate])

  /** 选曲 → 解码 → 分析 → 生成谱面。 */
  const handleFile = useCallback(
    async (file: File, difficulty: Difficulty, columns: 4 | 6) => {
      setError(null)
      setAnalyzing(true)
      setProgress({ stage: '读取音频', ratio: 0.02 })

      try {
        const ctx = getAudioContext()
        const buf = await file.arrayBuffer()
        setProgress({ stage: '解码音频', ratio: 0.06 })

        let decoded: DecodedAudio
        try {
          // decodeAudioData 可能转移（detach）传入的 ArrayBuffer。留一份原始字节，
          // 房主进入双人模式后要把它原样发给对手。
          decoded = await decodeArrayBuffer(buf.slice(0), ctx)
        } catch (e) {
          throw new Error(describeDecodeError(e))
        }

        // runAnalysis 会 transfer mono，调试页画波形还要用 decoded.mono，
        // 所以这里先复制一份再交出去。
        const analysis = await runAnalysis(decoded.mono.slice(), {
          fs: decoded.sampleRate,
          fingerprint: decoded.fingerprint,
          profile: settings.analysisProfile as AnalysisProfile,
          onProgress: (stage, ratio) => {
            // Worker 内部的 0-1 映射到整体的 0.12-0.9
            setProgress({ stage, ratio: 0.12 + ratio * 0.78 })
          },
        })

        const drumHits = drumHitsFromOnsets(analysis.onsets)

        setProgress({ stage: '生成谱面', ratio: 0.96 })
        const generated = generateChart(analysis, {
          difficulty,
          columns,
          title: file.name.replace(/\.[^.]+$/, ''),
        })

        setSong({
          decoded,
          analysis,
          generated,
          fileName: file.name,
          sourceBytes: buf,
          drumHits,
        })
        setBattlePlay(null)
        navigate('game', 'PLAY')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setAnalyzing(false)
        setProgress({ stage: '', ratio: 0 })
      }
    },
    [navigate, settings.analysisProfile],
  )

  /** 换难度重新生成谱面 —— 不需要重新分析音频。 */
  const regenerate = useCallback(
    (difficulty: Difficulty) => {
      if (!song) return
      const generated = generateChart(song.analysis, {
        difficulty,
        columns: settings.columns,
        title: song.fileName.replace(/\.[^.]+$/, ''),
      })
      setSong({ ...song, generated })
    },
    [song, settings.columns],
  )

  /** 对战的权威时间轴换算成本地单调时钟。 */
  const battleContext: BattleContext | undefined = useMemo(() => {
    if (!battlePlay) return undefined
    return {
      client: battlePlay.client,
      startAtLocalMs: battlePlay.client.serverToLocalMs(battlePlay.startAtServerMs),
      opponentLabel: battlePlay.opponentLabel,
    }
  }, [battlePlay])

  // 结算消息比本地最后一帧晚到；连接所有权在 App，等离开对战页后再释放。
  useEffect(() => {
    if (!battlePlay) {
      setBattleFinal(null)
      return
    }
    setBattleFinal(null)
    const unsubscribe = battlePlay.client.observe({
      onFinal: (players, winnerId) => setBattleFinal({ players, winnerId }),
    })
    return () => {
      unsubscribe()
      battlePlay.client.dispose()
    }
  }, [battlePlay])

  // 当前这一局要打的谱面与音频：对战优先，其次单机
  const activeChart: Chart | null = battlePlay?.chart ?? song?.generated.chart ?? null
  const activeBuffer: AudioBuffer | null = battlePlay?.audioBuffer ?? song?.decoded.buffer ?? null

  /**
   * 这一局要用的鼓点。
   *
   * 对战模式下必须再验一次音频指纹：鼓点是一串**绝对时刻**，只有打的是同一份
   * 音频才对得上。本地刚好分析过另一首歌时，直接沿用那份鼓点会让震动完全错拍——
   * 那比没有震动糟得多，所以指纹不匹配就退化成空数组。
   */
  const activeDrumHits: readonly DrumHit[] = useMemo(() => {
    if (!song || song.drumHits.length === 0) return NO_DRUM_HITS
    if (battlePlay && battlePlay.chart.meta.audioFingerprint !== song.analysis.fingerprint) {
      return NO_DRUM_HITS
    }
    return song.drumHits
  }, [song, battlePlay])

  const audioWarning = useMemo(() => {
    if (audioState === 'running') return null
    return '音频已暂停——可能被来电或其他应用打断，点这里继续'
  }, [audioState])

  return (
    <>
      {!booted && <EntryLoader onComplete={handleBootComplete} />}

      <div
        className="app"
        inert={!booted || transition !== null}
        aria-busy={transition !== null}
      >
        {audioWarning && screen !== 'start' && (
          <button
            className="ghost"
            style={{ margin: 8, color: 'var(--warning)' }}
            onClick={() => void unlockAudio()}
          >
            {audioWarning}
          </button>
        )}

        {screen === 'start' && (
          <StartScreen
            onStart={handleStart}
            onUnlock={() => void unlockAudio()}
            error={error}
          />
        )}

        {screen === 'select' && (
          <SongSelect
            settings={settings}
            onChange={updateSettings}
            analyzing={analyzing}
            progress={progress}
            error={error}
            songTitle={song?.fileName ?? null}
            onFile={handleFile}
            onCalibrate={() => navigate('calibrate', 'CALIBRATE')}
            onDebug={() => navigate('debug', 'DEBUG')}
            onBattle={() => navigate('lobby', 'BATTLE')}
            onPlayExisting={() => {
              setBattlePlay(null)
              navigate('game', 'PLAY')
            }}
          />
        )}

        {screen === 'lobby' && (
          <Lobby
            settings={settings}
            current={
              song
                ? {
                    chart: song.generated.chart,
                    decoded: song.decoded,
                    fileName: song.fileName,
                    sourceBytes: song.sourceBytes,
                  }
                : null
            }
            onStart={(payload) => {
              setBattlePlay(payload)
              navigate('game', 'VERSUS')
            }}
            onBack={() => navigate('select', 'SELECT')}
          />
        )}

        {screen === 'game' && activeChart && activeBuffer && (
          <GameScreen
            chart={activeChart}
            audioBuffer={activeBuffer}
            settings={settings}
            drumHits={activeDrumHits}
            battle={battleContext}
            onExit={() => {
              setBattlePlay(null)
              navigate('select', 'EXIT')
            }}
            onFinish={(r) => {
              setResult(r)
              navigate('result', 'RESULT')
            }}
          />
        )}

        {screen === 'result' && result && (
          <Results
            result={result}
            chart={activeChart}
            analysis={battlePlay ? null : (song?.analysis ?? null)}
            quality={battlePlay ? null : (song?.generated.quality ?? null)}
            isBattle={battlePlay != null}
            battleFinal={battleFinal?.players ?? null}
            battleWinnerId={battleFinal?.winnerId ?? null}
            battlePlayerId={battlePlay?.client.playerId ?? null}
            onRetry={() => navigate('game', 'RETRY')}
            onBack={() => {
              setBattlePlay(null)
              navigate('select', 'SELECT')
            }}
            onDifficulty={(d) => {
              updateSettings({ difficulty: d })
              regenerate(d)
            }}
          />
        )}

        {screen === 'calibrate' && (
          <Calibration
            settings={settings}
            onDone={(offsetMs) => {
              updateSettings({ userOffsetMs: offsetMs })
              navigate('select', 'SELECT')
            }}
            onBack={() => navigate('select', 'SELECT')}
          />
        )}

        {screen === 'debug' && (
          <DebugChart
            song={song}
            settings={settings}
            onChange={updateSettings}
            onBack={() => navigate('select', 'SELECT')}
          />
        )}
      </div>

      {transition && <ScreenTransition phase={transition.phase} label={transition.label} />}
    </>
  )
}
