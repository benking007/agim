#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(projectRoot, 'dist')
const generatedTestFile = /\.(?:test|spec)\.(?:[cm]?js(?:\.map)?|d\.[cm]?ts(?:\.map)?)$/

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return files.flat()
}

let files
try {
  files = await walk(distDir)
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new Error('dist check failed: run the production build before checking artifacts')
  }
  throw error
}

const forbidden = files.filter((path) => (
  generatedTestFile.test(path) || path.split('/').includes('__tests__')
))

if (forbidden.length > 0) {
  const list = forbidden
    .map((path) => `  - ${relative(projectRoot, path)}`)
    .join('\n')
  throw new Error(`dist check failed: test artifacts are not publishable\n${list}`)
}

const sizes = await Promise.all(files.map(async (path) => (await stat(path)).size))
const bytes = sizes.reduce((total, size) => total + size, 0)
console.log(`[dist-check] ${files.length} files, ${formatBytes(bytes)}, no test artifacts`)

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024)
  return `${mib.toFixed(1)} MiB`
}
