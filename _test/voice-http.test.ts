// @vitest-environment node
/**
 * 宿主侧路由契约测试（0.2.0 新增）。
 *
 * 只测「不需要出网」的部分：会话不存在时必须是 404 + ended:true（前端靠它收工），
 * 以及缺 Key 时润色要老实报错而不是假装成功。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { registerVoiceHttp } from '../src/host/voice-http.ts'

const PREFIX = '/api/voice-weld'

type Handler = (req: Request) => Promise<Response>

interface Captured {
  routes: Map<string, Handler>
  effects: number
  disposers: Array<() => void>
}

const disposers: Array<() => void> = []

function capture(apiKey: string): Captured {
  const captured: Captured = { routes: new Map(), effects: 0, disposers: [] }
  const ctx = {
    inject: (_names: string[], fn: (connCtx: unknown) => void) => {
      fn({
        connection: {
          fetch: {
            register: (route: { path: string; fetch: Handler }) => {
              captured.routes.set(route.path, route.fetch)
              return () => { captured.routes.delete(route.path) }
            },
          },
        },
        // 真的 cordis effect 会执行回调拿 disposer；GC 的 60 s 定时器必须在这里被收掉，
        // 否则测试进程会被它挂住。
        effect: (cb: () => unknown) => {
          const disposer = cb()
          captured.effects += 1
          if (typeof disposer === 'function') {
            captured.disposers.push(disposer as () => void)
            disposers.push(disposer as () => void)
          }
        },
      })
    },
  }
  registerVoiceHttp(ctx as never, { apiKey, polishModel: 'qwen-flash' })
  return captured
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    try { dispose() } catch { /* ignore */ }
  }
})

function post(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, { method: 'POST', ...init })
}

describe('宿主路由：会话不存在时的契约', () => {
  it('注册了 4 条路由 + 1 个 GC effect', () => {
    const c = capture('sk-test')
    expect([...c.routes.keys()].sort()).toEqual([
      `${PREFIX}/chunk`,
      `${PREFIX}/end`,
      `${PREFIX}/polish`,
      `${PREFIX}/start`,
    ])
    // 4 条路由各一个 effect + 1 个 GC effect
    expect(c.effects).toBe(5)
  })

  it('chunk 打不存在的会话 → 404 且 ended:true', async () => {
    const c = capture('sk-test')
    const res = await c.routes.get(`${PREFIX}/chunk`)!(post(`${PREFIX}/chunk?id=nope`, { body: new Uint8Array(8) }))
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string; ended: boolean }
    expect(body.ended).toBe(true)
    expect(body.error).toContain('unknown session')
  })

  it('end 打不存在的会话 → 404 且 ended:true', async () => {
    const c = capture('sk-test')
    const res = await c.routes.get(`${PREFIX}/end`)!(post(`${PREFIX}/end`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    }))
    expect(res.status).toBe(404)
    const body = await res.json() as { ended: boolean; final: string }
    expect(body.ended).toBe(true)
    expect(body.final).toBe('')
  })
})

describe('宿主路由：润色', () => {
  it('没有 Key 时原样返回并带 error，不伪装成功', async () => {
    const c = capture('')
    const res = await c.routes.get(`${PREFIX}/polish`)!(post(`${PREFIX}/polish`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '原文', level: 2 }),
    }))
    const body = await res.json() as { text: string; error?: string }
    expect(body.text).toBe('原文')
    expect(body.error).toContain('DASHSCOPE_API_KEY')
  })

  it('空文本直接返回空，不打上游', async () => {
    const c = capture('sk-test')
    const res = await c.routes.get(`${PREFIX}/polish`)!(post(`${PREFIX}/polish`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    }))
    expect(await res.json()).toEqual({ text: '' })
  })
})
