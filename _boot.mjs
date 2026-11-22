// Boot the built client.js exactly like the DSH web client loader does, and see
// whether the factory throws (which would silently drop the whole plugin UI).
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const clientPath = process.argv[2]
const src = fs.readFileSync(clientPath, 'utf8')
const req = createRequire('file:///E:/AI_Assets/DeepSeek_Harness/.dsh/profiles/desktop/package.json')

let captured = null
const win = {
  __ModuleLoader__: {
    load(mod) {
      captured = mod
    },
  },
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] },
  },
  navigator: { mediaDevices: {} },
}
win.window = win
const sandbox = { window: win, document: {}, console, navigator: win.navigator, setTimeout, clearTimeout, setInterval, clearInterval, URL, AbortController, TextEncoder, TextDecoder }
sandbox.globalThis = sandbox
sandbox.self = win

vm.createContext(sandbox)
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' })
} catch (error) {
  console.error('LOAD SCRIPT FAILED:', error)
  process.exit(1)
}
if (!captured) {
  console.error('no module captured: __ModuleLoader__.load was not called')
  process.exit(1)
}
console.log('captured id =', captured.id)
let mod
try {
  mod = captured.factory((id) => req(id))
} catch (error) {
  console.error('FACTORY THREW:', error && error.stack ? error.stack : error)
  process.exit(1)
}
console.log('exports =', Object.keys(mod || {}))
console.log('inject =', JSON.stringify(mod && mod.inject))
console.log('typeof apply =', typeof (mod && mod.apply))
