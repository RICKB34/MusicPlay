/**
 * 对战服务冒烟测试 —— 模拟两个玩家完成一整套流程。
 *
 * 不依赖浏览器，所以可以在启动服务后立刻验证协议是否正确：
 *   建房 → 加入 → 时钟同步 → 提交谱面与音频 → 双方准备 → 收到开局时间轴
 *   → 上报分数 → 双方结束 → 收到结算
 *
 * 用法：先 `node server/index.js`，再 `node server/smoke-test.mjs`
 */

import WebSocket from 'ws'

const URL = process.env.WS_URL ?? 'ws://localhost:8787'
const TIMEOUT_MS = 15000

function makePlayer(label) {
  const ws = new WebSocket(URL)
  const received = []
  const audioChunks = []
  const waiters = []

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      audioChunks.push(Buffer.from(raw))
      return
    }
    const msg = JSON.parse(String(raw))
    received.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters[i].resolve(msg)
        waiters.splice(i, 1)
      }
    }
  })

  const api = {
    label,
    ws,
    received,
    audioChunks,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** 等一条满足条件的消息。 */
    waitFor: (predicate, description) =>
      new Promise((resolve, reject) => {
        const existing = received.find(predicate)
        if (existing) return resolve(existing)
        const timer = setTimeout(
          () => reject(new Error(`[${label}] 超时等待：${description}`)),
          TIMEOUT_MS,
        )
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          },
        })
      }),
    open: () => new Promise((res, rej) => {
      ws.once('open', res)
      ws.once('error', rej)
    }),
    close: () => ws.close(),
  }
  return api
}

