/**
 * 结算页。
 *
 * 单人模式下会把「这份谱面是怎么来的」完整摊开——BPM 置信度、量化残差、
 * 降级级别、轨道分布。这既是给玩家看的，也是开发时的诊断面板：
 * 谱面手感不对时，第一眼就能看出是分析出了问题还是生成出了问题。
 *
 * 对战模式下没有本地分析数据（对手的谱面是收来的），所以这些区块自动隐藏。
 */

import type { Chart, Difficulty, TrackAnalysis } from '../types'
import type { GameResult } from '../core/engine'
import type { LaneQualityReport } from '../chartgen/lanes'
import { chartStats } from '../chartgen/serialize'

interface Props {
  result: GameResult
  chart: Chart | null
  analysis: TrackAnalysis | null
  quality: LaneQualityReport | null
  isBattle: boolean
  onRetry: () => void
  onBack: () => void
  onDifficulty: (d: Difficulty) => void
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
}

export function Results({
  result,
  chart,
  analysis,
  quality,
  isBattle,
  onRetry,
  onBack,
  onDifficulty,
}: Props) {
  const stats = chart ? chartStats(chart) : null
  const diag = analysis?.diagnostics ?? null

  return (
    <div className="screen">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div className="grade">{result.grade}</div>
        <div>
          <h1 style={{ fontSize: 20 }}>{result.score.toLocaleString()}</h1>
          <p className="muted">
            准确率 {(result.accuracy * 100).toFixed(2)}% · 最大连击 {result.maxCombo}
            {isBattle && ' · 对战'}
          </p>
        </div>
      </div>

      <div className="stat-grid">
        {(['perfect', 'great', 'good', 'miss'] as const).map((k) => (
          <div className="stat" key={k}>
            <div className="k">{k.toUpperCase()}</div>
            <div className="v">{result.counts[k]}</div>
          </div>
        ))}
      </div>

      {isBattle && (
        <div className="card">
          <h2>对战说明</h2>
          <p className="muted">
            判定完全在本地做，不跨网同步——网络抖动不会影响你的手感，
            它只影响顶部对手进度条的刷新。这是音游对战的标准取舍：
            共享时间轴 + 判定容忍窗口，不做回滚网络码。
          </p>
        </div>
      )}

      {diag && analysis && (
        <div className="card">
          <h2>这份谱面是怎么来的</h2>
          <p className="muted">
            检测速度 {analysis.bpm.toFixed(1)} BPM（置信度{' '}
            {(analysis.bpmConfidence * 100).toFixed(0)}%） · 网格细分 1/{analysis.subdivision}
            <br />
            起音 {analysis.onsets.length} 个 → 成谱 {result.totalNotes} 个音符
            <br />
            量化残差中位数 {diag.medianResidualMs.toFixed(1)}ms · 容差内占比{' '}
            {(diag.withinToleranceRatio * 100).toFixed(1)}%
          </p>
          <div style={{ marginTop: 12 }}>
            <span
              className={
                'badge ' +
                (diag.quality === 'good' ? 'good' : diag.quality === 'degraded' ? 'warn' : 'bad')
              }
            >
              {diag.quality === 'good'
                ? '分析质量良好'
                : diag.quality === 'degraded'
                  ? '分析已降级'
                  : '依赖兜底模式'}
            </span>
          </div>
          {diag.notes.length > 0 && (
            <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
              {diag.notes.map((n, i) => (
                <div className="note" key={i}>
                  {n}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {quality && stats && chart && (
        <div className="card">
          <h2>谱面分布</h2>
          <p className="muted">
            {chart.columns} 轨使用率 {quality.laneUsage.map((u) => `${(u * 100).toFixed(0)}%`).join(' / ')}{' '}
            · 平均轨距 {quality.meanLaneDelta.toFixed(2)} · 同轨连击 {quality.jackCount} 次
            <br />
            音符密度 {stats.density.toFixed(2)}/秒
          </p>
          {quality.collapsed && (
            <p style={{ color: 'var(--warning)', marginTop: 8 }}>
              提示：这份谱面的轨道分布偏集中，说明这段音乐的音色变化较少。
            </p>
          )}
        </div>
      )}

      {!isBattle && (
        <>
          <h2 style={{ fontSize: 15 }}>换个难度再来（不用重新分析）</h2>
          <div className="seg">
            {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
              <button key={d} data-active={chart?.difficulty === d} onClick={() => onDifficulty(d)}>
                {DIFFICULTY_LABELS[d]}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="row">
        <button className="primary" style={{ flex: 1 }} onClick={onRetry} disabled={isBattle}>
          {isBattle ? '对战已结束' : '再打一次'}
        </button>
        <button className="ghost" onClick={onBack}>
          {isBattle ? '返回大厅' : '换一首'}
        </button>
      </div>
    </div>
  )
}
