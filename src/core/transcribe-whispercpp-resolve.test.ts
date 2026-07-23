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

  beforeEach(async () => {
    savedHome = process.env.AGIM_HOME
    savedBin = process.env.AGIM_STT_WHISPERCPP_BIN
    savedModel = process.env.AGIM_STT_WHISPERCPP_MODEL
    savedLegacyBin = process.env.AGIM_WHISPERCPP_BIN
    process.env.AGIM_HOME = ROOT
    delete process.env.AGIM_STT_WHISPERCPP_BIN
    delete process.env.AGIM_STT_WHISPERCPP_MODEL
    delete process.env.AGIM_WHISPERCPP_BIN
    delete process.env.AGIM_WHISPERCPP_MODEL
    await rm(ROOT, { recursive: true, force: true })
    await mkdir(ROOT, { recursive: true })
    // Re-import after AGIM_HOME is set — module caches AGIM_HOME at load.
    // Tests call helpers that read process.env + join(AGIM_HOME); we mock via
    // rewriting paths by setting env overrides instead of reloading AGIM_HOME.
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
})
