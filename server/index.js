/**
 * 对战房间服务 —— Node + ws。
 *
 * 为什么自建而不是用 Cloudflare Durable Objects / Colyseus：
 *   - 我们只需要十来种消息、两人一房间，通用框架的抽象都要对抗
 *   - **现场演示的决定性优势**：跑在本机 localhost，RTT ≈ 0，网络风险归零
 *   - 零部署成本、无账号门槛
 *
 * 它同时托管 `dist/` 静态文件，所以演示时一个进程就够了：
 *   node server/index.js  →  http://localhost:8787
 *
 * 明确不做的事：分数校验、匹配系统、断线重连持久化、反作弊。
 * hackathon 演示不存在作弊动机，做校验要一天且毫无展示价值。
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8787)
const ROOT = fileURLToPath(new URL('../dist', import.meta.url))

// 与前端 protocol.ts 保持一致
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 4
const COUNTDOWN_LEAD_MS = 4000
/** 单个房间允许中转的音频上限，与前端 protocol.ts 保持一致。 */
const MAX_AUDIO_BYTES = 30 * 1024 * 1024
/** 房间空闲多久后回收（毫秒）。 */
const ROOM_TTL_MS = 30 * 60 * 1000

function gradeOf(score) {
  if (score >= 10000) return 'P'
  if (score >= 9000) return 'S'
  if (score >= 8000) return 'A'
  if (score >= 7000) return 'B'
  if (score >= 6000) return 'C'
  return 'D'
}

function normalizeCounts(counts) {
  return {
    perfect: Number(counts?.perfect ?? 0),
    great: Number(counts?.great ?? 0),
    good: Number(counts?.good ?? 0),
    miss: Number(counts?.miss ?? 0),
  }
}

/** @type {Map<string, Room>} */
const rooms = new Map()

// ─────────────────────────── 静态文件 ───────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')

    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'

    // 防目录穿越：normalize 会消掉 `..` 段，再剥掉可能残留的前导 `..`，
    // 然后用 join 把结果钉死在 ROOT 之内。
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
    const filePath = join(ROOT, safe)

    let body = null
    let contentType = MIME[extname(filePath)]

    try {
      body = await readFile(filePath)
    } catch {
      // 只有「导航请求」才回退到 index.html。
      // 若对 .js/.json 这类资源请求也回退，会把 HTML 当成 JS 喂给浏览器，
      // 报出一堆莫名其妙的语法错误，很难排查。
      const wantsHtml = (req.headers.accept ?? '').includes('text/html')
      if (wantsHtml) {
        try {
          body = await readFile(join(ROOT, 'index.html'))
          contentType = MIME['.html']
        } catch {
          body = null
        }
      }
    }

    if (body === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        '未找到。请先运行 npm run build 生成 dist/，开发时用 npm run dev 走 Vite 开发服务器。',
      )
      return
    }

    res.writeHead(200, {
      // 回退时 content-type 必须跟着实际返回的文件走，不能沿用它请求的路径
      'Content-Type': contentType ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(body)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('服务器内部错误')
  }
})

// ─────────────────────────── WebSocket ───────────────────────────

const wss = new WebSocketServer({ server })

let nextPlayerSeq = 1

function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = ''
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
    }
    if (!rooms.has(code)) return code
  }
  // 极端情况下退化为带时间戳的码，保证不会死循环
  return `R${Date.now().toString(36).toUpperCase().slice(-3)}`
}

class Room {
  constructor(code, hostId) {
    this.code = code
    this.hostId = hostId
    /** @type {Map<string, import('ws').WebSocket>} */
    this.players = new Map()
    /** @type {Map<string, string>} */
    this.tokens = new Map()
    this.chart = null
    this.fingerprint = null
    /** @type {Buffer | null} */
    this.audioBytes = null
    this.audioSize = 0
    this.audioOffset = 0
    this.audioFingerprint = null
    this.audioSourceId = null
    this.audioFileName = null
    this.audioComplete = false
    this.ready = new Set()
    /** @type {Map<string, object>} */
    this.finished = new Map()
    this.startAtServerMs = 0
    this.touchedAt = Date.now()
  }

  touch() {
    this.touchedAt = Date.now()
  }

