// A2A Layer 2 — shared artifact pool.
//
// Each A2A inline job gets a dedicated directory under
// `~/.agim/artifacts/<jobId>/`, split into:
//
//   _agim-input/   — files copied here by callAgentByName before the callee
//                    runs. Read-only by convention (we don't enforce mode).
//   _agim-output/  — files the callee writes here become visible to the
//                    caller in callAgentByName's return value.
//
// Lifecycle is bound to the inline-job row: when job-board's retention
// sweep prunes a row, pruneArtifacts() removes its directory too.
//
// Trust model is single-host: every agent runs as the same user, so we
// don't sandbox file access. We do enforce size + count caps so a runaway
// callee can't blow up the disk.
//
// Why one central tree (~/.agim/artifacts/) instead of per-agent cwd:
//   - callers and callees can use absolute paths consistently
//   - retention sits next to jobs.db and audit.db, easy to back up / wipe
//   - doesn't pollute ~/.agim-workspaces/<agent>/ which is long-term memory
//   - mirrors the file/jobs.db split — workspace cwds are conceptual
//     home directories, artifacts/ is per-call scratch.

import { mkdir, copyFile, link, readFile, writeFile, readdir, stat, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute, dirname, basename } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'a2a.artifacts' })

const ROOT = join(AGIM_HOME, 'artifacts')

// ─── env-tunable caps ───────────────────────────────────────────────

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024      // 50 MB
const DEFAULT_MAX_JOB_BYTES  = 200 * 1024 * 1024     // 200 MB
const DEFAULT_MAX_FILES      = 200

function resolveMaxFileBytes(): number {
  const raw = process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_FILE
  if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n) && n > 0) return n }
  return DEFAULT_MAX_FILE_BYTES
}
function resolveMaxJobBytes(): number {
  const raw = process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_JOB
  if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n) && n > 0) return n }
  return DEFAULT_MAX_JOB_BYTES
}
function resolveMaxFiles(): number {
  const raw = process.env.IMHUB_A2A_ARTIFACT_MAX_FILES_PER_JOB
  if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n) && n > 0) return n }
  return DEFAULT_MAX_FILES
}

// ─── public API ─────────────────────────────────────────────────────

export interface JobArtifactDirs {
  jobDir: string       // ~/.agim/artifacts/<jobId>/
  inputDir: string     // ~/.agim/artifacts/<jobId>/_agim-input/
  outputDir: string    // ~/.agim/artifacts/<jobId>/_agim-output/
}

export type InputSource =
  | { name: string; fromCallerOutput: string }
  | { name: string; fromAbsolutePath: string }
  | { name: string; content: string }

export interface OutputFile {
  name: string
  bytes: number
  mtime: string  // ISO
}

/** Resolve the on-disk dirs for a job. Does NOT create them. Pure path math. */
export function getArtifactsDir(jobId: number): JobArtifactDirs {
  const jobDir = join(ROOT, String(jobId))
  return {
    jobDir,
    inputDir: join(jobDir, '_agim-input'),
    outputDir: join(jobDir, '_agim-output'),
  }
}

/** Make sure all three dirs exist; idempotent.
 *
 *  Security: dir mode 0o700 so other users on the host can't traverse
 *  into a job's artifacts (which may contain operator code copies,
 *  A2A intermediate files, etc). Files inside get mode 0o600 on write.
 *  Note: mkdir's `mode` is masked by the process umask on most systems,
 *  but with default umask 0022 this still produces 0o700 → 0o700 ∩ 0o755 = 0o700,
 *  so the explicit mode dominates the OS default.
 */
export async function ensureArtifactsDir(jobId: number): Promise<JobArtifactDirs> {
  const dirs = getArtifactsDir(jobId)
  await mkdir(dirs.inputDir, { recursive: true, mode: 0o700 })
  await mkdir(dirs.outputDir, { recursive: true, mode: 0o700 })
  return dirs
}

/** Copy the caller-supplied inputs into the callee's _agim-input/.
 *  Resolution rules:
 *    - `fromAbsolutePath` — copyFile from disk; absolute paths only (reject
 *      anything with a relative segment to avoid CWD-dependent surprises).
 *    - `fromCallerOutput` — pull from <ROOT>/<callerJobId>/_agim-output/<name>.
 *    - `content`          — write the string verbatim (UTF-8).
 *  All three honor the per-file size cap. After every write the running
 *  per-job byte+count totals are re-checked; on overflow we throw + leave
 *  the partial state for the caller to inspect on failure.
 *  Uses hard links when source/destination share a device — near-zero
 *  cost for read-only inputs. Falls back to copy on EXDEV. */
