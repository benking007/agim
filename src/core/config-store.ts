import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { stripRetiredAcpKeys } from './config-schema.js'

export type ConfigObject = Record<string, unknown>

export interface ConfigStoreOptions {
  filePath?: string
  fallback?: ConfigObject
  lockTimeoutMs?: number
  staleLockMs?: number
}

export interface ConfigUpdate<T> {
  config: ConfigObject
  result: T
}

export const CONFIG_FILE = join(AGIM_HOME, 'config.json')

const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 30_000
const processQueues = new Map<string, Promise<void>>()

export class ConfigLockTimeoutError extends Error {
  constructor(readonly lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for config lock ${lockPath}`)
    this.name = 'ConfigLockTimeoutError'
  }
}

function assertConfigObject(value: unknown): asserts value is ConfigObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('config.json must contain a JSON object')
  }
}

function cloneFallback(fallback: ConfigObject | undefined): ConfigObject {
  return structuredClone(fallback ?? {})
}

export async function readConfigObject<T extends ConfigObject = ConfigObject>(
  options: ConfigStoreOptions = {},
): Promise<T> {
  const filePath = options.filePath ?? CONFIG_FILE
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
    assertConfigObject(parsed)
    return parsed as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return cloneFallback(options.fallback) as T
    }
    throw err
  }
}

export async function writeConfigObject(
  config: ConfigObject,
  options: ConfigStoreOptions = {},
): Promise<void> {
  assertConfigObject(config)
  const filePath = options.filePath ?? CONFIG_FILE
  await withProcessQueue(filePath, async () => {
    const release = await acquireConfigLock(filePath, options)
    try {
      await atomicWriteJson(filePath, config)
    } finally {
      await release()
    }
  })
}

export async function updateConfigObject<T>(
  updater: (current: ConfigObject) => ConfigUpdate<T>,
  options: ConfigStoreOptions = {},
): Promise<ConfigUpdate<T>> {
  const filePath = options.filePath ?? CONFIG_FILE
  return await withProcessQueue(filePath, async () => {
    const release = await acquireConfigLock(filePath, options)
    try {
      const current = await readConfigObject({
        ...options,
        filePath,
      })
      const update = updater(current)
      assertConfigObject(update.config)
      await atomicWriteJson(filePath, update.config)
      return update
    } finally {
      await release()
    }
  })
}

async function withProcessQueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = processQueues.get(filePath) ?? Promise.resolve()
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const tail = previous.catch(() => {}).then(() => gate)
  processQueues.set(filePath, tail)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    releaseGate?.()
    if (processQueues.get(filePath) === tail) processQueues.delete(filePath)
  }
}

async function atomicWriteJson(filePath: string, config: ConfigObject): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  // Drop retired ACP keys on every write so install/upgrade paths cannot
  // re-persist acpPort / acpAgents after the surface was removed.
  const sanitized = stripRetiredAcpKeys(config) as ConfigObject
  let handle: FileHandle | undefined
  try {
    handle = await open(tmpPath, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(sanitized, null, 2), 'utf-8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, filePath)
    try { await chmod(filePath, 0o600) } catch { /* Windows ignores POSIX modes. */ }
    await syncDirectory(dir)
  } catch (err) {
    try { await handle?.close() } catch { /* best-effort cleanup */ }
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems.
  } finally {
    try { await handle?.close() } catch { /* best-effort */ }
  }
}

async function acquireConfigLock(
  filePath: string,
  options: ConfigStoreOptions,
): Promise<() => Promise<void>> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const lockPath = `${filePath}.lock`
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
  const deadline = Date.now() + timeoutMs
  const token = `${process.pid}:${randomUUID()}`
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })
  let delayMs = 10

  while (true) {
    try {
      // Single O_EXCL write — avoids an empty-file window between open(wx) and writeFile
      // that let waiters observe partial JSON during multi-process stress.
      await writeFile(lockPath, payload, { flag: 'wx', mode: 0o600 })
      return async () => {
        try {
          const raw = await readFile(lockPath, 'utf-8')
          if (!raw.trim()) return
          const owner = JSON.parse(raw) as { token?: unknown }
          if (owner.token === token) await rm(lockPath, { force: true })
        } catch (err) {
          // Best-effort unlock: never fail the transaction because another waiter
          // reclaimed/replaced the lock file mid-release.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
          if (err instanceof SyntaxError) return
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Compare-and-reclaim (rename snapshot) — never blind-rm a live lock that
      // another waiter acquired between our stale check and the delete.
      await tryReclaimLock(lockPath, staleLockMs)
      if (Date.now() >= deadline) throw new ConfigLockTimeoutError(lockPath, timeoutMs)
      await sleep(delayMs)
      delayMs = Math.min(delayMs + 10, 100)
    }
  }
}

/**
 * Atomically take a reclaimable lock out of the way via rename, then delete.
 * If another process replaced the lock between snapshot and rename, put it back.
 */
async function tryReclaimLock(lockPath: string, staleLockMs: number): Promise<void> {
  let raw: string
  let mtimeMs: number
  try {
    const info = await stat(lockPath)
    mtimeMs = info.mtimeMs
    raw = await readFile(lockPath, 'utf-8')
  } catch (err) {
    // Owner released between our failed wx and this check — nothing to reclaim.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    return
  }
  if (!isLockReclaimable(raw, mtimeMs, staleLockMs)) return

  const tomb = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`
  try {
    await rename(lockPath, tomb)
  } catch {
    // Lost the reclaim race (ENOENT) or FS glitch — retry acquire loop.
    return
  }

  try {
    const moved = await readFile(tomb, 'utf-8')
    if (moved !== raw) {
      // We picked up a newer lock that appeared under the same path — restore it.
      await rename(tomb, lockPath).catch(() => {})
      return
    }
  } catch {
    // Tomb unreadable; drop it so waiters are not wedged.
  }
  await rm(tomb, { force: true }).catch(() => {})
}

function isLockReclaimable(raw: string, mtimeMs: number, staleLockMs: number): boolean {
  if (Date.now() - mtimeMs >= staleLockMs) return true
  try {
    if (!raw.trim()) return true
    const owner = JSON.parse(raw) as { pid?: unknown }
    return typeof owner.pid === 'number' && !isProcessAlive(owner.pid)
  } catch {
    // Corrupt / partial lock JSON — safe to reclaim.
    return true
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
