/**
 * 设置页「语音输入（百炼）」：顺稿力度（0–3 滑杆）+ 单次录音时长上限 + 词表/上下文。
 * API Key 由宿主进程从环境变量或 ~/.dsh/.credentials.yaml 读取，前端不碰。
 */
import { useState, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_MAX_MINUTES,
  KEY_MAX_MINUTES,
  clampMaxMinutes,
} from './VoiceHttpController.ts'

export type VoiceSettingsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'voice'>

const KEY_LEVEL = 'dsh-voice-polish-level'
const KEY_LEGACY = 'dsh-voice-polish'
const KEY_CONTEXT = 'dsh-voice-context'

const LEVELS = [
  { value: 0, name: '不改写', desc: '识别到什么就写什么，只补不加。' },
  { value: 1, name: '轻度', desc: '只补标点、规范数字单位，不删词、不调语序。' },
  { value: 2, name: '标准', desc: '去口癖、重复、自我纠正，补标点并分句。' },
  { value: 3, name: '较强', desc: '可合并被停顿切碎的半句、微调语序，但不增删信息。' },
] as const

/** 常用的时长档位（分钟），也允许通过 localStorage 手改成 1–60 的任意整数。 */
const MINUTE_CHOICES = [3, 5, 10, 15, 20, 30, 45, 60] as const

function readLevel(): number {
  const stored = localStorage.getItem(KEY_LEVEL)
  if (stored !== null) {
    const value = Number(stored)
    if (Number.isFinite(value)) return Math.min(3, Math.max(0, Math.round(value)))
  }
  // 兼容旧开关：dsh-voice-polish = '0' 视为「不改写」。
  return localStorage.getItem(KEY_LEGACY) === '0' ? 0 : 2
}

function readContext(): string {
  return localStorage.getItem(KEY_CONTEXT) ?? ''
}

function readMaxMinutes(): number {
  const stored = localStorage.getItem(KEY_MAX_MINUTES)
  if (stored === null) return DEFAULT_MAX_MINUTES
  return clampMaxMinutes(Number(stored))
}

export function VoiceSettingsSection(_props: VoiceSettingsSectionProps): ReactElement {
  const [level, setLevel] = useState(readLevel)
  const [context, setContext] = useState(readContext)
  const [maxMinutes, setMaxMinutes] = useState(readMaxMinutes)
  const [saved, setSaved] = useState<'idle' | 'ok'>('idle')

  const flashSaved = (): void => {
    setSaved('ok')
    setTimeout(() => { setSaved('idle') }, 1200)
  }

  const changeLevel = (value: number): void => {
    setLevel(value)
    localStorage.setItem(KEY_LEVEL, String(value))
    flashSaved()
  }

  const changeMinutes = (value: number): void => {
    const minutes = clampMaxMinutes(value)
    setMaxMinutes(minutes)
    localStorage.setItem(KEY_MAX_MINUTES, String(minutes))
    flashSaved()
  }

  const save = (): void => {
    // 百炼 input.context 每轮上限 400 字符，这里按上限截断并提示。
    localStorage.setItem(KEY_CONTEXT, context.slice(0, 400))
    localStorage.setItem(KEY_LEVEL, String(level))
    localStorage.setItem(KEY_MAX_MINUTES, String(clampMaxMinutes(maxMinutes)))
    flashSaved()
  }

  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }
  const hint: React.CSSProperties = { fontSize: 12, opacity: 0.65, lineHeight: 1.6, margin: 0 }
  const current = LEVELS[level] ?? LEVELS[2]

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>语音输入（百炼）</h3>
        <p style={hint}>
          流式识别：边说边出字；停止录音后按下面的力度做一次「口语转书面」。
          密钥由 DSH 主进程读取，不需要在这里填。
        </p>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13 }}>
          整理力度：<strong>{current.name}</strong>
        </span>
        <input
          type="range"
          min={0}
          max={3}
          step={1}
          value={level}
          onChange={(e) => { changeLevel(Number(e.target.value)) }}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.6 }}>
          {LEVELS.map((item) => <span key={item.value}>{item.name}</span>)}
        </div>
        <span style={hint}>{current.desc}</span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13 }}>
          单次录音时长上限：<strong>{maxMinutes} 分钟</strong>
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {MINUTE_CHOICES.map((minutes) => {
            const selected = minutes === maxMinutes
            return (
              <button
                key={minutes}
                type="button"
                onClick={() => { changeMinutes(minutes) }}
                style={{
                  padding: '3px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${selected ? 'rgba(59,130,246,0.9)' : 'rgba(128,128,128,0.35)'}`,
                  background: selected ? 'rgba(59,130,246,0.16)' : 'transparent',
                  color: 'inherit',
                }}
              >
                {minutes}
              </button>
            )
          })}
        </div>
        <span style={hint}>
          点麦克风开始，到点会自动停止并整理（会有提示，不会悄无声息地断）。
          想更久就选大一点，最长 60 分钟；识别是流式的，中途一直出字。
        </span>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13 }}>词表 / 上下文（每行或空格分隔，最多 400 字）</span>
        <textarea
          value={context}
          onChange={(e) => { setContext(e.target.value) }}
          rows={4}
          placeholder="例：肋弓 腹腔积液 脾脏 探查 止血 缝合"
          style={{
            width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13,
            padding: 8, borderRadius: 8, border: '1px solid rgba(128,128,128,0.35)',
            background: 'transparent', color: 'inherit',
          }}
        />
        <span style={hint}>{context.length}/400 · 说话时若含这些词，识别会优先选它们。</span>
      </label>

      <div style={row}>
        <button type="button" onClick={save} style={{ padding: '6px 14px', borderRadius: 8, cursor: 'pointer' }}>
          保存词表
        </button>
        {saved === 'ok' && <span style={{ fontSize: 12, color: '#22c55e' }}>已保存，下一次录音生效</span>}
      </div>
    </section>
  )
}
