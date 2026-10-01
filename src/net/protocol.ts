/**
 * 联机协议 —— 前后端共享的消息类型定义。
 *
 * 协议刻意做得极小（十来种消息）。我们需要的不是通用房间框架，
 * 而是"两人用同一份谱面同时开打"这一件事，自己写比对抗
 * Colyseus 的状态同步模型或 Durable Objects 的存储抽象都省事。
 *
 * 时间戳约定：所有 `*Ms` 都是**毫秒**。客户端时间用
 * `performance.timeOrigin + performance.now()`（单调，不受系统对时影响），
 * 服务端用 `Date.now()`，两者靠 NTP 式握手换算。
 */

import type { Chart } from '../types'

// ─────────────────────────── 客户端 → 服务端 ───────────────────────────

export type ClientMessage =
  /** 时钟同步请求。`t0` 为客户端发出时刻。 */
  | { t: 'PING'; cid: number; t0: number }
  | { t: 'CREATE_ROOM' }
  | { t: 'JOIN_ROOM'; roomCode: string }
  /** 网络断开后恢复原座位，服务端按 token 校验。 */
  | { t: 'REJOIN_ROOM'; roomCode: string; playerId: string; resumeToken: string }
  /** 房主提交谱面，服务端转发给对手。 */
  | { t: 'SUBMIT_CHART'; chart: Chart; fingerprint: string }
  /**
   * 房主上传原始音频。元数据走 JSON，音频块走紧随其后的二进制 WebSocket 消息，
   * 最后以 AUDIO_END 收尾。
   */
  | {
      t: 'AUDIO_BEGIN'
      size: number
      fingerprint: string
      sourceId: string
      fileName: string
    }
  | { t: 'AUDIO_END' }
  | { t: 'READY'; ready: boolean }
  /** 节流上报（2Hz 足够画个进度条）。 */
  | {
      t: 'SCORE_UPDATE'
      score: number
      combo: number
      maxCombo: number
      accuracy: number
      progress: number
    }
  | { t: 'FINISH'; score: number; accuracy: number; maxCombo: number }
  | { t: 'LEAVE' }

// ─────────────────────────── 服务端 → 客户端 ───────────────────────────

export type ServerMessage =
  /**
   * 时钟同步应答。
   * `t1` = 服务端收到 PING 的时刻，`t2` = 服务端发出 PONG 的时刻。
   * 两者之差就是服务端的处理耗时，需要从 RTT 里扣除。
   */
  | { t: 'PONG'; cid: number; t0: number; t1: number; t2: number }
  | { t: 'ROOM_CREATED'; roomCode: string; playerId: string; resumeToken: string }
  | { t: 'JOINED'; roomCode: string; playerId: string; resumeToken: string }
  | {
      t: 'ROOM_RESUMED'
      roomCode: string
      playerId: string
      isHost: boolean
      opponentPresent: boolean
    }
  | { t: 'PLAYER_JOINED'; playerId: string }
  | { t: 'PLAYER_LEFT'; playerId: string }
  | { t: 'ERROR'; message: string }
  /** 房主收到的回执 / 对手收到的谱面。 */
  | { t: 'CHART_RECEIVED'; chart: Chart; fingerprint: string }
  /** 服务端已完整保存房主上传的音频。 */
  | { t: 'AUDIO_ACCEPTED' }
  /** 加入者开始接收房主音频；随后是二进制块和 AUDIO_END。 */
  | {
      t: 'AUDIO_BEGIN'
      size: number
      fingerprint: string
      sourceId: string
      fileName: string
    }
  | { t: 'AUDIO_END' }
  | { t: 'OPPONENT_READY'; ready: boolean }
  /** ★ 权威时间轴：双方都必须在 `startAtServerMs` 这一刻开始播放。 */
  | { t: 'COUNTDOWN'; startAtServerMs: number; leadMs: number }
  | {
      t: 'OPPONENT_SCORE'
      score: number
      combo: number
      maxCombo: number
      accuracy: number
      progress: number
    }
  | { t: 'OPPONENT_FINISHED'; score: number; accuracy: number; maxCombo: number }
  | {
      t: 'FINAL_RESULT'
      players: { playerId: string; score: number; accuracy: number; maxCombo: number }[]
      winnerId: string | null
    }

/** 房间码字符集：去掉 0/O/1/I 这些容易看错的。 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 4

/** 单个房间允许中转的音频上限。超过时必须给出明确错误，不能把服务端内存打满。 */
export const MAX_BATTLE_AUDIO_BYTES = 30 * 1024 * 1024

/**
 * 原始音频字节的传输 ID。
 *
 * 不能用解码后的 PCM 指纹做联机校验：不同浏览器/设备的解码器对同一个 MP3
 * 可能产出极小差异的浮点结果，导致同一份文件被误判为不匹配。
 * 这里直接对传输的原始字节采样哈希，确保加入者拿到的是房主上传的那份文件。
 */
export function battleAudioIdOf(audio: ArrayBuffer | Uint8Array): string {
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
  const stride = Math.max(1, Math.floor(bytes.byteLength / 65_536))
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.byteLength; i += stride) {
    hash ^= bytes[i] ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `${bytes.byteLength}-${(hash >>> 0).toString(36)}`
}

/** 服务器下发的提前量（毫秒）。够双方加载音频、切换界面。 */
export const COUNTDOWN_LEAD_MS = 4000

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  return [...code.toUpperCase()].every((c) => ROOM_CODE_ALPHABET.includes(c))
}