  broadcast(msg, exceptId = null) {
    const payload = JSON.stringify(msg)
    for (const [id, ws] of this.players) {
      if (id === exceptId) continue
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  sendTo(playerId, msg) {
    const ws = this.players.get(playerId)
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  /** 把已保存的音频分块发给指定玩家。 */
  sendAudioTo(playerId) {
    if (!this.audioComplete || !this.audioBytes || !this.audioFingerprint || !this.audioSourceId) {
      return
    }
    const ws = this.players.get(playerId)
    if (!ws || ws.readyState !== ws.OPEN) return

    send(ws, {
      t: 'AUDIO_BEGIN',
      size: this.audioSize,
      fingerprint: this.audioFingerprint,
      sourceId: this.audioSourceId,
      fileName: this.audioFileName,
    })
    const chunkSize = 256 * 1024
    for (let offset = 0; offset < this.audioBytes.byteLength; offset += chunkSize) {
      ws.send(this.audioBytes.subarray(offset, Math.min(offset + chunkSize, this.audioBytes.byteLength)))
    }
    send(ws, { t: 'AUDIO_END' })
  }

  /** 双方都按下准备后，下发权威时间轴。 */
  maybeStart() {
    if (this.players.size !== 2) return
    if (this.ready.size !== 2) return
    if (this.startAtServerMs > 0) return
    if (!this.chart) return
    if (!this.audioComplete) return

    this.startAtServerMs = Date.now() + COUNTDOWN_LEAD_MS
    this.broadcast({
      t: 'COUNTDOWN',
      startAtServerMs: this.startAtServerMs,
      leadMs: COUNTDOWN_LEAD_MS,
    })
    console.log(
      `[room ${this.code}] 开局，startAt=${this.startAtServerMs}（+${COUNTDOWN_LEAD_MS}ms）`,
    )
  }

  /** 双方都上报结束后出结果。 */
  maybeFinish() {
    if (this.players.size < 2) return
    if (this.finished.size < 2) return

    const players = [...this.finished.entries()].map(([playerId, r]) => ({
      playerId,
      score: r.score,
      accuracy: r.accuracy,
      maxCombo: r.maxCombo,
      grade: gradeOf(r.score),
      counts: normalizeCounts(r.counts),
      totalNotes: this.chart?.notes?.length ?? 0,
    }))
    players.sort((a, b) => b.score - a.score || b.accuracy - a.accuracy)

    const top = players[0]
    const second = players[1]
    const tied = second && top.score === second.score && top.accuracy === second.accuracy
    const winnerId = tied ? null : (top?.playerId ?? null)

    this.broadcast({ t: 'FINAL_RESULT', players, winnerId })
    console.log(`[room ${this.code}] 结算：`, players.map((p) => `${p.playerId}=${p.score}`).join(' '))
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

wss.on('connection', (ws) => {
  let playerId = `P${nextPlayerSeq++}`
  /** @type {Room | null} */
  let room = null

  ws.on('message', (raw, isBinary) => {
    // 二进制帧只用于房主上传音频，必须在 JSON 解析之前分流。
    if (isBinary) {
      if (
        room &&
        room.players.has(playerId) &&
        playerId === room.hostId &&
        room.audioBytes &&
        !room.audioComplete
      ) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        if (room.audioOffset + chunk.byteLength > room.audioSize) {
          send(ws, { t: 'ERROR', message: '音频上传超出声明大小' })
          room.audioBytes = null
          room.audioOffset = 0
          return
        }
        chunk.copy(room.audioBytes, room.audioOffset)
        room.audioOffset += chunk.byteLength
        room.touch()
      }
      return
    }

    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!msg || typeof msg.t !== 'string') return

    // ── 时钟同步：不依赖房间，随时可应答 ──
    if (msg.t === 'PING') {
      // t1/t2 分别取"收到的瞬间"和"发出的瞬间"，让客户端能扣掉服务端处理耗时
      const t1 = Date.now()
      send(ws, { t: 'PONG', cid: msg.cid, t0: msg.t0, t1, t2: Date.now() })
      return
    }

    if (msg.t === 'CREATE_ROOM') {
      if (room) {
        room.players.delete(playerId)
        if (room.hostId === playerId) rooms.delete(room.code)
      }
      const code = generateRoomCode()
      const resumeToken = randomBytes(18).toString('base64url')
      room = new Room(code, playerId)
      room.players.set(playerId, ws)
      room.tokens.set(playerId, resumeToken)
      rooms.set(code, room)
      send(ws, { t: 'ROOM_CREATED', roomCode: code, playerId, resumeToken })
      console.log(`[room ${code}] 创建，房主 ${playerId}`)
      return
    }

    if (msg.t === 'JOIN_ROOM') {
      const code = String(msg.roomCode ?? '').toUpperCase()
      const target = rooms.get(code)
      if (!target) {
        send(ws, { t: 'ERROR', message: '房间不存在，请检查房间码' })
        return
      }
      if (target.players.size >= 2) {
        send(ws, { t: 'ERROR', message: '房间已满' })
        return
      }
      if (room) room.players.delete(playerId)
      room = target
      const resumeToken = randomBytes(18).toString('base64url')
      room.players.set(playerId, ws)
      room.tokens.set(playerId, resumeToken)
      room.touch()
      send(ws, { t: 'JOINED', roomCode: code, playerId, resumeToken })
      room.broadcast({ t: 'PLAYER_JOINED', playerId }, playerId)
      // 晚加入的玩家需要补收房间当前状态，否则房主已经选曲/准备时双方会卡住。
      if (room.chart) {
        send(ws, { t: 'CHART_RECEIVED', chart: room.chart, fingerprint: room.fingerprint })
      }
      if (room.audioComplete) room.sendAudioTo(playerId)
      if (room.ready.has(room.hostId)) {
        send(ws, { t: 'OPPONENT_READY', ready: true })
      }
      console.log(`[room ${code}] ${playerId} 加入（${room.players.size}/2）`)
      return
    }

    if (msg.t === 'REJOIN_ROOM') {
      const code = String(msg.roomCode ?? '').toUpperCase()
      const resumedPlayerId = String(msg.playerId ?? '')
      const resumeToken = String(msg.resumeToken ?? '')
      const target = rooms.get(code)
      if (!target || target.tokens.get(resumedPlayerId) !== resumeToken) {
        send(ws, { t: 'ERROR', message: '原房间已失效，请重新创建或加入房间' })
        return
      }

      if (room && room !== target) room.players.delete(playerId)
      const previous = target.players.get(resumedPlayerId)
      playerId = resumedPlayerId
      room = target
      room.players.set(playerId, ws)
      room.touch()

      // 旧连接若还开着，替换后直接关闭；close 处理器会校验 ws 身份，不会误删新连接。
      if (previous && previous !== ws) {
        try {
          previous.close(4001, 'reconnected')
        } catch {
          // 忽略
        }
      }

      const opponentId = [...room.players.keys()].find((id) => id !== playerId) ?? null
      send(ws, {
        t: 'ROOM_RESUMED',
        roomCode: code,
        playerId,
        isHost: playerId === room.hostId,
        opponentPresent: opponentId !== null,
      })
      if (room.chart) {
        send(ws, { t: 'CHART_RECEIVED', chart: room.chart, fingerprint: room.fingerprint })
      }
      if (playerId !== room.hostId && room.audioComplete) {
        room.sendAudioTo(playerId)
      }
      if (opponentId) {
        room.sendTo(opponentId, { t: 'PLAYER_JOINED', playerId })
        room.sendTo(playerId, {
          t: 'OPPONENT_READY',
          ready: room.ready.has(opponentId),
        })
      }
      console.log(`[room ${code}] ${playerId} 已重连`)
      return
    }

    // 以下消息都必须已在房间内
    if (!room || !room.players.has(playerId)) return
    room.touch()

    switch (msg.t) {
      case 'SUBMIT_CHART': {
        room.chart = msg.chart
        room.fingerprint = msg.fingerprint
        room.ready.clear()
        room.broadcast({ t: 'OPPONENT_READY', ready: false })
        // 回执给房主，谱面转发给对手
        send(ws, { t: 'CHART_RECEIVED', chart: msg.chart, fingerprint: msg.fingerprint })
        room.broadcast({ t: 'CHART_RECEIVED', chart: msg.chart, fingerprint: msg.fingerprint }, playerId)
        break
      }

      case 'AUDIO_BEGIN': {
        if (playerId !== room.hostId) {
          send(ws, { t: 'ERROR', message: '只有房主可以发送歌曲' })
          break
        }
        const size = Number(msg.size)
        if (!Number.isInteger(size) || size <= 0 || size > MAX_AUDIO_BYTES) {
          send(ws, { t: 'ERROR', message: '音频文件必须在 30MB 以内' })
          break
        }
        room.audioBytes = Buffer.allocUnsafe(size)
        room.audioSize = size
        room.audioOffset = 0
        room.audioFingerprint = String(msg.fingerprint ?? '')
        room.audioSourceId = String(msg.sourceId ?? '')
        room.audioFileName = String(msg.fileName ?? 'battle-audio')
        room.audioComplete = false
        room.ready.clear()
        room.broadcast({ t: 'OPPONENT_READY', ready: false })
        break
      }

      case 'AUDIO_END': {
        if (playerId !== room.hostId || !room.audioBytes) {
          send(ws, { t: 'ERROR', message: '没有可完成的音频上传' })
          break
        }
        if (room.audioOffset !== room.audioSize) {
          send(ws, { t: 'ERROR', message: '音频上传不完整，请重试' })
          room.audioBytes = null
          room.audioOffset = 0
          break
        }
        room.audioComplete = true
        send(ws, { t: 'AUDIO_ACCEPTED' })
        for (const id of room.players.keys()) {
          if (id !== playerId) room.sendAudioTo(id)
        }
        room.maybeStart()
        console.log(`[room ${room.code}] 音频已接收（${(room.audioSize / 1024 / 1024).toFixed(1)}MB）`)
        break
      }

      case 'READY': {
        if (msg.ready) room.ready.add(playerId)
        else room.ready.delete(playerId)
        room.broadcast({ t: 'OPPONENT_READY', ready: Boolean(msg.ready) }, playerId)
        room.maybeStart()
        break
      }

      case 'SCORE_UPDATE': {
        room.broadcast(
          {
            t: 'OPPONENT_SCORE',
            score: msg.score,
            combo: msg.combo,
            maxCombo: msg.maxCombo,
            accuracy: msg.accuracy,
            progress: msg.progress,
          },
          playerId,
        )
        break
      }

      case 'FINISH': {
        room.finished.set(playerId, {
          score: msg.score,
          accuracy: msg.accuracy,
          maxCombo: msg.maxCombo,
          counts: normalizeCounts(msg.counts),
        })
        room.broadcast(
          {
            t: 'OPPONENT_FINISHED',
            score: msg.score,
            accuracy: msg.accuracy,
            maxCombo: msg.maxCombo,
          },
          playerId,
        )
        room.maybeFinish()
        break
      }

      case 'LEAVE': {
        room.players.delete(playerId)
        room.ready.delete(playerId)
        room.broadcast({ t: 'PLAYER_LEFT', playerId })
        if (room.players.size === 0) rooms.delete(room.code)
        room = null
        break
      }
    }
  })

  ws.on('close', () => {
    if (!room) return
    // 同一座位的新连接已经顶上时，旧连接关闭不能删掉新连接。
    if (room.players.get(playerId) !== ws) return
    room.players.delete(playerId)
    room.ready.delete(playerId)
    room.broadcast({ t: 'PLAYER_LEFT', playerId })
    // 对手掉线不中断本局——本地继续打完并记录成绩
    if (room.players.size === 0) {
      // 保留空房间一个 TTL，给双方短暂断网自动重连的机会。
      console.log(`[room ${room.code}] 暂时无人，等待重连`)
    }
  })
})

// 定期清理超时房间，防止内存泄漏
setInterval(
  () => {
    const now = Date.now()
    for (const [code, room] of rooms) {
      if (now - room.touchedAt > ROOM_TTL_MS) {
        rooms.delete(code)
        console.log(`[room ${code}] 超时回收`)
      }
    }
  },
  5 * 60 * 1000,
).unref?.()

server.listen(PORT, () => {
  console.log(`\n  Rhythm Forge 对战服务已启动`)
  console.log(`  HTTP   http://localhost:${PORT}`)
  console.log(`  WS     ws://localhost:${PORT}`)
  console.log(`\n  现场演示：两台设备连同一 WiFi，浏览器打开上面的 HTTP 地址即可。\n`)
})
