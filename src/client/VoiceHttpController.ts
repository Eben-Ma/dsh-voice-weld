/**
 * 桌面端语音控制器：HTTP 传输 + 手动停止。
 *
 * - 采集：AudioWorklet 2048 帧 / 16 kHz 单声道 → Int16；每 ~200 ms 批量 POST。
 * - 识别：POST /api/voice-weld/start → 持续 chunk（响应带最新 partial）→ end 拿 final。
 * - 追加：每轮开始时记住草稿里已有的文字（base），partial/final/润色都写成
 *   `base + 本轮文本`，因此连续说几段不会互相顶掉。
 * - 停止：只由用户点击按钮（或按 Esc 取消）触发，不做静音自动断句。
 * - 时长：单次上限可配置（设置页 → 单次录音时长上限，默认 10 分钟）。到点自动
 *   停止会给出提示，绝不再「悄悄停掉」。
 * - 掉线：识别连接中途死掉时，chunk 响应会带 ended，前端据此收工并保留已识别
 *   文字，保证话筒图标一定回到停止态。
 * - 润色：0=不改写，1/2/3 三档力度，随请求发给宿主。
 */

const WORKLET = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(0); }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const merged = new Float32Array(this.buf.length + input[0].length);
      merged.set(this.buf, 0); merged.set(input[0], this.buf.length);
      if (merged.length >= 2048) {
        this.port.postMessage(merged.slice(0, 2048));
        this.buf = merged.slice(2048);
      } else { this.buf = merged; }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`

export type WeldState = 'idle' | 'acquiring' | 'listening' | 'thinking' | 'failed'

export interface WeldCallbacks {
  onState: (state: WeldState) => void
  onText: (text: string) => void
  onError: (message: string) => void
  /** 录音计时：每秒一次，用于按钮上的 mm:ss 与「剩余不多」变色。 */
  onTick?: (elapsedMs: number, maxMs: number) => void
  /** 非报错类提示（到时长自动停止、连接中断等）。 */
  onNotice?: (message: string) => void
}

const API = '/api/voice-weld'
const FLUSH_MS = 200
const CHUNK_TIMEOUT_MS = 15_000
const END_TIMEOUT_MS = 30_000
const POLISH_TIMEOUT_MS = 30_000

/** 单次录音时长上限的存储键（分钟，1–60）。 */
export const KEY_MAX_MINUTES = 'dsh-voice-max-minutes'
export const DEFAULT_MAX_MINUTES = 10
export const MIN_MAX_MINUTES = 1
export const MAX_MAX_MINUTES = 60

export function clampMaxMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_MINUTES
  return Math.min(MAX_MAX_MINUTES, Math.max(MIN_MAX_MINUTES, Math.round(value)))
}

/** 读单次录音时长上限（毫秒）。 */
export function readMaxRecordMs(): number {
  const raw = Number(localStorage.getItem(KEY_MAX_MINUTES) ?? String(DEFAULT_MAX_MINUTES))
  return clampMaxMinutes(raw) * 60_000
}

/** 带超时的 AbortSignal：保证 end/polish 永远不会把图标卡在「整理中」。 */
function timeoutSignal(ms: number): AbortSignal {
  const native = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof native === 'function') return native.call(AbortSignal, ms)
  const controller = new AbortController()
  setTimeout(() => { controller.abort() }, ms)
  return controller.signal
}

/** 读当前输入框里的文字（桌面版可能是 textarea 或 contenteditable）。 */
function currentDraft(): string {
  const textarea = document.querySelector('textarea')
  if (textarea !== null) return textarea.value
  const editable = document.querySelector('[contenteditable="true"]')
  return editable instanceof HTMLElement ? editable.innerText : ''
}

export class VoiceHttpController {
  private state: WeldState = 'idle'
  private stream: MediaStream | null = null
  private audio: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private sessionId = ''
  private base = ''
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private inflight = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private maxMs = DEFAULT_MAX_MINUTES * 60_000
  private stopped = false

  constructor(private readonly cb: WeldCallbacks) {}

  get isActive(): boolean {
    return this.state === 'acquiring' || this.state === 'listening' || this.state === 'thinking'
  }

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt
  }

  get limitMs(): number {
    return this.maxMs
  }

  private level(): number {
    const raw = Number(localStorage.getItem('dsh-voice-polish-level') ?? '2')
    return Number.isFinite(raw) ? Math.min(3, Math.max(0, Math.round(raw))) : 2
  }

  async start(): Promise<void> {
    if (this.isActive) return
    this.stopped = false
    this.base = currentDraft()
    this.pending = []
    this.pendingBytes = 0
    this.maxMs = readMaxRecordMs()
    this.setState('acquiring')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      this.stream = stream
      const audio = new AudioContext({ sampleRate: 16000 })
      this.audio = audio
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      try {
        await audio.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const source = audio.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(audio, 'pcm-processor')
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onFrame(ev.data)
      source.connect(node)
      this.node = node

      const level = this.level()
      const res = await fetch(`${API}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          context: (localStorage.getItem('dsh-voice-context') ?? '').slice(0, 400),
          polish: level > 0,
          level,
        }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (this.stopped) { this.release(); return }
      if (!res.ok || typeof data.id !== 'string') {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      this.sessionId = data.id
      this.startedAt = Date.now()
      this.setState('listening')
      this.flushTimer = setInterval(() => { void this.flush() }, FLUSH_MS)
      this.startTick()
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : '无法连接语音服务')
      this.release()
      this.setState('failed')
    }
  }

  private onFrame(frame: Float32Array): void {
    if (this.state !== 'listening') return
    // 到上限：给提示再停，不再无声无息地断掉。
    if (Date.now() - this.startedAt > this.maxMs) {
      const minutes = Math.max(1, Math.round(this.maxMs / 60_000))
      this.cb.onNotice?.(`已录满 ${minutes} 分钟（单次上限），自动停止并整理`)
      void this.stop()
      return
    }
    const i16 = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, frame[i] ?? 0))
      i16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    const bytes = new Uint8Array(i16.buffer)
    this.pending.push(bytes)
    this.pendingBytes += bytes.byteLength
    if (this.pendingBytes >= 64_000) void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.inflight || this.pendingBytes === 0 || this.sessionId === '') return
    this.inflight = true
    const chunks = this.pending
    this.pending = []
    this.pendingBytes = 0
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const body = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { body.set(c, offset); offset += c.byteLength }
    try {
      const res = await fetch(`${API}/chunk?id=${encodeURIComponent(this.sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        signal: timeoutSignal(CHUNK_TIMEOUT_MS),
      })
      if (res.status === 404) {
        // 会话没了（宿主重启/被回收），不能继续假装在录。
        this.finishRemotely('识别会话已失效')
        return
      }
      if (!res.ok) return
      const data = await res.json() as { partial?: string; ended?: boolean; error?: string }
      const partial = typeof data.partial === 'string' ? data.partial : ''
      if (partial !== '') this.cb.onText(this.base + partial)
      if (data.ended === true) this.finishRemotely(data.error)
    } catch {
      // 单批失败不致命：继续下一批（超时/网络抖动都走这里）
    } finally {
      this.inflight = false
    }
  }

  /** 识别侧已经结束：收工、保留已识别文字、回到 idle，并说明原因。 */
  private finishRemotely(reason?: string): void {
    if (this.state !== 'listening') return
    this.sessionId = ''
    this.clearTimer()
    this.stopCapture()
    const detail = (reason ?? '').trim()
    this.cb.onNotice?.(detail === ''
      ? '识别连接已中断，已保留已识别的文字'
      : `识别已中断：${detail}（已保留已识别的文字）`)
    this.setState('idle')
  }

  async stop(): Promise<void> {
    if (this.state !== 'listening') return
    this.setState('thinking')
    this.clearTimer()
    await this.flush()
    this.stopCapture()
    const level = this.level()
    try {
      const res = await fetch(`${API}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.sessionId }),
        signal: timeoutSignal(END_TIMEOUT_MS),
      })
      this.sessionId = ''
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        this.cb.onError(data.error ?? `结束识别失败（HTTP ${res.status}）`)
        return
      }
      const data = await res.json() as { final?: string; error?: string }
      const final = (data.final ?? '').trim()
      if (final === '') {
        this.cb.onError(data.error === undefined || data.error === '' ? '没有识别到语音' : data.error)
        return
      }
      this.cb.onText(this.base + final)
      if (level > 0) {
        try {
          const polished = await fetch(`${API}/polish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: final, level }),
            signal: timeoutSignal(POLISH_TIMEOUT_MS),
          })
          const p = await polished.json() as { text?: string; error?: string }
          if (typeof p.text === 'string' && p.text.trim() !== '') {
            this.cb.onText(this.base + p.text.trim())
          } else if (p.error !== undefined && p.error !== '') {
            this.cb.onNotice?.(`整理未完成：${p.error}（保留原文）`)
          }
        } catch {
          // 润色失败不影响原文已经上屏。
          this.cb.onNotice?.('整理超时，已保留原始识别结果')
        }
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      this.cb.onError(aborted ? '结束识别超时，已保留已识别的文字' : (err instanceof Error ? err.message : '语音服务异常'))
    } finally {
      this.sessionId = ''
      this.base = ''
      this.setState('idle')
    }
  }

  /** 取消：停止采集、丢弃本轮，草稿恢复为开始前的样子。 */
  cancel(): void {
    this.stopped = true
    this.clearTimer()
    this.stopCapture()
    if (this.sessionId !== '') {
      void fetch(`${API}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: this.sessionId }),
      }).catch(() => {})
      this.sessionId = ''
    }
    this.pending = []
    this.pendingBytes = 0
    this.setState('idle')
  }

  private startTick(): void {
    this.stopTick()
    this.cb.onTick?.(0, this.maxMs)
    this.tickTimer = setInterval(() => {
      if (this.state !== 'listening') { this.stopTick(); return }
      this.cb.onTick?.(this.elapsedMs, this.maxMs)
    }, 1000)
  }

  private stopTick(): void {
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null }
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.stopTick()
  }

  private stopCapture(): void {
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((track) => { track.stop() })
    this.stream = null
    void this.audio?.close()
    this.audio = null
  }

  private release(): void {
    this.clearTimer()
    this.stopCapture()
    this.sessionId = ''
  }

  private setState(state: WeldState): void {
    if (this.state !== state) {
      this.state = state
      if (state !== 'listening') this.stopTick()
      this.cb.onState(state)
    }
  }
}
