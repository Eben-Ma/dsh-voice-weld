// Minimal asar reader: list / extract entries from an .asar archive.
import fs from 'node:fs'
import path from 'node:path'

const asarPath = process.argv[2]
const mode = process.argv[3] // 'list' | 'grep' | 'cat'
const arg = process.argv[4] ?? ''

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, null)
const headerSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = 8 + headerSize

// offsets in the header are relative to the end of the header
const entries = []
function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, full)
    else entries.push({ path: full, size: child.size, offset: child.offset })
  }
}
walk(header, '')

if (mode === 'list') {
  const re = arg ? new RegExp(arg) : null
  for (const e of entries) if (!re || re.test(e.path)) console.log(e.size, e.path)
} else if (mode === 'cat') {
  const e = entries.find((x) => x.path.replaceAll('\\', '/') === arg)
  if (!e) {
    console.error('not found:', arg)
    process.exit(1)
  }
  const buf = Buffer.alloc(e.size)
  fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset))
  process.stdout.write(buf)
} else if (mode === 'grep') {
  const re = new RegExp(arg)
  for (const e of entries) {
    if (e.size > 3_000_000) continue
    if (!/\.(js|mjs|cjs|json|ts)$/.test(e.path)) continue
    const buf = Buffer.alloc(e.size)
    fs.readSync(fd, buf, 0, e.size, baseOffset + Number(e.offset))
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) console.log(`${e.path}:${i + 1}: ${lines[i].slice(0, 300)}`)
    }
  }
}
fs.closeSync(fd)
