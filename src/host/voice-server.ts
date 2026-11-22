/**
 * 宿主侧 /voice WebSocket：浏览器麦克风 PCM -> 百炼流式 ASR -> partial 上屏；
 * 句末（final）可选地再跑一次“口语转书面”，把增量推回浏览器。
 *
 * 协议（一条 WebSocket，JSON 控制帧 + 二进制 PCM）：
 *   browser -> host:
 *     binary                                  16 kHz Int16 单声道 PCM
 *     {"type":"config","context":"<词表>","polish":true,"dshSessionId":"..."}
 *     {"type":"asr_start"} / {"type":"asr_end"} / {"type":"asr_cancel"}
 *     {"type":"polish","id":"...","text":"..."}
 *   host -> browser:
 *     {"type":"ready","voiceSessionId","asr":"dashscope","polish":true,"hasKey":true}
 *     {"type":"asr_partial","utteranceId","text","sequence"}
 *     {"type":"asr_final","utteranceId","text","sequence"}
 *     {"type":"polish_chunk","id","text","sequence"}   增量片段
 *     {"type":"polish_done","id","text","sequence"}    整理后的全文
 *     {"type":"error","message","sequence"}
 *
 * 每个连接一个 VoiceSession；同一时刻只允许一个 ASR utterance；
 * PCM 走有界队列（BoundedQueue），不做无界 Buffer.concat。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { polishStream } from './dashscope.ts'
import { AsrUtterance } from './asr-utterance.ts'
import { isTrustedVoiceRequest, readVoiceOperator, rejectWebSocketUpgrade, type VoiceAdmit } from './voice-trust.ts'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 临时诊断日志：升级被拒时写一行到系统临时目录，便于排查“后端未启动”。 */
function logLine(line: string): void {
  try {
    appendFileSync(join(tmpdir(), 'dsh-voice-weld.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_CONNECTIONS = 8
const MAX_SESSION_MS = 60 * 60 * 1000
/** 能量门限：静音帧不启动新的识别回合。 */
const VOICE_RMS_THRESHOLD = 300
/** 词表上限（百炼 input.context 单轮 400 字符）。 */
const MAX_CONTEXT_CHARS = 400

function hasVoiceEnergy(pcm: Buffer, threshold = VOICE_RMS_THRESHOLD): boolean {
  const n = Math.floor(pcm.length / 2)
  if (n === 0) return false
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / n) > threshold
}

export interface VoiceServerOptions {
  /** 百炼 api key（DASHSCOPE_API_KEY）。 */
  apiKey: string
  /** 顺稿模型，默认 qwen-flash（OpenAI 兼容端点）。 */
  polishModel?: string
  /** 打断朗读时取消对应 DSH 会话（保留给未来的 barge-in）。 */
  cancelAgent?: (dshSessionId: string) => void
  admit?: VoiceAdmit
}

export class VoiceSession {
  readonly voiceSessionId = randomUUID()
  private context = ''
  private polishEnabled = true
  private acceptingAudio = false
  private disposed = false
  private currentUt: AsrUtterance | null = null
  private utSeq = 0
  private msgSeq = 0
  private polishAbort: AbortController | null = null
  private polishSeq = 0

  constructor(
    private readonly ws: WebSocket,
    private readonly options: VoiceServerOptions,
  ) {}

  applyConfig(data: Record<string, unknown>): void {
    if (typeof data.context === 'string') this.context = data.context.slice(0, MAX_CONTEXT_CHARS)
    if (typeof data.polish === 'boolean') this.polishEnabled = data.polish
  }

  feedAudio(pcm: Buffer): void {
    if (!this.acceptingAudio || this.disposed) return
    if (this.currentUt === null) {
      if (!hasVoiceEnergy(pcm)) return
      this.startUtterance()
    }
    const ut = this.currentUt
    if (ut !== null && !ut.push(pcm)) {
      ut.cancel()
      if (this.currentUt === ut) this.currentUt = null
      this.acceptingAudio = false
      this.send({ type: 'error', message: 'asr: audio queue overflow' })
    }
  }

  asrStart(): void {
    if (this.disposed) return
    this.currentUt?.cancel()
    this.currentUt = null
    this.acceptingAudio = true
  }

  private startUtterance(): void {
    const id = String(++this.utSeq)
    const session = this.voiceSessionId
    const ut = new AsrUtterance(
      this.options.apiKey,
      id,
      (text) => {
        if (this.currentUt === ut) this.currentUt = null
        this.acceptingAudio = false
        this.send({ type: 'asr_final', voiceSessionId: session, utteranceId: id, text })
        if (this.polishEnabled) void this.requestPolish(`u${id}`, text)
      },
      (text) => {
        this.send({ type: 'asr_partial', voiceSessionId: session, utteranceId: id, text })
      },
      (err) => {
        if (this.currentUt === ut) this.currentUt = null
        this.acceptingAudio = false
        this.send({ type: 'error', message: `asr: ${err.message}` })
      },
      () => {
        if (this.currentUt === ut) this.currentUt = null
      },
      this.context,
    )
    this.currentUt = ut
    ut.start()
  }

  asrEnd(): void {
    this.acceptingAudio = false
    this.currentUt?.end()
    this.currentUt = null
  }

  asrCancel(): void {
    this.acceptingAudio = false
    this.currentUt?.cancel()
    this.currentUt = null
  }

  /** 口语转书面：流式增量 + 最终全文。失败时回退为原文。 */
  async requestPolish(id: string, text: string): Promise<void> {
    this.polishAbort?.abort()
    const abort = new AbortController()
    this.polishAbort = abort
    const seq = ++this.polishSeq
    let full = ''
    try {
      const result = await polishStream(text, this.options.apiKey, (chunk) => {
        full += chunk
        this.send({ type: 'polish_chunk', id, text: chunk, sequence: seq, partial: full })
      }, this.options.polishModel === undefined
        ? { signal: abort.signal }
        : { model: this.options.polishModel, signal: abort.signal })
      if (abort.signal.aborted) return
      this.send({ type: 'polish_done', id, text: result === '' ? text : result, sequence: seq })
    } catch (err) {
      if (abort.signal.aborted) return
      this.send({ type: 'error', message: `polish: ${(err as Error).message}` })
      this.send({ type: 'polish_done', id, text, sequence: seq, fallback: true })
    } finally {
      if (this.polishAbort === abort) this.polishAbort = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.polishAbort?.abort()
    this.asrCancel()
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ ...obj, sequence: ++this.msgSeq }))
  }
}

export function createVoiceUpgrade(options: VoiceServerOptions): {
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  close: () => void
} {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws) => {
    if (wss.clients.size > MAX_CONNECTIONS) {
      ws.close(1008, 'too many connections')
      return
    }
    const lifetime = setTimeout(() => { ws.terminate() }, MAX_SESSION_MS)
    ws.on('close', () => { clearTimeout(lifetime) })
    const session = new VoiceSession(ws, options)
    ws.once('close', () => { session.dispose() })
    ws.send(JSON.stringify({
      type: 'ready',
      voiceSessionId: session.voiceSessionId,
      asr: 'dashscope',
      polish: true,
      hasKey: options.apiKey.length > 0,
    }))

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      if (isBinary) {
        if (buf.length > MAX_FRAME_BYTES) return
        session.feedAudio(buf)
        return
      }
      if (buf.length > 64 * 1024) return
      try {
        const parsed: unknown = JSON.parse(buf.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null) return
        const msg = parsed as Record<string, unknown>
        const isMySession = (m: Record<string, unknown>): boolean =>
          typeof m.voiceSessionId !== 'string' || m.voiceSessionId === session.voiceSessionId
        switch (msg.type) {
          case 'config': if (isMySession(msg)) session.applyConfig(msg); break
          case 'asr_start': if (isMySession(msg)) session.asrStart(); break
          case 'asr_end': if (isMySession(msg)) session.asrEnd(); break
          case 'asr_cancel': if (isMySession(msg)) session.asrCancel(); break
          case 'polish': {
            if (!isMySession(msg)) break
            const text = typeof msg.text === 'string' ? msg.text : ''
            if (text.trim() === '') break
            const id = typeof msg.id === 'string' ? msg.id : 'manual'
            session.requestPolish(id, text)
            break
          }
          default: break
        }
      } catch {
        /* ignore malformed control frames */
      }
    })
  })

  return {
    handle: (req, socket, head) => {
      const trusted = isTrustedVoiceRequest(req)
      logLine(`upgrade url=${req.url ?? ''} host=${req.headers.host ?? ''} origin=${req.headers.origin ?? ''} trusted=${trusted}`)
      if (!trusted) {
        logLine('reject: untrusted origin/host (403)')
        rejectWebSocketUpgrade(socket, 403)
        return
      }
      let admission
      try {
        admission = options.admit?.(req) ?? { rejection: 401 as const }
      } catch (error) {
        logLine(`reject: admit threw ${String(error)} (401)`)
        rejectWebSocketUpgrade(socket, 401)
        return
      }
      if ('rejection' in admission) {
        logLine(`reject: admission ${String(admission.rejection)}`)
        rejectWebSocketUpgrade(socket, admission.rejection)
        return
      }
      if (readVoiceOperator(admission.peer) === undefined) {
        logLine(`reject: peer without readable operator (401) peerKeys=${Object.keys(admission.peer as object).join(',')}`)
        rejectWebSocketUpgrade(socket, 401)
        return
      }
      logLine('accepted')
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    },
    close: () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}
