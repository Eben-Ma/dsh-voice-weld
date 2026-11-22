/**
 * 打包脚本（重建版，原作者那台机器上的 build.mjs 没随 tarball 带过来）。
 *
 * 产出两个文件，格式与 0.1.0 已发布的 lib/ 完全一致：
 *   lib/index.js   宿主侧：esbuild format=esm，platform=node，ws 外部依赖
 *   lib/client.js  客户端：esbuild format=cjs，再套一层 __ModuleLoader__.load 外壳
 *
 * 用法：node build.mjs
 */
import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

const CLIENT_ID = 'dsh-voice-weld'

const CLIENT_HEAD = `try {
window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory: (require) => {
    try {
    var module = { exports: {} };
    var exports = module.exports;
`

const CLIENT_TAIL = `
    return module.exports;
    } catch (error) {
      console.error("[dsh-voice-live] client module failed; the rest of the UI keeps running", error);
      return { apply() {}, inject: [] };
    }
  }
});
} catch (error) {
  console.error("[dsh-voice-live] client registration failed; the rest of the UI keeps running", error);
}
`

async function bundle(options) {
  const result = await build({
    bundle: true,
    write: false,
    logLevel: 'warning',
    ...options,
  })
  const file = result.outputFiles?.[0]
  if (file === undefined) throw new Error(`esbuild produced no output for ${String(options.outfile)}`)
  return file.text
}

const host = await bundle({
  entryPoints: [resolve(root, 'src/index.ts')],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['ws'],
})

const clientBody = await bundle({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  // 必须用 automatic：classic 模式会把 JSX 编译成 `React.createElement(...)`，
  // 而这些组件只按需 import 了 hook，作用域里没有 React 标识符 → 浏览器里渲染即
  // "ReferenceError: React is not defined"，两个 UI 入口会一起变空白且不报错。
  jsx: 'automatic',
  jsxDev: false,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
})

// package.json 的 exports["./invariant"] 指向它；宿主 bundle 里已内联，这个文件是给外部 import 用的。
const invariant = await bundle({
  entryPoints: [resolve(root, 'src/invariant.ts')],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
})

await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/index.js'), host, 'utf8')
await writeFile(resolve(root, 'lib/invariant.js'), invariant, 'utf8')
// 客户端 bundle 里的 `require("react")` 由宿主的 __ModuleLoader__ 提供。
await writeFile(resolve(root, 'lib/client.js'), CLIENT_HEAD + clientBody + CLIENT_TAIL, 'utf8')

const existing = await readFile(resolve(root, 'lib/index.js'), 'utf8')
console.log(`lib/index.js   ${existing.length} bytes`)
console.log(`lib/invariant.js ${invariant.length} bytes`)
console.log(`lib/client.js  ${(CLIENT_HEAD + clientBody + CLIENT_TAIL).length} bytes`)
console.log('注意：lib/types/*.d.ts 不由本脚本生成（esbuild 不产类型），需要时用 tsc --emitDeclarationOnly 补。')

