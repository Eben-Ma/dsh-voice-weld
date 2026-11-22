// Boot the built client.js like the DSH web loader, then run apply(ctx) with a
// fake client context and render every registered component once.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const clientPath = process.argv[2]
const src = fs.readFileSync(clientPath, 'utf8')
const req = createRequire(path.join(here, 'package.json'))
const React = req('react')
const { renderToString } = req('react-dom/server')

let captured = null
const win = {
  __ModuleLoader__: { load(mod) { captured = mod } },
  addEventListener() {}, removeEventListener() {},
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  },
  navigator: { mediaDevices: {}, languages: ['zh-CN'] },
  document: { documentElement: { lang: 'zh-CN' } },
  setTimeout, clearTimeout, setInterval, clearInterval,
}
win.window = win
const sandbox = { ...win, console, URL, AbortController, TextEncoder, TextDecoder, Date, Math, JSON, Promise }
sandbox.window = win
sandbox.globalThis = sandbox
sandbox.self = win

vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

let mod
try {
  mod = captured.factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return req('react-dom')
    if (id === 'react/jsx-runtime') return req('react/jsx-runtime')
    throw new Error(`unexpected require(${id})`)
  })
} catch (error) {
  console.error('❌ MODULE EVAL THREW:', error && error.stack ? error.stack : error)
  process.exit(1)
}
console.log('✅ module evaluated; exports =', Object.keys(mod || {}), 'inject =', JSON.stringify(mod.inject))

const components = []
const dicts = new Map()
const ctx = {
  effect(cb, label) {
    const dispose = cb()
    return () => { try { dispose?.() } catch {} }
  },
  locale: {
    register(ns, d) { dicts.set(ns, d); return () => dicts.delete(ns) },
    bind(ns) {
      return (key, vars) => {
        const d = dicts.get(ns) ?? {}
        let s = (d.zh ?? {})[key] ?? (d.en ?? {})[key] ?? key
        for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v))
        return s
      }
    },
  },
  slots: {
    inject(name, run) { return run?.() ?? (() => {}) },
    register(spec, component) {
      components.push({ spec, component })
      return () => {}
    },
  },
}

try {
  mod.apply(ctx)
  console.log('✅ apply(ctx) returned cleanly; registered components =', components.length)
} catch (error) {
  console.error('❌ apply THREW:', error && error.stack ? error.stack : error)
  process.exit(1)
}
for (const c of components) {
  console.log('   •', c.spec.name, c.spec.id, 'order', c.spec.order, 'props', Object.keys(c.spec.inject?.() ?? {}))
}

const ReactDOMServer = req('react-dom/server')
for (const c of components) {
  const props = c.spec.inject?.() ?? {}
  try {
    const html = ReactDOMServer.renderToString(React.createElement(c.component, props))
    console.log(`✅ rendered ${c.spec.name}: ${html.length} chars`)
    console.log('   ', html.slice(0, 220).replace(/\s+/g, ' '))
  } catch (error) {
    console.error(`❌ RENDER THREW for ${c.spec.name}:`, error && error.stack ? error.stack : error)
  }
}