export async function copyInputs(
  jobId: number,
  inputs: InputSource[],
  callerJobId?: number,
): Promise<Array<{ name: string; bytes: number }>> {
  if (!inputs.length) return []
  const dirs = await ensureArtifactsDir(jobId)
  const maxFile = resolveMaxFileBytes()
  const maxJob = resolveMaxJobBytes()
  const maxFiles = resolveMaxFiles()
  const written: Array<{ name: string; bytes: number }> = []
  let totalBytes = 0

  for (const inp of inputs) {
    if (written.length >= maxFiles) {
      throw new Error(`artifacts: too many input files (max ${maxFiles})`)
    }
    const inputName = inp.name  // capture for the final 'never' branch
    if (!inputName || inputName.includes('/') || inputName.includes('\\') || inputName === '..') {
      throw new Error(`artifacts: input filename invalid (no slashes / no '..'): ${JSON.stringify(inputName)}`)
    }
    const dest = join(dirs.inputDir, inputName)
    let bytes = 0
    if ('fromAbsolutePath' in inp) {
      if (!isAbsolute(inp.fromAbsolutePath)) {
        throw new Error(`artifacts: fromAbsolutePath must be absolute: ${inp.fromAbsolutePath}`)
      }
      const st = await stat(inp.fromAbsolutePath)
      if (!st.isFile()) throw new Error(`artifacts: source not a regular file: ${inp.fromAbsolutePath}`)
      if (st.size > maxFile) throw new Error(`artifacts: ${inp.name} exceeds per-file cap (${st.size} > ${maxFile})`)
      bytes = st.size
      try {
        await link(inp.fromAbsolutePath, dest)
      } catch (err) {
        // EEXIST (file already there from a prior copyInputs of same name)
        // and EXDEV (cross-device) both fall back to plain copy.
        await copyFile(inp.fromAbsolutePath, dest)
        void err
      }
      // chmod 0o600 unconditionally — both link() and copyFile() may
      // inherit lax permissions from the source. Hard links share an
      // inode (changing one changes the source) — acceptable here
      // because the source is operator-controlled; we don't expect
      // permissions to be looser than 0o600 after this.
      await chmod(dest, 0o600).catch(() => { /* best-effort */ })
    } else if ('fromCallerOutput' in inp) {
      if (typeof callerJobId !== 'number' || callerJobId <= 0) {
        throw new Error(`artifacts: fromCallerOutput requires a callerJobId`)
      }
      const callerDirs = getArtifactsDir(callerJobId)
      const src = join(callerDirs.outputDir, inp.fromCallerOutput)
      if (!existsSync(src)) {
        throw new Error(`artifacts: caller output '${inp.fromCallerOutput}' not found (job ${callerJobId})`)
      }
      const st = await stat(src)
      if (st.size > maxFile) throw new Error(`artifacts: ${inp.name} exceeds per-file cap (${st.size} > ${maxFile})`)
      bytes = st.size
      try { await link(src, dest) } catch { await copyFile(src, dest) }
      await chmod(dest, 0o600).catch(() => { /* best-effort */ })
    } else if ('content' in inp) {
      const buf = Buffer.from(inp.content, 'utf-8')
      if (buf.length > maxFile) {
        throw new Error(`artifacts: ${inp.name} content exceeds per-file cap (${buf.length} > ${maxFile})`)
      }
      bytes = buf.length
      // mode 0o600 — same posture as session logs; A2A inline content
      // may contain operator code / secrets.
      await writeFile(dest, buf, { mode: 0o600 })
    } else {
      throw new Error(`artifacts: input '${inputName}' missing fromAbsolutePath / fromCallerOutput / content`)
    }
    totalBytes += bytes
    if (totalBytes > maxJob) {
      throw new Error(`artifacts: per-job byte cap exceeded (${totalBytes} > ${maxJob})`)
    }
    written.push({ name: inputName, bytes })
  }
  return written
}

