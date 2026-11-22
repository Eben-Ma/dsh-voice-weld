/**
 * 输入框麦克风按钮（听写模式）。
 *
 * - 点一下开始录音，再点一下停止并整理；录音期间按 Esc 取消。
 * - partial / final / 润色结果都通过 inputActions.setDraft 写进输入框，
 *   不在按钮旁边另显示文字（避免和输入栏重复）。
 * - 状态一律由 controller 回调驱动：录音/整理各有自己的样子，绝不「红了回不来」。
 * - 录音时显示 mm:ss，剩不到 30 秒转琥珀色；到上限自动停止会弹提示。
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_MAX_MINUTES,
  VoiceHttpController,
  type WeldState,
} from './VoiceHttpController.ts'

export type VoiceInputButtonProps =
  PropsRuntime<'conversation.input.left'> & PropsLocale<'voice'>

const ACTIVE: ReadonlySet<WeldState> = new Set(['acquiring', 'listening', 'thinking'])
const RED = '#ef4444'
const BLUE = '#3b82f6'
const AMBER = '#f59e0b'

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60).toString().padStart(2, '0')
  const ss = (total % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

export function VoiceInputButton({ inputActions }: VoiceInputButtonProps) {
  const [state, setState] = useState<WeldState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [limitMs, setLimitMs] = useState(DEFAULT_MAX_MINUTES * 60_000)
  const controllerRef = useRef<VoiceHttpController | null>(null)

  const controller = (): VoiceHttpController => {
    if (controllerRef.current === null) {
      controllerRef.current = new VoiceHttpController({
        onState: setState,
        onText: (text) => { inputActions.setDraft(text) },
        onError: (message) => { setError(message) },
        onNotice: (message) => { setNotice({ text: message, at: Date.now() }) },
        onTick: (ms, max) => { setElapsed(ms); setLimitMs(max) },
      })
    }
    return controllerRef.current
  }

  /** 提示气泡 6 秒后自动消失（同一句重复出现也能重新计时）。 */
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => { setNotice(null) }, 6000)
    return () => { clearTimeout(timer) }
  }, [notice])

  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => { setError(null) }, 6000)
    return () => { clearTimeout(timer) }
  }, [error])

  /** 录音中按 Esc：取消本轮并恢复原草稿。 */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      const current = controllerRef.current
      if (current?.isActive === true) {
        ev.preventDefault()
        current.cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      controllerRef.current?.cancel()
    }
  }, [])

  const active = ACTIVE.has(state)
  const listening = state === 'listening'
  const thinking = state === 'thinking'
  const acquiring = state === 'acquiring'
  const remaining = limitMs - elapsed
  const low = listening && remaining <= 30_000
  const accent = thinking ? BLUE : RED

  const label = error
    ?? (listening
      ? `停止并整理 · 已录 ${clock(elapsed)}（Esc 取消）`
      : thinking
        ? '正在整理…'
        : acquiring
          ? '正在连接麦克风…'
          : `语音输入（单次最长 ${Math.round(limitMs / 60_000)} 分钟）`)

  const message = error ?? notice?.text ?? null
  const messageColor = error !== null ? '#e5484d' : '#0ea5e9'

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {message !== null && (
        <span
          style={{
            position: 'absolute', bottom: '100%', left: 0, maxWidth: 420,
            whiteSpace: 'normal', fontSize: 11, lineHeight: 1.35, color: messageColor,
            background: 'rgba(0,0,0,0.75)', padding: '2px 6px', borderRadius: 4,
          }}
          role={error !== null ? 'alert' : 'status'}
        >
          {message}
        </span>
      )}
      {active && (
        <span
          aria-hidden
          style={{
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            color: low ? AMBER : thinking ? BLUE : RED,
            opacity: active ? 1 : 0,
          }}
        >
          {thinking ? '整理中…' : clock(elapsed)}
        </span>
      )}
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={listening || acquiring}
        aria-busy={thinking}
        disabled={thinking}
        onClick={() => {
          setError(null)
          setNotice(null)
          const c = controller()
          if (c.isActive) void c.stop()
          else void c.start()
        }}
        style={{
          position: 'relative',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 8, border: 'none',
          cursor: thinking ? 'default' : 'pointer',
          background: active ? (thinking ? 'rgba(59,130,246,0.16)' : 'rgba(239,68,68,0.16)') : 'transparent',
          color: active ? accent : 'currentColor',
          opacity: acquiring ? 0.7 : 1,
        }}
      >
        {thinking ? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 8 8"
                to="360 8 8"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </path>
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 1a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 1 1-5 0v-3A2.5 2.5 0 0 1 8 1Z" fill="currentColor" />
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0h-1.5a3 3 0 0 1-6 0h-1.5Z" fill="currentColor" />
            <path d="M8 11.75a4.25 4.25 0 0 1-4.25-4.25H2.25A5.75 5.75 0 0 0 7.25 13.2V15h1.5v-1.8a5.75 5.75 0 0 0 5-5.7h-1.5A4.25 4.25 0 0 1 8 11.75Z" fill="currentColor" />
          </svg>
        )}
        {listening && (
          <svg
            aria-hidden
            viewBox="0 0 6 6"
            width="6"
            height="6"
            style={{ position: 'absolute', top: 4, right: 4 }}
          >
            <circle cx="3" cy="3" r="3" fill={RED}>
              <animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite" />
            </circle>
          </svg>
        )}
      </button>
    </div>
  )
}
