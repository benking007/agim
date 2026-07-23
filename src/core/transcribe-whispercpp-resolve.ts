/**
 * Built-in whisper.cpp resolution — Agim's open-source local STT.
 *
 * Layout (created under AGIM_HOME):
 *   ~/.agim/whisper/bin/whisper-cli (+ shared libs from official release)
 *   ~/.agim/whisper/models/ggml-base.bin
 *
 * Resolution order for the binary:
 *   1. AGIM_STT_WHISPERCPP_BIN
 *   2. AGIM_WHISPERCPP_BIN (ops short name)
 *   3. ~/.agim/whisper/bin/whisper-cli[.exe]
 *   4. PATH: whisper-cli / whisper
 *   5. Common brew / usr paths
 *   6. Auto-download official prebuild (Linux x64/arm64, Windows x64)
 *
 * Model:
 *   1. AGIM_STT_WHISPERCPP_MODEL / AGIM_WHISPERCPP_MODEL
 *   2. ~/.agim/whisper/models/ggml-base.bin (auto-downloaded on first use)
 */

import {
  access, chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { accessSync, constants as fsConstants, createWriteStream, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { AGIM_HOME } from './agim-paths.js'
import { STT_ENV } from './transcribe-env.js'
import { logger as rootLogger } from './logger.js'

const execFileAsync = promisify(execFile)
const log = rootLogger.child({ component: 'transcribe-whispercpp' })

const BIN_NAMES = process.platform === 'win32'
  ? (['whisper-cli.exe', 'whisper-cli', 'whisper.exe', 'whisper'] as const)
  : (['whisper-cli', 'whisper'] as const)
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

/** Multilingual base — better default for zh than base.en. */
export const WHISPER_DEFAULT_MODEL_NAME = 'ggml-base.bin'
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'

/** Pinned official release used for silent CLI install. */
export const WHISPER_CPP_RELEASE = 'v1.9.1'
const RELEASE_BASE =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE}`

export function whisperHomeDir(): string {
  // Prefer live AGIM_HOME env so tests / ops overrides work without reload.
  return join(process.env.AGIM_HOME?.trim() || AGIM_HOME, 'whisper')
}

export function defaultWhisperBinPath(): string {
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return join(whisperHomeDir(), 'bin', name)
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

export interface WhisperReleaseAsset {
  url: string
  archive: 'tar.gz' | 'zip'
  cliName: string
}

/** Official prebuild for this host, or null when unsupported (e.g. macOS). */
export function whisperReleaseAssetForHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WhisperReleaseAsset | null {
  if (platform === 'linux' && arch === 'x64') {
    return {
      url: `${RELEASE_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
      archive: 'tar.gz',
      cliName: 'whisper-cli',
    }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      url: `${RELEASE_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
      archive: 'tar.gz',
      cliName: 'whisper-cli',
    }
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      url: `${RELEASE_BASE}/whisper-bin-x64.zip`,
      archive: 'zip',
      cliName: 'whisper-cli.exe',
    }
  }
  return null
}

export function canAutoInstallWhisperBin(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return whisperReleaseAssetForHost(platform, arch) !== null
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

function hasAnyCloudSttKey(): boolean {
  const cloudHints = [
    'AGIM_STT_OPENAI_API_KEY',
    'AGIM_STT_BAIDU_API_KEY',
    'AGIM_STT_TENCENT_SECRET_ID',
    'AGIM_STT_IFLYTEK_APP_ID',
    'AGIM_STT_ZHIPU_API_KEY',
    'AGIM_STT_MIMO_API_KEY',
    'AGIM_STT_STEPFUN_API_KEY',
  ]
  return cloudHints.some((k) => !!process.env[k]?.trim())
}

/**
 * True when local STT can run now, or Auto may silently install it.
 * Auto-install only counts as "configured" when no cloud STT keys exist —
 * otherwise a cloud failure would surprise-download a multi-MB CLI.
 */
export function isWhisperCppReady(): boolean {
  const bin = resolveWhisperBin()
  if (bin && existsSync(bin)) return true
  return canAutoInstallWhisperBin() && !hasAnyCloudSttKey()
}

function whisperModelPresent(): { ready: boolean; path: string | null } {
  const existing = resolveWhisperModelExisting()
  if (existing && existsSync(existing)) return { ready: true, path: existing }
  return { ready: false, path: null }
}

/**
 * Operator-facing hint when local STT cannot run. Emphasizes missing CLI
 * when the model file is already present (common confusion after prefetch).
 */
export function whisperCppInstallHintZh(): string {
  const binPath = defaultWhisperBinPath()
  const model = whisperModelPresent()
  if (canAutoInstallWhisperBin()) {
    return (
      `本地 whisper-cli 未就绪。重启 agim 或到 /settings/stt 点「初始化本地引擎」`
      + `可自动安装到 ${binPath}`
      + (model.ready ? `（模型已就绪：${model.path}）` : `；模型会下载到 ${defaultWhisperModelPath()}`)
      + '。也可改用云厂商。'
    )
  }
  if (model.ready) {
    return (
      `缺少 whisper-cli 可执行文件（模型已就绪：${model.path}）。`
      + `当前平台无预编译包，请手动安装 CLI 到 ${binPath}（macOS: brew install whisper-cpp）。`
      + '也可在 /settings/stt 改用云厂商。'
    )
  }
  return (
    `缺少 whisper-cli 可执行文件。当前平台无预编译包，请安装到 ${binPath}`
    + '（macOS: brew install whisper-cpp）；'
    + `模型可点「初始化本地引擎」下载到 ${defaultWhisperModelPath()}。`
    + '也可在 /settings/stt 改用云厂商。'
  )
}

export function whisperCppInstallHintEn(): string {
  const binPath = defaultWhisperBinPath()
  const model = whisperModelPresent()
  if (canAutoInstallWhisperBin()) {
    return (
      `Local whisper-cli is not ready. Restart agim or use Settings → Initialize local engine `
      + `to auto-install at ${binPath}`
      + (model.ready ? ` (model ready: ${model.path})` : `; model downloads to ${defaultWhisperModelPath()}`)
      + '. Or pick a cloud vendor.'
    )
  }
  if (model.ready) {
    return (
      `Missing whisper-cli binary (model is already ready at ${model.path}). `
      + `No prebuild for this platform — install CLI at ${binPath} (macOS: brew install whisper-cpp). `
      + 'Or pick a cloud vendor in /settings/stt.'
    )
  }
  return (
    `Missing whisper-cli binary. No prebuild for this platform — install at ${binPath} `
    + '(macOS: brew install whisper-cpp). '
    + `Model can be downloaded via Settings → Initialize local engine to ${defaultWhisperModelPath()}. `
    + 'Or pick a cloud vendor in /settings/stt.'
  )
}

/** Shared in-flight download (warmup + first transcribe + settings button). */
let modelEnsureInFlight: Promise<string> | null = null
let lastModelDownloadError: string | null = null
let binEnsureInFlight: Promise<string> | null = null
let lastBinDownloadError: string | null = null

export interface WhisperModelStatus {
  ready: boolean
  path: string | null
  defaultPath: string
  downloading: boolean
  lastError: string | null
  /** Resolved CLI path when the file exists; else null. */
  bin: string | null
  /** Default install path for whisper-cli (may not exist yet). */
  defaultBinPath: string
  binDownloading: boolean
  binLastError: string | null
  canAutoInstallBin: boolean
}

export function getWhisperModelStatus(): WhisperModelStatus {
  const existing = resolveWhisperModelExisting()
  const ready = !!(existing && existsSync(existing))
  const bin = resolveWhisperBin()
  return {
    ready,
    path: ready ? existing! : null,
    defaultPath: defaultWhisperModelPath(),
    downloading: modelEnsureInFlight !== null,
    lastError: ready ? null : lastModelDownloadError,
    bin: bin && existsSync(bin) ? bin : null,
    defaultBinPath: defaultWhisperBinPath(),
    binDownloading: binEnsureInFlight !== null,
    binLastError: (bin && existsSync(bin)) ? null : lastBinDownloadError,
    canAutoInstallBin: canAutoInstallWhisperBin(),
  }
}

function sttProviderPin(): string {
  return process.env.AGIM_STT_PROVIDER?.trim().toLowerCase()
    || process.env.AGIM_TRANSCRIBE_PROVIDER?.trim().toLowerCase()
    || ''
}

function localSttLikely(): boolean {
  const provider = sttProviderPin()
  if (provider === 'none') return false
  if (provider === 'whispercpp') return true
  if (!provider) return !hasAnyCloudSttKey()
  return false
}

/** True when local whisper STT is likely to be used soon (model and/or CLI). */
export function shouldWarmupWhisperModel(): boolean {
  if (!localSttLikely()) return false
  const bin = resolveWhisperBin()
  const hasBin = !!(bin && existsSync(bin))
  const needsModel = !resolveWhisperModelExisting()
  const needsBin = !hasBin && canAutoInstallWhisperBin()
  return needsModel || needsBin
}

async function findNamedFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) {
      const hit = await findNamedFile(p, name)
      if (hit) return hit
    }
  }
  return null
}

async function extractArchive(
  archivePath: string,
  kind: 'tar.gz' | 'zip',
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (kind === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir])
    return
  }
  // zip — prefer unzip, then python3 (common on Linux CI / ops hosts), then tar.
  try {
    await execFileAsync('unzip', ['-q', archivePath, '-d', destDir])
    return
  } catch { /* try next */ }
  try {
    await execFileAsync('python3', [
      '-c',
      'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
      archivePath,
      destDir,
    ])
    return
  } catch { /* try next */ }
  await execFileAsync('tar', ['-xf', archivePath, '-C', destDir])
}

/** Stream a URL to disk (avoids buffering multi‑hundred‑MB archives in RAM). */
async function downloadUrlToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} downloading ${url}`)
  }
  await mkdir(dirname(dest), { recursive: true })
  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  await pipeline(nodeStream, createWriteStream(dest))
  const st = await stat(dest)
  return st.size
}

