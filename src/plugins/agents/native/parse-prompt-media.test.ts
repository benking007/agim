// Regression tests for parsePromptMedia path-safety. The naive
// `startsWith(mediaRoot)` check (no trailing separator, no
// normalisation) accepted siblings of the media root and `..` traversal.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parsePromptMedia } from './index.js'

const root = mkdtempSync(join(tmpdir(), 'agim-media-test-'))
const goodDir = join(root, 'media')
const evilSibling = `${goodDir}-evil`
const goodFile = join(goodDir, 'telegram', 'u1', 'image.jpg')
const evilFile = join(evilSibling, 'image.jpg')
const traversalTarget = join(root, 'outside-secret.jpg')

beforeAll(() => {
  mkdirSync(goodDir, { recursive: true })
  mkdirSync(join(goodDir, 'telegram', 'u1'), { recursive: true })
  mkdirSync(evilSibling, { recursive: true })
  writeFileSync(goodFile, 'JFIF-bytes')
  writeFileSync(evilFile, 'JFIF-bytes')
  writeFileSync(traversalTarget, 'JFIF-bytes')
  process.env.IMHUB_MEDIA_ROOT = goodDir
})

afterAll(() => {
  delete process.env.IMHUB_MEDIA_ROOT
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

describe('parsePromptMedia path safety', () => {
  it('accepts a file inside the configured media root', () => {
    const out = parsePromptMedia(`hello [图片附件：${goodFile}] world`)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe(goodFile)
  })

  it('rejects a sibling directory whose name shares the media-root prefix', () => {
    const out = parsePromptMedia(`evil [图片附件：${evilFile}] note`)
    expect(out).toHaveLength(0)
  })

  it('rejects `..` traversal that resolves outside the media root', () => {
    const traversal = join(goodDir, '..', 'outside-secret.jpg')
    const out = parsePromptMedia(`evil [图片附件：${traversal}] note`)
    expect(out).toHaveLength(0)
  })

  it('rejects a relative path (must be absolute)', () => {
    const out = parsePromptMedia(`bad [图片附件：./telegram/u1/image.jpg]`)
    expect(out).toHaveLength(0)
  })

  it('rejects a non-image extension', () => {
    const txt = join(goodDir, 'telegram', 'u1', 'note.txt')
    writeFileSync(txt, 'hi')
    const out = parsePromptMedia(`text [图片附件：${txt}]`)
    expect(out).toHaveLength(0)
  })

  it('accepts the English marker variant', () => {
    const out = parsePromptMedia(`English [image attachment: ${goodFile}]`)
    expect(out).toHaveLength(1)
  })

  it('returns empty array on no markers', () => {
    expect(parsePromptMedia('plain text, nothing to see')).toEqual([])
    expect(parsePromptMedia('')).toEqual([])
  })
})
