/**
 * 桌面端可用的 HTTP 传输（替代 WebSocket）。
 *
 * 桌面版页面跑在自定义协议 `dsh-app://app/` 下，`location.host` 是 `app`，
 * 既拼不出可用的 WS 地址，自定义协议也不转发 WS 升级；但同源的 fetch 会
 * 被代理到真正的 Host，所以语音输入改走 `/api/voice-weld/*` 四个端点：
 *
 *   POST /api/voice-weld/start   {context,polish}   → {id}
 *   POST /api/voice-weld/chunk   ?id=…（octet-stream）→ {partial}
 *   POST /api/voice-weld/end     {id}               → {final}
 *   POST /api/voice-weld/polish  {text}             → {text}
 *
 * 鉴权由 `ctx.connection.fetch` 统一处理（浏览器 cookie / owner peer）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AsrUtterance } from './asr-utterance.ts'
import { polishStream } from './dashscope.ts'

interface Session {
  id: string
  utt: AsrUtterance
  /** 已确定的句子拼成的全文。 */
  transcript: string
  /** 当前句的实时 partial。 */
  partial: string
  error?: Error
  done: Promise<string>
  resolve: (text: string) => void
  polish: boolean
  /** 创建时间，用于回收前端异常退出后没人 end 的孤儿会话。 */
  createdAt: number
}

/**
 * 拼接两段识别结果，消掉首尾重叠。
 *
 * 流式服务偶尔先给一个短句 final（例如「我」），紧接着同一句继续以
 * partial 回来（「我们先做…」），直接相加会出现「我我们」。这里按
 * 最长重叠（2–6 字）去重，重叠不足 2 字时按正常拼接处理。
 */
function mergeText(head: string, piece: string): string {
  if (head === '') return piece
  if (piece === '') return head
  const max = Math.min(6, head.length, piece.length)
  for (let size = max; size >= 2; size -= 1) {
    if (head.endsWith(piece.slice(0, size))) return head + piece.slice(size)
  }
  return head + piece
}

export interface VoiceHttpOptions {
  apiKey: string
  polishModel?: string
}

const PREFIX = '/api/voice-weld'

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await req.json()
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  return typeof value === 'string' ? value : ''
}

export function registerVoiceHttp(ctx: Context, options: VoiceHttpOptions): void {
  const sessions = new Map<string, Session>()
  const { apiKey, polishModel = 'qwen-flash' } = options

  const start = async (req: Request): Promise<Response> => {
    if (apiKey === '') return json({ error: 'missing DASHSCOPE_API_KEY' }, 503)
    const body = await readJson(req)
    const context = field(body, 'context').slice(0, 400)
    const wantPolish = body.polish !== false
    const id = randomUUID()

    let resolve: (text: string) => void = () => {}
    const done = new Promise<string>((r) => { resolve = r })
    const session: Session = {
      id,
      transcript: '',
      partial: '',
      done,
      resolve,
      polish: wantPolish,
      createdAt: Date.now(),
      utt: null as unknown as AsrUtterance,
    }
    const full = (): string => mergeText(session.transcript, session.partial)
    session.utt = new AsrUtterance(
      apiKey,
      id,
      // 一次录音里可以有多个句子：逐句累积，交给 end 汇总。
      (final) => { session.transcript = mergeText(session.transcript, final); session.partial = '' },
      (partial) => { session.partial = partial },
      (err) => { session.error = err; session.resolve(full()) },
      () => { session.resolve(full()) },
      context,
    )
    sessions.set(id, session)
    session.utt.start()
    return json({ id, hasKey: true, polish: wantPolish })
  }

  const chunk = async (req: Request): Promise<Response> => {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    const session = sessions.get(id)
    if (session === undefined) return json({ error: 'unknown session', ended: true }, 404)
    const bytes = Buffer.from(await req.arrayBuffer())
    if (bytes.length > 0) session.utt.push(bytes)
    const partial = mergeText(session.transcript, session.partial)
    const dropped = session.utt.droppedBytes
    // 识别侧已经结束（掉线 / 超时 / 服务端失败）时必须告诉前端，
    // 否则前端会一直以为还在录音：话筒红点不灭、点停也拿不到结果。
    if (session.utt.isFinished) {
      return json({ partial, ended: true, error: session.error?.message ?? '', dropped })
    }
    return json({ partial, ended: false, dropped })
  }

  const end = async (req: Request): Promise<Response> => {
    const body = await readJson(req)
    const id = field(body, 'id')
    const session = sessions.get(id)
    if (session === undefined) return json({ error: 'unknown session', final: '', ended: true }, 404)
    session.utt.end()
    const fallback = (): string => mergeText(session.transcript, session.partial)
    const timeout = new Promise<string>((resolve) => { setTimeout(() => resolve(fallback()), 20_000) })
    const final = await Promise.race([session.done, timeout])
    sessions.delete(id)
    return json({ final, error: session.error?.message ?? '', ended: true, dropped: session.utt.droppedBytes })
  }

  const polish = async (req: Request): Promise<Response> => {
    const body = await readJson(req)
    const text = field(body, 'text').trim()
    if (text === '') return json({ text: '' })
    if (apiKey === '') return json({ text, error: 'missing DASHSCOPE_API_KEY' })
    try {
      const rawLevel = typeof body.level === 'number' ? body.level : 2
      const level = Math.min(3, Math.max(1, Math.round(rawLevel)))
      const out = await polishStream(text, apiKey, () => {}, { model: polishModel, level })
      const trimmed = out.trim()
      return json({ text: trimmed === '' ? text : trimmed })
    } catch (err) {
      return json({ text, error: err instanceof Error ? err.message : 'polish failed' })
    }
  }

  type Route = { path: string; methods: string[]; requestBody: 'buffered' | 'streaming'; fetch: (req: Request) => Promise<Response> }
  const routes: Route[] = [
    { path: `${PREFIX}/start`, methods: ['POST'], requestBody: 'buffered', fetch: start },
    { path: `${PREFIX}/chunk`, methods: ['POST'], requestBody: 'buffered', fetch: chunk },
    { path: `${PREFIX}/end`, methods: ['POST'], requestBody: 'buffered', fetch: end },
    { path: `${PREFIX}/polish`, methods: ['POST'], requestBody: 'buffered', fetch: polish },
  ]

  ctx.inject(['connection'], (connCtx) => {
    const connection = (connCtx as unknown as {
      connection: { fetch: { register: (route: Route) => () => void } }
    }).connection
    for (const route of routes) {
      connCtx.effect(
        () => connection.fetch.register(route),
        `ui-voice-weld: ${route.path}`,
      )
    }
    // 孤儿会话回收：前端崩溃/刷新不会调 end，识别连接会一直挂在服务端。
    // 正常录音几十分钟也不会被误杀（30 分钟起算，且录音中不断有音频进来）。
    connCtx.effect(() => {
      const timer = setInterval(() => {
        const now = Date.now()
        for (const [id, session] of sessions) {
          const age = now - session.createdAt
          if (session.utt.isFinished ? age > 5 * 60_000 : age > 30 * 60_000) {
            if (!session.utt.isFinished) session.utt.cancel()
            sessions.delete(id)
          }
        }
      }, 60_000)
      return () => { clearInterval(timer) }
    }, 'ui-voice-weld: session-gc')
  })
}