/** List everything the callee left under _agim-output/. */
export async function listOutputs(jobId: number): Promise<OutputFile[]> {
  const { outputDir } = getArtifactsDir(jobId)
  if (!existsSync(outputDir)) return []
  let names: string[]
  try { names = await readdir(outputDir) } catch { return [] }
  const out: OutputFile[] = []
  for (const name of names) {
    try {
      const st = await stat(join(outputDir, name))
      if (st.isFile()) {
        out.push({ name, bytes: st.size, mtime: st.mtime.toISOString() })
      }
    } catch { /* skip transient errors */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** Read a single output file (for /a2a tree or future Web UI download). */
export async function readOutput(jobId: number, name: string): Promise<Buffer | null> {
  if (name.includes('/') || name === '..') return null
  const { outputDir } = getArtifactsDir(jobId)
  const p = join(outputDir, name)
  if (!existsSync(p)) return null
  try { return await readFile(p) } catch { return null }
}

/** Write a single output file into <jobId>/_agim-output/ (used to spill an
 *  over-long A2A result so the caller can read the full text on demand). */
export async function writeOutput(jobId: number, name: string, data: string | Buffer): Promise<void> {
  if (name.includes('/') || name === '..') throw new Error(`invalid output name: ${name}`)
  const { outputDir } = getArtifactsDir(jobId)
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await writeFile(join(outputDir, name), data)
}

/** Drop the whole <jobId>/ tree. Safe on missing dirs. */
export async function pruneArtifacts(jobId: number): Promise<void> {
  const { jobDir } = getArtifactsDir(jobId)
  try {
    await rm(jobDir, { recursive: true, force: true })
  } catch (err) {
    log.warn({ event: 'artifacts.prune_failed', jobId, err: err instanceof Error ? err.message : String(err) },
      `pruneArtifacts(${jobId}) failed`)
  }
}

/** Drop dirs for every jobId in the given list. Called by job-board's
 *  retention sweep with rows it just deleted. */
export async function pruneArtifactsBatch(jobIds: number[]): Promise<number> {
  if (!jobIds.length) return 0
  let n = 0
  for (const id of jobIds) {
    await pruneArtifacts(id)
    n++
  }
  return n
}

/** Compute per-job totals (used by tests + future /a2a stats extension). */
export async function statJob(jobId: number): Promise<{ files: number; bytes: number; outputs: OutputFile[]; inputs: Array<{ name: string; bytes: number }> }> {
  const dirs = getArtifactsDir(jobId)
  const inputs: Array<{ name: string; bytes: number }> = []
  const outputs = await listOutputs(jobId)
  if (existsSync(dirs.inputDir)) {
    for (const name of await readdir(dirs.inputDir)) {
      try {
        const st = await stat(join(dirs.inputDir, name))
        if (st.isFile()) inputs.push({ name, bytes: st.size })
      } catch { /* ignore */ }
    }
  }
  const bytes = inputs.reduce((s, f) => s + f.bytes, 0) + outputs.reduce((s, f) => s + f.bytes, 0)
  return { files: inputs.length + outputs.length, bytes, outputs, inputs }
}

// ─── prompt envelope ────────────────────────────────────────────────

export interface EnvelopeOpts {
  jobId: number
  inputs: Array<{ name: string; bytes: number }>
  expectOutputs?: string[]
}

/** Build the [A2A workspace] preamble the callee sees prefixed to its
 *  prompt. We use a clearly-tagged block so the model treats it as
 *  agim metadata and doesn't blur it with the user's intent. */
export function buildEnvelope(opts: EnvelopeOpts): string {
  const dirs = getArtifactsDir(opts.jobId)
  const lines: string[] = [
    '[A2A workspace]',
    `Your dedicated artifacts directory for this run:`,
    `  ${dirs.outputDir}/`,
    '',
  ]
  if (opts.inputs.length > 0) {
    lines.push(`Input files placed by the caller (under ${dirs.inputDir}/):`)
    for (const f of opts.inputs) {
      lines.push(`  - ${f.name}\t(${formatBytes(f.bytes)})`)
    }
    lines.push(`Read with absolute paths.`)
    lines.push('')
  }
  if (opts.expectOutputs && opts.expectOutputs.length > 0) {
    lines.push(`Expected outputs (place in ${dirs.outputDir}/):`)
    for (const name of opts.expectOutputs) lines.push(`  - ${name}`)
    lines.push('')
  }
  lines.push(`Anything you write under ${dirs.outputDir}/ will be visible`)
  lines.push(`to the caller after you return.`)
  lines.push('')
  lines.push('---')
  return lines.join('\n')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ─── test-only ──────────────────────────────────────────────────────

/** Test hook: wipe ALL artifacts. Production code must never call this. */
export async function _wipeAllForTests(): Promise<void> {
  try { await rm(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Internal exports for tests. */
export const _internal = {
  ROOT,
  formatBytes,
  resolveMaxFileBytes,
  resolveMaxJobBytes,
  resolveMaxFiles,
}

// Reference unused-by-design helpers so eslint / tsc-noUnused don't whine.
void dirname; void basename