/** NTP 式时钟同步，跑 5 轮取 RTT 最小的样本。 */
async function syncClock(player) {
  const samples = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.timeOrigin + performance.now()
    player.send({ t: 'PING', cid: i, t0 })
    const pong = await player.waitFor((m) => m.t === 'PONG' && m.cid === i, `PONG ${i}`)
    const t3 = performance.timeOrigin + performance.now()
    const rtt = t3 - t0 - (pong.t2 - pong.t1)
    const offset = (pong.t1 - t0 + (pong.t2 - t3)) / 2
    samples.push({ rtt, offset })
    await new Promise((r) => setTimeout(r, 60))
  }
  samples.sort((a, b) => a.rtt - b.rtt)
  return samples[0]
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log(`\n对战服务冒烟测试 → ${URL}\n`)

  const host = makePlayer('房主')
  let guest = makePlayer('对手')
  await Promise.all([host.open(), guest.open()])
  check('两个客户端都能连上服务器', true)

  // ── 时钟同步 ──
  const hostSync = await syncClock(host)
  check('NTP 式时钟同步收敛', hostSync.rtt >= 0, `RTT ${hostSync.rtt.toFixed(1)}ms`)

  // ── 建房 ──
  host.send({ t: 'CREATE_ROOM' })
  const created = await host.waitFor((m) => m.t === 'ROOM_CREATED', 'ROOM_CREATED')
  check('建房成功并拿到房间码', /^[A-Z0-9]{4}$/.test(created.roomCode), `房间码 ${created.roomCode}`)

  // ── 加入 ──
  guest.send({ t: 'JOIN_ROOM', roomCode: created.roomCode })
  const joined = await guest.waitFor((m) => m.t === 'JOINED', 'JOINED')
  check('对手加入成功', joined.roomCode === created.roomCode)
  await host.waitFor((m) => m.t === 'PLAYER_JOINED', 'PLAYER_JOINED')
  check('房主收到「对手已加入」通知', true)

  // ── 错误房间码 ──
  const third = makePlayer('路人')
  await third.open()
  third.send({ t: 'JOIN_ROOM', roomCode: 'ZZZZ' })
  const err = await third.waitFor((m) => m.t === 'ERROR', 'ERROR')
  check('无效房间码被正确拒绝', err.message.includes('不存在'), err.message)
  third.close()

  // ── 提交谱面 ──
  const fakeChart = {
    version: 1,
    meta: {
      title: '冒烟测试',
      audioFingerprint: 'test-fp-123',
      durationMs: 10000,
      bpm: 120,
      bpmConfidence: 1,
      gridOffsetMs: 0,
      subdivision: 2,
      source: 'auto',
    },
    columns: 4,
    difficulty: 'normal',
    notes: [
      { t: 1000, col: 0, type: 0 },
      { t: 1500, col: 3, type: 0 },
    ],
  }
  host.send({ t: 'SUBMIT_CHART', chart: fakeChart, fingerprint: 'test-fp-123' })
  const relayed = await guest.waitFor((m) => m.t === 'CHART_RECEIVED', 'CHART_RECEIVED')
  check(
    '谱面正确转发给对手',
    relayed.chart?.notes?.length === 2 && relayed.fingerprint === 'test-fp-123',
  )

  // ── 音频中转：加入者不再本地选歌，必须收到房主上传的原始字节 ──
  const audio = Buffer.from('SYNTHETIC-BATTLE-AUDIO')
  const audioEndPromise = guest.waitFor((m) => m.t === 'AUDIO_END', 'AUDIO_END')
  host.send({
    t: 'AUDIO_BEGIN',
    size: audio.byteLength,
    fingerprint: 'test-fp-123',
    sourceId: `raw-${audio.byteLength}`,
    fileName: 'smoke.mp3',
  })
  host.ws.send(audio)
  host.send({ t: 'AUDIO_END' })

  await host.waitFor((m) => m.t === 'AUDIO_ACCEPTED', 'AUDIO_ACCEPTED')
  const audioBegin = await guest.waitFor((m) => m.t === 'AUDIO_BEGIN', 'AUDIO_BEGIN')
  await audioEndPromise
  const guestAudio = Buffer.concat(guest.audioChunks)
  check(
    '房主音频完整转发给加入者',
    audioBegin.size === audio.byteLength &&
      audioBegin.sourceId === `raw-${audio.byteLength}` &&
      guestAudio.equals(audio),
    `${guestAudio.byteLength} bytes`,
  )

  // ── 断线重连：短暂断网后恢复原座位，而不是变成第三个玩家 ──
  const resumeLeftPromise = host.waitFor((m) => m.t === 'PLAYER_LEFT', '对手断开')
  guest.close()
  await resumeLeftPromise
  const resumed = makePlayer('重连后的对手')
  await resumed.open()
  resumed.send({
    t: 'REJOIN_ROOM',
    roomCode: created.roomCode,
    playerId: joined.playerId,
    resumeToken: joined.resumeToken,
  })
  const resumedAck = await resumed.waitFor((m) => m.t === 'ROOM_RESUMED', 'ROOM_RESUMED')
  await host.waitFor((m) => m.t === 'PLAYER_JOINED', '对手重连')
  check(
    '对手能回到原房间和原座位',
    resumedAck.playerId === joined.playerId && resumedAck.isHost === false,
  )
  guest = resumed

  // ── 双方准备 → 权威时间轴 ──
  const startAtPromise = Promise.all([
    host.waitFor((m) => m.t === 'COUNTDOWN', '房主 COUNTDOWN'),
    guest.waitFor((m) => m.t === 'COUNTDOWN', '对手 COUNTDOWN'),
  ])
  host.send({ t: 'READY', ready: true })
  guest.send({ t: 'READY', ready: true })
  const [hostStart, guestStart] = await startAtPromise

  check(
    '双方收到同一个开局时间戳',
    hostStart.startAtServerMs === guestStart.startAtServerMs,
    `startAt=${hostStart.startAtServerMs}`,
  )
  const remaining = hostStart.startAtServerMs - Date.now()
  check(
    '开局提前量合理（未来 0-6 秒）',
    remaining > 0 && remaining < 6000,
    `还剩 ${remaining}ms`,
  )

  // ── 分数上报 ──
  host.send({ t: 'SCORE_UPDATE', score: 12345, combo: 50, maxCombo: 50, accuracy: 0.95, progress: 0.5 })
  const oppScore = await guest.waitFor((m) => m.t === 'OPPONENT_SCORE', 'OPPONENT_SCORE')
  check('分数实时同步给对手', oppScore.score === 12345)

  // ── 双方结束 → 结算 ──
  const finalPromise = Promise.all([
    host.waitFor((m) => m.t === 'FINAL_RESULT', '房主结算'),
    guest.waitFor((m) => m.t === 'FINAL_RESULT', '对手结算'),
  ])
  host.send({
    t: 'FINISH',
    score: 9000,
    accuracy: 0.9,
    maxCombo: 40,
    counts: { perfect: 80, great: 10, good: 5, miss: 5 },
  })
  guest.send({
    t: 'FINISH',
    score: 12345,
    accuracy: 0.95,
    maxCombo: 50,
    counts: { perfect: 90, great: 5, good: 3, miss: 2 },
  })
  const [final] = await finalPromise

  check('结算生成且排序正确', final.players[0].score === 12345)
  check(
    '双方结算包含等级和各判定数量',
    final.players[0].grade === 'P' &&
      final.players[0].counts.perfect === 90 &&
      final.players[1].counts.miss === 5,
  )
  check('胜者判定正确', final.winnerId === joined.playerId, `winner=${final.winnerId}`)

  // ── 断线通知 ──
  const leftPromise = host.waitFor((m) => m.t === 'PLAYER_LEFT', 'PLAYER_LEFT')
  guest.close()
  await leftPromise
  check('对手掉线时收到通知', true)

  host.close()

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n冒烟测试失败：', e.message, '\n')
  process.exit(1)
})
