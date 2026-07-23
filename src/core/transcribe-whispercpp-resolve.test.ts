import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = join(tmpdir(), `agim-whisper-resolve-${process.pid}-${randomBytes(3).toString('hex')}`)

async function touchBin(modRoot: string): Promise<string> {
  const binDir = join(modRoot, 'whisper', 'bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'whisper-cli')
  await writeFile(bin, '#!/bin/sh\n')
  await chmod(bin, 0o755)
  return bin
}

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

  it('shouldWarmupWhisperModel is false when bin + model already exist', async () => {
    process.env.AGIM_STT_PROVIDER = 'whispercpp'
    await touchBin(ROOT)
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const { shouldWarmupWhisperModel } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 3}`)
    expect(shouldWarmupWhisperModel()).toBe(false)
  })

  it('shouldWarmupWhisperModel when model exists but CLI is missing (auto-install platforms)', async () => {
    process.env.AGIM_STT_PROVIDER = 'whispercpp'
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 7}`)
    if (mod.canAutoInstallWhisperBin()) {
      expect(mod.shouldWarmupWhisperModel()).toBe(true)
    } else {
      expect(mod.shouldWarmupWhisperModel()).toBe(false)
    }
  })

  it('whisperReleaseAssetForHost covers linux/windows, not darwin', async () => {
    const { whisperReleaseAssetForHost } = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 8}`)
    expect(whisperReleaseAssetForHost('linux', 'x64')?.archive).toBe('tar.gz')
    expect(whisperReleaseAssetForHost('linux', 'arm64')?.archive).toBe('tar.gz')
    expect(whisperReleaseAssetForHost('win32', 'x64')?.archive).toBe('zip')
    expect(whisperReleaseAssetForHost('darwin', 'arm64')).toBe(null)
  })

  it('getWhisperModelStatus + startWhisperModelDownload report ready when bin + model exist', async () => {
    const bin = await touchBin(ROOT)
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    const modelPath = join(modelDir, 'ggml-base.bin')
    await writeFile(modelPath, 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 4}`)
    const status = mod.getWhisperModelStatus()
    expect(status.ready).toBe(true)
    expect(status.path).toBe(modelPath)
    expect(status.downloading).toBe(false)
    expect(status.bin).toBe(bin)
    expect(status.defaultBinPath).toContain('whisper-cli')
    const start = mod.startWhisperModelDownload()
    expect(start.alreadyReady).toBe(true)
    expect(start.started).toBe(false)
  })

  it('install hint mentions auto-install or manual brew depending on platform', async () => {
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 6}`)
    const zh = mod.whisperCppInstallHintZh()
    const en = mod.whisperCppInstallHintEn()
    if (mod.canAutoInstallWhisperBin()) {
      expect(zh).toMatch(/自动安装|初始化本地引擎/)
      expect(en).toMatch(/auto-install|Initialize local engine/i)
    } else {
      expect(zh).toMatch(/brew install whisper-cpp|无预编译包/)
      expect(en).toMatch(/brew install whisper-cpp|No prebuild/)
    }
    expect(zh).toMatch(/模型已就绪/)
  })

  it('startWhisperModelDownload starts when model is missing (bin already present)', async () => {
    await touchBin(ROOT)
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 5}`)
    // Stub fetch so we don't hit the network in unit tests.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(Buffer.alloc(1_500_000), { status: 200 })) as typeof fetch
    try {
      const start = mod.startWhisperModelDownload()
      expect(start.alreadyReady).toBe(false)
      expect(start.started || start.alreadyRunning).toBe(true)
      await mod.ensureWhisperModel()
      expect(mod.getWhisperModelStatus().ready).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('startWhisperModelDownload installs CLI when model exists but bin is missing', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return
    const modelDir = join(ROOT, 'whisper', 'models')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'ggml-base.bin'), 'x'.repeat(100))
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 10}`)
    expect(mod.getWhisperModelStatus().ready).toBe(true)
    expect(mod.getWhisperModelStatus().bin).toBe(null)
    // Settings button path — must install CLI even when model is already present.
    const start = mod.startWhisperModelDownload()
    expect(start.alreadyReady).toBe(false)
    expect(start.started || start.alreadyRunning).toBe(true)
    const bin = await mod.ensureWhisperBin()
    expect(bin).toBe(mod.defaultWhisperBinPath())
    expect(mod.getWhisperModelStatus().bin).toBe(bin)
  }, 120_000)

  it('ensureWhisperBin installs official linux prebuild into ~/.agim/whisper/bin', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return
    const mod = await import(`./transcribe-whispercpp-resolve.js?t=${Date.now() + 9}`)
    // Real network download — skip if offline / blocked.
    try {
      execFileSync('curl', ['-fsI', mod.whisperReleaseAssetForHost()!.url], {
        stdio: 'ignore',
        timeout: 10_000,
      })
    } catch {
      return
    }
    const bin = await mod.ensureWhisperBin()
    expect(bin).toBe(mod.defaultWhisperBinPath())
    expect(mod.resolveWhisperBin()).toBe(bin)
    // Shared libs must be relative ($ORIGIN) — absolute staging links break after install.
    const { readlinkSync } = await import('node:fs')
    const link = join(mod.whisperHomeDir(), 'bin', 'libwhisper.so.1')
    expect(readlinkSync(link)).not.toMatch(/^\/tmp\//)
    // Smoke: binary starts and prints usage (exit may be non-zero).
    try {
      execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 15_000 })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      const out = `${e.stdout || ''}${e.stderr || ''}`
      expect(out).toMatch(/usage:|whisper-cli|--help/)
    }
  }, 120_000)
})