async function downloadWhisperBinToDefault(): Promise<string> {
  const asset = whisperReleaseAssetForHost()
  if (!asset) {
    throw new Error(
      `no official whisper.cpp prebuild for ${process.platform}/${process.arch}`,
    )
  }
  const binDir = join(whisperHomeDir(), 'bin')
  const dest = join(binDir, asset.cliName)
  const staging = await mkdtemp(join(tmpdir(), 'agim-whisper-bin-'))
  log.info({ event: 'whisper.bin.download_start', url: asset.url, dest })
  try {
    const archivePath = join(
      staging,
      asset.archive === 'tar.gz' ? 'pack.tar.gz' : 'pack.zip',
    )
    const bytes = await downloadUrlToFile(asset.url, archivePath)
    if (bytes < 100_000) {
      throw new Error(`CLI archive too small (${bytes} bytes)`)
    }
    const extractRoot = join(staging, 'out')
    await extractArchive(archivePath, asset.archive, extractRoot)
    const cliPath = await findNamedFile(extractRoot, asset.cliName)
    if (!cliPath) {
      throw new Error(`archive missing ${asset.cliName}`)
    }
    const srcDir = dirname(cliPath)
    await mkdir(binDir, { recursive: true })
    // Preserve relative shared-lib symlinks ($ORIGIN). Node fs.cp rewrites
    // them to absolute staging paths that vanish after cleanup.
    if (process.platform === 'win32') {
      for (const name of await readdir(srcDir)) {
        await cp(join(srcDir, name), join(binDir, name), {
          recursive: true, force: true, dereference: true,
        })
      }
    } else {
      await execFileAsync('cp', ['-a', `${srcDir}/.`, binDir])
    }
    if (process.platform !== 'win32') {
      await chmod(dest, 0o755)
    }
    await writeFile(join(binDir, '.agim-whisper-release'), `${WHISPER_CPP_RELEASE}\n`)
    log.info({
      event: 'whisper.bin.download_ok',
      dest,
      bytes,
      release: WHISPER_CPP_RELEASE,
    })
    return dest
  } catch (err) {
    log.warn({
      event: 'whisper.bin.download_failed',
      err: err instanceof Error ? err.message : String(err),
      dest,
    })
    throw err
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** Ensure whisper-cli exists; download official prebuild when supported. */
export async function ensureWhisperBin(): Promise<string> {
  const existing = resolveWhisperBin()
  if (existing && existsSync(existing)) return existing
  if (binEnsureInFlight) return binEnsureInFlight

  lastBinDownloadError = null
  binEnsureInFlight = (async () => {
    try {
      const path = await downloadWhisperBinToDefault()
      lastBinDownloadError = null
      return path
    } catch (err) {
      lastBinDownloadError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      binEnsureInFlight = null
    }
  })()
  return binEnsureInFlight
}

async function downloadWhisperModelToDefault(): Promise<string> {
  const dest = defaultWhisperModelPath()
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  log.info({ event: 'whisper.model.download_start', url: MODEL_URL, dest })
  try {
    const bytes = await downloadUrlToFile(MODEL_URL, tmp)
    if (bytes < 1_000_000) {
      throw new Error(`model download too small (${bytes} bytes)`)
    }
    await rename(tmp, dest)
    log.info({ event: 'whisper.model.download_ok', dest, bytes })
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

/** Ensure model file exists; download ggml-base.bin on first use / warmup / UI init. */
export async function ensureWhisperModel(): Promise<string> {
  const existing = resolveWhisperModelExisting()
  if (existing && existsSync(existing)) return existing
  if (modelEnsureInFlight) return modelEnsureInFlight

  lastModelDownloadError = null
  modelEnsureInFlight = (async () => {
    try {
      const path = await downloadWhisperModelToDefault()
      lastModelDownloadError = null
      return path
    } catch (err) {
      lastModelDownloadError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      modelEnsureInFlight = null
    }
  })()
  return modelEnsureInFlight
}

/** Ensure CLI + model (downloads when missing). */
export async function ensureWhisperRuntime(): Promise<{ bin: string; model: string }> {
  const bin = await ensureWhisperBin()
  const model = await ensureWhisperModel()
  return { bin, model }
}

export interface WhisperModelDownloadStart {
  alreadyReady: boolean
  alreadyRunning: boolean
  started: boolean
  path?: string
  binPath?: string
}

/**
 * Explicit operator-triggered install (settings). Always attempts ensure for
 * both CLI (when auto-installable) and model — unlike silent warmup skips.
 */
export function startWhisperModelDownload(): WhisperModelDownloadStart {
  const modelExisting = resolveWhisperModelExisting()
  const binExisting = resolveWhisperBin()
  const hasModel = !!(modelExisting && existsSync(modelExisting))
  const hasBin = !!(binExisting && existsSync(binExisting))
  if (hasModel && hasBin) {
    return {
      alreadyReady: true,
      alreadyRunning: false,
      started: false,
      path: modelExisting!,
      binPath: binExisting!,
    }
  }
  const wasRunning = modelEnsureInFlight !== null || binEnsureInFlight !== null
  void ensureWhisperRuntime().catch(() => {
    // Errors recorded in last*DownloadError; UI polls status.
  })
  return {
    alreadyReady: false,
    alreadyRunning: wasRunning,
    started: !wasRunning,
  }
}

/**
 * Fire-and-forget CLI + model install at `agim start`. Never throws; never
 * blocks boot. Skips when local STT is unlikely or everything is present.
 */
export function startWhisperModelWarmup(): void {
  if (!shouldWarmupWhisperModel()) {
    log.debug({ event: 'whisper.runtime.warmup_skip' })
    return
  }
  void ensureWhisperRuntime().then(({ bin, model }) => {
    log.info({ event: 'whisper.runtime.warmup_ok', bin, model })
  }).catch((err) => {
    log.warn({
      event: 'whisper.runtime.warmup_failed',
      err: err instanceof Error ? err.message : String(err),
    })
  })
}

/** Resolve bin + model for a transcription call (may download both). */
export async function resolveWhisperCppForTranscribe(): Promise<{ bin: string; model: string }> {
  let bin = resolveWhisperBin()
  if (!bin || !existsSync(bin)) {
    if (canAutoInstallWhisperBin()) {
      try {
        bin = await ensureWhisperBin()
      } catch {
        throw new Error(whisperCppInstallHintZh())
      }
    } else {
      throw new Error(whisperCppInstallHintZh())
    }
  }
  // Cheap executable check (optional — Windows may lack X_OK semantics).
  try {
    await access(bin, fsConstants.X_OK)
  } catch {
    if (!isExecutable(bin)) {
      throw new Error(`${bin} 不可执行 — ${whisperCppInstallHintZh()}`)
    }
  }
  const model = await ensureWhisperModel()
  return { bin, model }
}
