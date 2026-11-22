// @vitest-environment jsdom
/**
 * 语音控制器状态机测试（0.2.0 新增）。
 *
 * 盯的就是用户报的那两类毛病：
 *   ① 录音久了自动停 → 必须有提示，且不能「红点不灭」；
 *   ② 中途停止/上游断连 → 状态必须回到 idle，已识别的文字要留住。
 *
 * 这些用例把 getUserMedia / AudioContext / AudioWorkletNode / fetch 全换成桩，
 * 不碰真麦克风、不出网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_MINUTES,
  KEY_MAX_MINUTES,
  MAX_MAX_MINUTES,
  MIN_MAX_MINUTES,
  VoiceHttpController,
  clampMaxMinutes,
  readMaxRecordMs,
} from '../src/client/VoiceHttpController.ts'

interface FakeNode {
  port: { onmessage: ((ev: { data: Float32Array }) => void) | null }
  disconnect: () => void
}

let lastNode: FakeNode | null = null

function installAudioMocks(): void {
  const track = { stop: vi.fn() }
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  })
  class FakeAudioContext {
    sampleRate = 16000
    audioWorklet = { addModule: vi.fn(async () => {}) }
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
    close = vi.fn(async () => {})
  }
  class FakeAudioWorkletNode {
    port: FakeNode['port'] = { onmessage: null }
    disconnect = vi.fn()
    constructor() { lastNode = this as unknown as FakeNode }
  }
  ;(globalThis as Record<string, unknown>).AudioContext = FakeAudioContext
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = FakeAudioWorkletNode
  URL.createObjectURL = vi.fn(() => 'blob:worklet')
  URL.revokeObjectURL = vi.fn()
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

interface Recorder {
  states: string[]
  texts: string[]
  errors: string[]
  notices: string[]
  ticks: number[]
}

function makeController(): { controller: VoiceHttpController; rec: Recorder } {
  const rec: Recorder = { states: [], texts: [], errors: [], notices: [], ticks: [] }
  const controller = new VoiceHttpController({
    onState: (s) => { rec.states.push(s) },
    onText: (t) => { rec.texts.push(t) },
    onError: (e) => { rec.errors.push(e) },
    onNotice: (n) => { rec.notices.push(n) },
    onTick: (ms) => { rec.ticks.push(ms) },
  })
  return { controller, rec }
}

/** 灌 16 帧（2048 样本 × 4 字节 ≈ 65 KB），足够触发一次 flush。 */
function pushFrames(count = 16): void {
  const node = lastNode
  if (node === null || node.port.onmessage === null) throw new Error('worklet not wired')
  for (let i = 0; i < count; i += 1) {
    node.port.onmessage({ data: new Float32Array(2048).fill(0.1) })
  }
}

beforeEach(() => {
  localStorage.clear()
  installAudioMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('录音时长上限（可配置）', () => {
  it('clamp 把越界值夹到 1–60，非法值回默认', () => {
    expect(clampMaxMinutes(0)).toBe(MIN_MAX_MINUTES)
    expect(clampMaxMinutes(-5)).toBe(MIN_MAX_MINUTES)
    expect(clampMaxMinutes(999)).toBe(MAX_MAX_MINUTES)
    expect(clampMaxMinutes(7.6)).toBe(8)
    expect(clampMaxMinutes(Number.NaN)).toBe(DEFAULT_MAX_MINUTES)
  })

  it('readMaxRecordMs 读 localStorage，缺省 10 分钟', () => {
    expect(readMaxRecordMs()).toBe(DEFAULT_MAX_MINUTES * 60_000)
    localStorage.setItem(KEY_MAX_MINUTES, '3')
    expect(readMaxRecordMs()).toBe(3 * 60_000)
    localStorage.setItem(KEY_MAX_MINUTES, '今天录一天')
    expect(readMaxRecordMs()).toBe(DEFAULT_MAX_MINUTES * 60_000)
  })

  it('start() 会用配置的上限，并通过 onTick 报给界面', async () => {
    localStorage.setItem(KEY_MAX_MINUTES, '5')
    const fetchStub = vi.fn(async () => jsonResponse({ id: 'sess-1' }))
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    expect(controller.limitMs).toBe(5 * 60_000)
    expect(controller.isActive).toBe(true)
    expect(rec.states).toEqual(['acquiring', 'listening'])
    expect(rec.ticks[0]).toBe(0)
    expect(fetchStub.mock.calls[0]?.[0]).toContain('/api/voice-weld/start')
    controller.cancel()
  })
})

describe('停止与断连都必须回到 idle', () => {
  it('chunk 返回 ended 时：回 idle、留提示、松麦克风', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-2' })
      return jsonResponse({ partial: '这是已识别的半句', ended: true, error: '服务端断开了' })
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    pushFrames()
    await vi.waitFor(() => { expect(controller.isActive).toBe(false) })
    expect(rec.states.at(-1)).toBe('idle')
    expect(rec.texts.at(-1)).toBe('这是已识别的半句')
    expect(rec.notices.join('')).toContain('识别已中断')
    expect(rec.notices.join('')).toContain('已保留')
  })

  it('chunk 返回 404（会话被回收）时同样收工并回 idle', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-3' })
      return jsonResponse({ error: 'unknown session', ended: true }, 404)
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    pushFrames()
    await vi.waitFor(() => { expect(controller.isActive).toBe(false) })
    expect(rec.states.at(-1)).toBe('idle')
    expect(rec.notices.join('')).toContain('会话已失效')
  })

  it('/end 挂掉也要回 idle，并说明原因', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-4' })
      if (url.includes('/chunk')) return jsonResponse({ partial: '' })
      return jsonResponse({ error: '上游炸了' }, 500)
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    await controller.stop()
    expect(rec.states).toEqual(['acquiring', 'listening', 'thinking', 'idle'])
    expect(rec.errors.join('')).toContain('上游炸了')
  })

  it('正常结束：final 上屏，带润色时再被书面语覆盖', async () => {
    localStorage.setItem('dsh-voice-polish-level', '2')
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-5' })
      if (url.includes('/chunk')) return jsonResponse({ partial: '' })
      if (url.includes('/end')) return jsonResponse({ final: '呃这个我们明天再说是吧', ended: true })
      return jsonResponse({ text: '我们明天再说。' })
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    await controller.stop()
    expect(rec.texts[0]).toBe('呃这个我们明天再说是吧')
    expect(rec.texts.at(-1)).toBe('我们明天再说。')
    expect(rec.states.at(-1)).toBe('idle')
  })

  it('润色超时不影响原文，只给一句提示', async () => {
    localStorage.setItem('dsh-voice-polish-level', '3')
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-6' })
      if (url.includes('/chunk')) return jsonResponse({ partial: '' })
      if (url.includes('/end')) return jsonResponse({ final: '原文在这', ended: true })
      throw new DOMException('timed out', 'AbortError')
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    await controller.stop()
    expect(rec.texts.at(-1)).toBe('原文在这')
    expect(rec.notices.join('')).toContain('保留原始识别结果')
    expect(rec.states.at(-1)).toBe('idle')
  })

  it('没有识别到语音时不报错卡住，回 idle 并提示', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('/start')) return jsonResponse({ id: 'sess-7' })
      if (url.includes('/chunk')) return jsonResponse({ partial: '' })
      return jsonResponse({ final: '', ended: true })
    })
    ;(globalThis as Record<string, unknown>).fetch = fetchStub
    const { controller, rec } = makeController()
    await controller.start()
    await controller.stop()
    expect(rec.errors.join('')).toContain('没有识别到语音')
    expect(rec.states.at(-1)).toBe('idle')
  })
})
