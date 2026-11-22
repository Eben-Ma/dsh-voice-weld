/**
 * 回归测试：把构建出来的 lib/client.js 当成浏览器里的插件包跑一遍。
 *
 * 目的：DSH 的客户端插件加载器对「模块求值即抛」是**静默**的（只 console.error，
 * 然后返回 {apply(){}, inject:[]}），而渲染期抛错也只会让槽位变空白。0.2.0 就踩过：
 * esbuild 默认 classic JSX 把 <div> 编成 React.createElement，而组件没 import React
 * 命名空间 → 浏览器里 "ReferenceError: React is not defined"，话筒和设置项一起消失、
 * 界面不报任何错。所以这里直接验证「能求值 + 能注册 + 能渲染出 HTML」。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd())
const clientPath = path.join(root, 'lib', 'client.js')
const req = createRequire(path.join(root, 'package.json'))

/** 在假的浏览器环境里执行客户端包，返回它导出的模块。 */
function loadClientBundle() {
  const source = fs.readFileSync(clientPath, 'utf8')
  let captured: { id: string; factory: (r: (id: string) => unknown) => Record<string, unknown> } | undefined
  const win = {
    __ModuleLoader__: {
      load(mod: typeof captured) {
        captured = mod
      },
    },
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      store: new Map<string, string>(),
      getItem(k: string) {
        return this.store.has(k) ? this.store.get(k) : null
      },
      setItem(k: string, v: string) {
        this.store.set(k, String(v))
      },
      removeItem(k: string) {
        this.store.delete(k)
      },
    },
    navigator: { mediaDevices: {}, languages: ['zh-CN'] },
    document: { documentElement: { lang: 'zh-CN' } },
  }
  const sandbox: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    // 组件里是裸 localStorage（浏览器全局），vm 沙箱里也得挂成全局
    localStorage: win.localStorage,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    AbortController,
    TextEncoder,
    TextDecoder,
  }
  sandbox.globalThis = sandbox
  sandbox.self = win
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  expect(captured, '客户端包必须调用 window.__ModuleLoader__.load').toBeTruthy()
  return captured?.factory((id: string) => req(id)) as {
    apply(ctx: unknown): void
    inject: string[]
  }
}

describe('lib/client.js 浏览器侧可加载性', () => {
  it('模块求值不抛错，并导出 apply/inject', () => {
    const mod = loadClientBundle()
    expect(typeof mod.apply).toBe('function')
    expect(mod.inject).toEqual(['slots', 'locale'])
  })

  it('apply(ctx) 注册话筒按钮与设置分区，且两者都能渲染出 HTML', async () => {
    const React = req('react') as typeof import('react')
    const { renderToString } = req('react-dom/server') as typeof import('react-dom/server')
    const mod = loadClientBundle()

    const registered: { name: string; component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> }[] = []
    const dicts = new Map<string, { zh?: Record<string, string>; en?: Record<string, string> }>()
    const ctx = {
      effect(cb: () => unknown) {
        cb()
        return () => {}
      },
      locale: {
        register(ns: string, d: { zh?: Record<string, string>; en?: Record<string, string> }) {
          dicts.set(ns, d)
          return () => dicts.delete(ns)
        },
        bind(ns: string) {
          return (key: string, vars?: Record<string, unknown>) => {
            const d = dicts.get(ns) ?? {}
            let s = d.zh?.[key] ?? d.en?.[key] ?? key
            for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v))
            return s
          }
        },
      },
      slots: {
        inject(_name: string, run?: () => unknown) {
          return run?.() ?? (() => {})
        },
        register(spec: { name: string; inject?: () => Record<string, unknown> }, component: React.ComponentType<Record<string, unknown>>) {
          registered.push({ name: spec.name, component, props: spec.inject?.() ?? {} })
          return () => {}
        },
      },
    }

    mod.apply(ctx)
    expect(registered.map((r) => r.name)).toEqual(['conversation.input.right', 'settings.section'])

    for (const entry of registered) {
      const html = renderToString(React.createElement(entry.component, entry.props))
      expect(html.length, `${entry.name} 应渲染出内容`).toBeGreaterThan(100)
    }
    const button = renderToString(React.createElement(registered[0].component, registered[0].props))
    expect(button).toContain('<button')
    expect(button).toContain('语音输入')
    const section = renderToString(React.createElement(registered[1].component, registered[1].props))
    expect(section).toContain('语音输入')
  })
})
