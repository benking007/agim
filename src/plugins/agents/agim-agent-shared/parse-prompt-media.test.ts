// Regression tests for parsePromptMedia path-safety. The naive
// `startsWith(mediaRoot)` check (no trailing separator, no
// normalisation) accepted siblings of the media root and `..` traversal.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentMessagesHaveImages, encodePromptImages, parsePromptMedia } from './index.js'

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
  process.env.AGIM_MEDIA_ROOT = goodDir
})

afterAll(() => {
  delete process.env.AGIM_MEDIA_ROOT
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

  it('encodes accepted images as pi-ai ImageContent', () => {
    const encoded = encodePromptImages(`see [图片附件：${goodFile}]`)
    expect(encoded).toHaveLength(1)
    expect(encoded[0]?.type).toBe('image')
    expect(encoded[0]?.mimeType).toBe('image/jpeg')
    expect(encoded[0]?.data).toBe(Buffer.from('JFIF-bytes').toString('base64'))
    expect(parsePromptMedia(`see [图片附件：${goodFile}]`)[0]?.mime).toBe('image/jpeg')
  })

  it('detects image blocks on user / tool-result messages', () => {
    expect(agentMessagesHaveImages([
      { role: 'user', content: 'plain' },
    ])).toBe(false)
    expect(agentMessagesHaveImages([
      { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', data: 'YQ==', mimeType: 'image/png' }] },
    ])).toBe(true)
  })
})
