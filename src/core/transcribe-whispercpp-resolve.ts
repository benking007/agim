/**
 * Built-in whisper.cpp resolution — Agim's open-source local STT.
 *
 * Layout (created under AGIM_HOME):
 *   ~/.agim/whisper/bin/whisper-cli
 *   ~/.agim/whisper/models/ggml-base.bin
 *
 * Resolution order for the binary:
 *   1. AGIM_STT_WHISPERCPP_BIN
 *   2. AGIM_WHISPERCPP_BIN (ops short name)
 *   3. ~/.agim/whisper/bin/whisper-cli
 *   4. PATH: whisper-cli / whisper
 *   5. Common brew / usr paths
 *
 * Model:
 *   1. AGIM_STT_WHISPERCPP_MODEL / AGIM_WHISPERCPP_MODEL
 *   2. ~/.agim/whisper/models/ggml-base.bin (auto-downloaded on first use)
 */

import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AGIM_HOME } from './agim-paths.js'
import { STT_ENV } from './transcribe-env.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'transcribe-whispercpp' })

const BIN_NAMES = ['whisper-cli', 'whisper'] as const
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

/** Multilingual base — better default for zh than base.en. */
export const WHISPER_DEFAULT_MODEL_NAME = 'ggml-base.bin'
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'

export function whisperHomeDir(): string {
  // Prefer live AGIM_HOME env so tests / ops overrides work without reload.
  return join(process.env.AGIM_HOME?.trim() || AGIM_HOME, 'whisper')
}

export function defaultWhisperBinPath(): string {
  return join(whisperHomeDir(), 'bin', 'whisper-cli')
}

export function defaultWhisperModelPath(): string {
  return join(whisperHomeDir(), 'models', WHISPER_DEFAULT_MODEL_NAME)
}

function envFirst(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k]?.trim()
    if (v) return v
  }
  return undefined
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return existsSync(path)
  }
}

function which(cmd: string): string | undefined {
  try {
    const out = execFileSync('which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/** Resolve whisper.cpp CLI path (sync — used by detectProvider). */
export function resolveWhisperBin(): string | undefined {
  const fromEnv = envFirst(STT_ENV.whisperBin, 'AGIM_WHISPERCPP_BIN')
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const bundled = defaultWhisperBinPath()
  if (existsSync(bundled)) return bundled

  for (const name of BIN_NAMES) {
    const hit = which(name)
    if (hit && existsSync(hit)) return hit
  }

  for (const dir of COMMON_BIN_DIRS) {
    for (const name of BIN_NAMES) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }

  // Env set but file missing — still return so error mentions the path.
  if (fromEnv) return fromEnv
  return undefined
}

/** Resolve model path if the file already exists (sync). */
export function resolveWhisperModelExisting(): string | undefined {
  const fromEnv = envFirst(STT_ENV.whisperModel, 'AGIM_WHISPERCPP_MODEL')
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const def = defaultWhisperModelPath()
  if (existsSync(def)) return def

  // Prefer smaller multilingual models if operator dropped them in place.
  for (const name of ['ggml-small.bin', 'ggml-tiny.bin', 'ggml-base.en.bin']) {
    const p = join(whisperHomeDir(), 'models', name)
    if (existsSync(p)) return p
  }

  if (fromEnv) return fromEnv
  return undefined
}

/** True when the local open-source STT can run (bin present; model present or downloadable default). */
export function isWhisperCppReady(): boolean {
  const bin = resolveWhisperBin()
  if (!bin || !existsSync(bin)) return false
  const model = resolveWhisperModelExisting()
  if (model && existsSync(model)) return true
  // Bin exists — model will be fetched lazily to the default path.
  return true
}

export function whisperCppInstallHintZh(): string {
  return (
    '本地 whisper.cpp 未就绪。请安装 CLI 到 '
    + `${defaultWhisperBinPath()}（或 brew install whisper-cpp / 放入 PATH），`
    + `模型会自动下载到 ${defaultWhisperModelPath()}；也可在 /settings/stt 改用云厂商。`
  )
}

export function whisperCppInstallHintEn(): string {
  return (
    'Local whisper.cpp is not ready. Install whisper-cli at '
    + `${defaultWhisperBinPath()} (or brew install whisper-cpp / put it on PATH). `
    + `The model auto-downloads to ${defaultWhisperModelPath()}. Or pick a cloud vendor in /settings/stt.`
  )
}

/** Ensure model file exists; download ggml-base.bin on first use. */
export async function ensureWhisperModel(): Promise<string> {
  const existing = resolveWhisperModelExisting()
  if (existing && existsSync(existing)) return existing

  const dest = defaultWhisperModelPath()
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  log.info({ event: 'whisper.model.download_start', url: MODEL_URL, dest })
  try {
    const res = await fetch(MODEL_URL, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} downloading ${MODEL_URL}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 1_000_000) {
      throw new Error(`model download too small (${buf.byteLength} bytes)`)
    }
    await writeFile(tmp, buf)
    await rename(tmp, dest)
    log.info({ event: 'whisper.model.download_ok', dest, bytes: buf.byteLength })
    return dest
  } catch (err) {
    await unlink(tmp).catch(() => {})
    log.warn({
      event: 'whisper.model.download_failed',
      err: err instanceof Error ? err.message : String(err),
      dest,
    })
    throw err
  }
}

/** Resolve bin + model for a transcription call (may download model). */
export async function resolveWhisperCppForTranscribe(): Promise<{ bin: string; model: string }> {
  const bin = resolveWhisperBin()
  if (!bin || !existsSync(bin)) {
    throw new Error(whisperCppInstallHintEn())
  }
  // Cheap executable check (optional — Windows may lack X_OK semantics).
  try {
    await access(bin, fsConstants.X_OK)
  } catch {
    if (!isExecutable(bin)) {
      throw new Error(`${bin} is not executable — ${whisperCppInstallHintEn()}`)
    }
  }
  const model = await ensureWhisperModel()
  return { bin, model }
}
