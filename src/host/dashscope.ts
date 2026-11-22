/**
 * DashScope (阿里百炼) streaming ASR + 口语转书面 polish.
 *
 * ASR: `qwen-audio-3.1-asr-flash-streaming` on the duplex WebSocket API,
 * with `input.context` carrying the user's hot-word / sentence list — the
 * same mechanism 搜狗 calls `speech_contexts` and 火山 calls context.
 *
 *   wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   run-task { model, parameters:{format:'pcm',sample_rate:16000}, input:{context:[...] } }
 *   binary 16k PCM16 mono frames
 *   finish-task -> task-finished
 *   result-generated -> payload.output.sentence { text, sentence_end }
 *
 * Polish: OpenAI-compatible chat completions with `stream: true`; the model
 * rewrites the raw transcript into written Chinese without adding facts.
 */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'

const ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

/** 每帧 100 ms 的 16 kHz PCM16。 */
const FRAME_BYTES = 3200
const FRAME_MS = 100

export interface AsrResult {
  text: string
  is_final: boolean
}

export interface AsrStreamOptions {
  model?: string
  /** 词表/上下文句子，喂给 input.context；最长 400 字符。 */
  context?: string
  endpointingMs?: number
  signal?: AbortSignal
  /**
   * 建连超时：从建连到收到 task-started 的等待上限。
   * 只约束「开局」，不约束录音时长——长录音不该被整体超时杀掉。
   */
  connectTimeoutMs?: number
  /**
   * 空闲看门狗：这么久既没有音频送出、也没有收到任何事件，就判定连接已死
   * （麦克风掉了 / 前端不再推送）。0 表示关闭。录音期间音频每 100 ms 一帧，
   * 正常说话不会误触。
   */
  idleTimeoutMs?: number
}

function contextPayload(context: string | undefined): unknown {
  const text = (context ?? '').trim()
  if (text === '') return {}
  return { context: [{ role: 'user', content: [{ type: 'input_text', text: text.slice(0, 400) }] }] }
}

/**
 * 把 PCM16 流式送进百炼，回调 partial / final。
 * 句界由服务端判定（sentence_end），客户端只负责持续送音频。
 */
export async function asrStream(
  pcmSource: AsyncIterable<Buffer> | Buffer | string,
  apiKey: string,
  onText: (result: AsrResult) => void,
  options: AsrStreamOptions = {},
): Promise<void> {
  const {
    model = 'qwen-audio-3.1-asr-flash-streaming',
    context,
    signal,
    connectTimeoutMs = 15_000,
    idleTimeoutMs = 120_000,
  } = options

  const taskId = randomUUID()
  const ws = new WebSocket(ASR_URL, {
    headers: { Authorization: `bearer ${apiKey}`, 'X-DashScope-DataInspection': 'enable' },
  })

  let finished = false
  /** 是否已经发过 finish-task：此时服务端关连接属正常收尾。 */
  let finishing = false
  let sentFrames = 0
  let sentBytes = 0
  let lastActivity = Date.now()
  let wake: (() => void) | null = null

  const source =
    typeof pcmSource === 'string'
      ? async function* (): AsyncGenerator<Buffer> {
          const { readFile } = await import('node:fs/promises')
          const all = await readFile(pcmSource)
          for (let i = 0; i < all.length; i += FRAME_BYTES) yield all.subarray(i, i + FRAME_BYTES)
        }()
      : Buffer.isBuffer(pcmSource)
        ? (async function* (): AsyncGenerator<Buffer> {
            for (let i = 0; i < pcmSource.length; i += FRAME_BYTES) yield pcmSource.subarray(i, i + FRAME_BYTES)
          })()
        : pcmSource

  const result = new Promise<void>((resolve, reject) => {
    let connectTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setInterval> | null = null

    const cleanup = (): void => {
      if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null }
      if (idleTimer !== null) { clearInterval(idleTimer); idleTimer = null }
      signal?.removeEventListener('abort', onAbort)
    }
    /** 失败收口：只触发一次。 */
    const bail = (err: Error): void => {
      if (finished) return
      finished = true
      cleanup()
      try { ws.terminate() } catch { /* ignore */ }
      reject(err)
    }
    const onAbort = (): void => {
      if (finished) return
      finished = true
      cleanup()
      try { ws.terminate() } catch { /* ignore */ }
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // 只约束建连阶段；task-started 到达后立即解除，之后由空闲看门狗兜底。
    connectTimer = setTimeout(() => {
      bail(new Error(`asr connect timeout after ${connectTimeoutMs} ms`))
    }, connectTimeoutMs)
    if (idleTimeoutMs > 0) {
      idleTimer = setInterval(() => {
        if (finished) return
        if (Date.now() - lastActivity > idleTimeoutMs) {
          bail(new Error(`asr idle timeout after ${idleTimeoutMs} ms`))
        }
      }, Math.min(5000, Math.max(1000, Math.floor(idleTimeoutMs / 4))))
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model,
          parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'] },
          input: contextPayload(context),
        },
      }))
    })

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return
      let event: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(data.toString())
        if (typeof parsed !== 'object' || parsed === null) return
        event = parsed as Record<string, unknown>
      } catch { return }
      const header = (event.header ?? {}) as Record<string, unknown>
      const action = header.event
      lastActivity = Date.now()
      if (action === 'task-started') {
        if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null }
        wake?.()
      } else if (action === 'result-generated') {
        const payload = (event.payload ?? {}) as Record<string, unknown>
        const output = (payload.output ?? {}) as Record<string, unknown>
        const sentence = output.sentence as Record<string, unknown> | undefined
        if (sentence && typeof sentence.text === 'string') {
          const text = sentence.text.trim()
          if (text !== '') onText({ text, is_final: sentence.sentence_end === true })
        }
      } else if (action === 'task-finished') {
        finished = true
        cleanup()
        try { ws.close() } catch { /* ignore */ }
        resolve()
      } else if (action === 'task-failed') {
        const payload = (event.payload ?? {}) as Record<string, unknown>
        const code = String(payload.error_code ?? header.error_code ?? '')
        const msg = String(payload.message ?? header.error_message ?? 'asr task failed')
        bail(new Error(code === '' ? msg : `${msg} (${code})`))
      }
    })

    ws.on('error', (err) => {
      bail(err instanceof Error ? err : new Error(String(err)))
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (finished) return
      // 发过 finish-task 之后的关闭是正常收尾；之外的关闭都是中途掉线，
      // 必须报错，否则上层会拿到半截文字却以为录音正常结束。
      if (finishing) {
        finished = true
        cleanup()
        resolve()
        return
      }
      const why = reason?.toString().slice(0, 200) ?? ''
      bail(new Error(`asr socket closed (code ${code}${why === '' ? '' : `: ${why}`})`))
    })
  })

  // 等 task-started 再送音频；服务端未就绪就灌数据会被丢。
  await new Promise<void>((resolve) => {
    wake = resolve
    void result.catch(() => resolve())
    setTimeout(resolve, 3000)
  })
  wake = null
  if (finished) { await result.catch(() => {}); return }

  // 按「绝对时间轴」推进，而不是每帧固定 sleep 100 ms：后者会把 setTimeout
  // 的抖动累加进速度差，长录音时队列越积越多、转写越落越后。
  const paceStart = Date.now()
  for await (const chunk of source) {
    if (finished) break
    if (chunk.length === 0) continue
    try {
      ws.send(chunk)
    } catch {
      break
    }
    sentFrames += 1
    sentBytes += chunk.length
    lastActivity = Date.now()
    const wait = paceStart + sentFrames * FRAME_MS - Date.now()
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait))
  }

  if (!finished && ws.readyState === WebSocket.OPEN) {
    finishing = true
    ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }))
  }
  await result
  void sentBytes
}

