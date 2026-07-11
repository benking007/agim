import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIB = 1024
const ENTRY_BUDGET = 350 * KIB
const CHUNK_BUDGET = 400 * KIB

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(appRoot, 'dist')
const assetsDir = resolve(distDir, 'assets')
const html = await readFile(resolve(distDir, 'index.html'), 'utf8')
const entryMatch = html.match(/src="\/assets\/(index-[^"]+\.js)"/)

if (!entryMatch) {
  throw new Error('bundle budget: Vite entry chunk was not found in dist/index.html')
}

const chunks = await Promise.all(
  (await readdir(assetsDir))
    .filter((name) => name.endsWith('.js'))
    .map(async (name) => ({ name, bytes: (await stat(resolve(assetsDir, name))).size })),
)
const entryName = entryMatch[1]
const entry = chunks.find((chunk) => chunk.name === entryName)
const largest = chunks.reduce((current, chunk) => (
  chunk.bytes > current.bytes ? chunk : current
))

if (!entry) throw new Error(`bundle budget: missing entry asset ${entryName}`)

const failures = []
if (entry.bytes > ENTRY_BUDGET) {
  failures.push(`entry ${format(entry.bytes)} exceeds ${format(ENTRY_BUDGET)}`)
}
if (largest.bytes > CHUNK_BUDGET) {
  failures.push(`${largest.name} ${format(largest.bytes)} exceeds ${format(CHUNK_BUDGET)}`)
}

console.log(
  `[bundle-budget] entry ${format(entry.bytes)}; largest ${largest.name} ${format(largest.bytes)}`,
)
if (failures.length > 0) {
  throw new Error(`bundle budget failed: ${failures.join('; ')}`)
}

function format(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`
}
