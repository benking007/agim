import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const ROOT = join(tmpdir(), `agim-whisper-resolve-${process.pid}-${randomBytes(3).toString('hex')}`)

describe('whisper.cpp built-in resolve', () => {
  let savedHome: string | undefined
  let savedBin: string | undefined
  let savedModel: string | undefined
  let savedLegacyBin: string | undefined
  let savedProvider: string | undefined

  beforeEach(async () => {
    savedHome = process.env.AGIM_HOME
    savedBin = process.env.AGIM_STT_WHISPERCPP_BIN
    savedModel = process.env.AGIM_STT_WHISPERCPP_MODEL
    savedLegacyBin = process.env.AGIM_WHISPERCPP_BIN
    savedProvider = process.env.AGIM_STT_PROVIDER
    process.env.AGIM_HOME = ROOT
    delete process.env.AGIM_STT_WHISPERCPP_BIN
    delete process.env.AGIM_STT_WHISPERCPP_MODEL
    delete process.env.AGIM_WHISPERCPP_BIN
    delete process.env.AGIM_WHISPERCPP_MODEL
    delete process.env.AGIM_STT_PROVIDER
    delete process.env.AGIM_TRANSCRIBE_PROVIDER
    await rm(ROOT, { recursive: true, force: true })
    await mkdir(ROOT, { recursive: true })
  })

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = savedHome
    if (savedBin === undefined) delete process.env.AGIM_STT_WHISPERCPP_BIN
    else process.env.AGIM_STT_WHISPERCPP_BIN = savedBin
    if (savedModel === undefined) delete process.env.AGIM_STT_WHISPERCPP_MODEL
    else process.env.AGIM_STT_WHISPERCPP_MODEL = savedModel
    if (savedLegacyBin === undefined) delete process.env.AGIM_WHISPERCPP_BIN
    else process.env.AGIM_WHISPERCPP_BIN = savedLegacyBin
    if (savedProvider === undefined) delete process.env.AGIM_STT_PROVIDER
    else process.env.AGIM_STT_PROVIDER = savedProvider
    await rm(ROOT, { recursive: true, force: true })
  })

  it('prefers AGIM_STT_WHISPERCPP_BIN when the file exists', async () => {
    const bin = join(ROOT, 'custom-whisper')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    process.env.AGIM_STT_WHISPERCPP_BIN = bin
    const { resolveWhisperBin } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now()}`)
    expect(resolveWhisperBin()).toBe(bin)
  })

  it('falls back to AGIM_WHISPERCPP_BIN legacy name', async () => {
    const bin = join(ROOT, 'legacy-whisper')
    await writeFile(bin, '#!/bin/sh\n')
    await chmod(bin, 0o755)
    process.env.AGIM_WHISPERCPP_BIN = bin
    const { resolveWhisperBin } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 1}`)
    expect(resolveWhisperBin()).toBe(bin)
  })

  it('shouldWarmupWhisperModel when provider is pinned to whispercpp', async () => {
    process.env.AGIM_STT_PROVIDER = 'whispercpp'
    const { shouldWarmupWhisperModel } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 2}`)
    expect(shouldWarmupWhisperModel()).toBe(true)
  })

  it('shouldWarmupWhisperModel is false when model already exists', async () => {
    process.env.AGIM_STT_PROVIDER = 'whispercpp'
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const { shouldWarmupWhisperModel } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 3}`)
    expect(shouldWarmupWhisperModel()).toBe(false)
  })

  it('getWhisperModelStatus + startWhisperModelDownload report ready when model exists', async () => {
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    const modelPath = join(modelDir, 'ggml-base.bin')
    await writeFile(modelPath, 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 4}`)
    const status = mod.getWhisperModelStatus()
    expect(status.ready).toBe(true)
    expect(status.path).toBe(modelPath)
    expect(status.downloading).toBe(false)
    expect(status.bin).toBe(null)
    expect(status.defaultBinPath).toContain('whisper-cli')
    const start = mod.startWhisperModelDownload()
    expect(start.alreadyReady).toBe(true)
    expect(start.started).toBe(false)
  })

  it('install hint stresses missing CLI when model already exists', async () => {
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 6}`)
    const zh = mod.whisperCppInstallHintZh()
    const en = mod.whisperCppInstallHintEn()
    expect(zh).toMatch(/缺少 whisper-cli/)
    expect(zh).toMatch(/模型已就绪/)
    expect(en).toMatch(/Missing whisper-cli/)
    expect(en).toMatch(/model is already ready/)
    expect(zh).not.toMatch(/模型会自动下载/)
  })

  it('startWhisperModelDownload starts when model is missing', async () => {
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 5}`)
    // Stub fetch so we don't hit the network in unit tests.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(Buffer.alloc(1_500_000), { status: 200 })) as typeof fetch
    try {
      const start = mod.startWhisperModelDownload()
      expect(start.alreadyReady).toBe(false)
      expect(start.started || start.alreadyRunning).toBe(true)
      expect(mod.getWhisperModelStatus().downloading).toBe(true)
      await mod.ensureWhisperModel()
      expect(mod.getWhisperModelStatus().ready).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