/** 三档整理力度：1 只补标点，2 标准（默认），3 较强（可重排语序）。 */
function polishRules(level: number): string[] {
  const common = [
    '你是语音输入的“口语转书面”处理器，只做整理，不改写立场。',
    '保留专业术语（尤其是医学名词）原样，不要替换成同义词；',
    '不要新增原文没有的信息，不要解释，不要加引号或前后缀；',
    '只输出整理后的正文。',
  ]
  if (level <= 1) {
    return [
      ...common,
      '力度：最轻。只补全标点、把口头数字/单位写成规范写法；',
      '不要删除任何词、不要调整语序、不要合并句子，口癖与重复原样保留。',
    ]
  }
  if (level >= 3) {
    return [
      ...common,
      '力度：较强。删除口癖、重复与自我纠正，补全标点并合理分句；',
      '可以合并被停顿切碎的半句、微调语序让书面语更通顺，但不得改变原意或增减信息。',
    ]
  }
  return [
    ...common,
    '力度：标准。删除口癖、重复、自我纠正与语气词；补全标点并合理分句；',
    '不改变原句顺序与用词，除非明显重复或语病。',
  ]
}

/** 口语转书面：流式返回增量，最后返回全文。 */
export async function polishStream(
  text: string,
  apiKey: string,
  onChunk: (chunk: string) => void,
  options: { model?: string; signal?: AbortSignal; level?: number } = {},
): Promise<string> {
  const model = options.model ?? 'qwen-flash'
  const level = Math.min(3, Math.max(1, Math.round(options.level ?? 2)))
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: polishRules(level).join('\n'),
        },
        { role: 'user', content: text },
      ],
    }),
  }
  if (options.signal !== undefined) init.signal = options.signal
  const res = await fetch(CHAT_URL, init)
  if (!res.ok || res.body === null) {
    const body = await res.text().catch(() => '')
    throw new Error(`polish http ${res.status}: ${body.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '' && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[]
            }
            const piece = parsed.choices?.[0]?.delta?.content ?? ''
            if (piece !== '') {
              full += piece
              onChunk(piece)
            }
          } catch { /* ignore malformed sse line */ }
        }
      }
      index = buffer.indexOf('\n')
    }
  }
  return full.trim()
}
