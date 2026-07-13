// fs-dispatcher — filesystem + content-search tools for the native agent.
//
// Closes a major gap vs nanobot / Claude / Codex: native could read its
// own skill catalog and call sub-agents, but it had no `read_file` /
// `write_file` / `list_dir` / `glob` / `grep`. That forced every
// "look at this file" / "what's in this dir" request to fan out to a
// CLI sub-agent over A2A — slow, costly, and a 30-min hard timeout
// landmine (see the v1.2.56 crash-loop fix).
//
// By default all five tools have real filesystem access (so the native
// agent isn't crippled). Operators who want to confine access to the native
// agent's per-thread cwd subtree (typically ~/.agim-workspaces/native/
// <thread>/) set AGIM_NATIVE_FS_RESTRICT=1. Either way, the sensitive-
// paths.ts denylist always applies so ~/.agim/, /etc/shadow, etc. remain
// blocked.
//
// Tools shipped here:
//   * agim_read_file(path, max_bytes?)
//   * native_write_file(path, content, mode?)
//   * native_list_dir(path, max_entries?)
//   * native_glob(pattern, root?, max_results?)
//   * native_grep(pattern, path?, glob?, output_mode?, max_matches?, case_insensitive?)
//
// Per-tool wall-clock: each handler races against AGIM_NATIVE_FS_TIMEOUT_MS
// (default 60_000). Honors the loop AbortSignal too.

import { promises as fs, statSync } from 'node:fs'
import { resolve as resolvePath, isAbsolute, relative, sep, join as joinPath, delimiter as pathDelimiter } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { logger as rootLogger } from '../logger.js'
import { isSensitivePath } from '../sensitive-paths.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'

const log = rootLogger.child({ component: 'fs-dispatcher' })

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_READ_MAX_BYTES = 256 * 1024     // 256 KB
const DEFAULT_WRITE_MAX_BYTES = 1 * 1024 * 1024 // 1 MB
const DEFAULT_LIST_MAX_ENTRIES = 500
const DEFAULT_GLOB_MAX_RESULTS = 500
const DEFAULT_GREP_MAX_MATCHES = 200

const FS_TOOL_NAMES = [
  'agim_read_file',
  'agim_write_file',
  'agim_list_dir',
  'agim_glob',
  'agim_grep',
] as const

export function isFsToolName(name: string): boolean {
  return (FS_TOOL_NAMES as readonly string[]).includes(canonicalizeToolName(name))
}

export function getFsTools(): ToolDef[] {
  return [
    {
      name: 'agim_read_file',
      description:
        'Read a UTF-8 text file by path. Default max 256KB. Paths resolve against the agent cwd; ' +
        'absolute paths are allowed by default (set AGIM_NATIVE_FS_RESTRICT=1 to confine to the ' +
        'workspace subtree). Sensitive paths (~/.agim, /etc/shadow, etc.) are always denied.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to cwd).' },
          max_bytes: { type: 'number', description: 'Max bytes to read (default 262144).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_write_file',
      description:
        'Write or overwrite a UTF-8 text file. Default max 1MB. Same path-safety rules as ' +
        'agim_read_file. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          content: { type: 'string', description: 'Full file content (overwrites).' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite (default) or append.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_list_dir',
      description:
        'List entries in a directory. Returns up to 500 entries with type (file|dir|symlink|other) ' +
        'and byte size. Hidden entries (starting with .) included.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          max_entries: { type: 'number', description: 'Max entries returned (default 500).' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_glob',
      description:
        'Find files matching a glob pattern. Pattern syntax matches "**/*.ts", "src/**/*.{js,ts}", etc. ' +
        'Returned paths are relative to root (default: agent cwd).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern.' },
          root: { type: 'string', description: 'Root directory (default cwd).' },
          max_results: { type: 'number', description: 'Max paths returned (default 500).' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_grep',
      description:
        'Search file contents with a regex. Uses ripgrep when available, falls back to a fs walk. ' +
        'output_mode: "content" returns matching lines, "files" returns matching file paths, ' +
        '"count" returns per-file counts. Default "content".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern.' },
          path: { type: 'string', description: 'File or directory to search (default cwd).' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts".' },
          output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
          max_matches: { type: 'number', description: 'Max match lines (default 200).' },
          case_insensitive: { type: 'boolean' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  ]
}

export interface FsContext {
  cwd: string
}

export function buildFsDispatcher(ctx: FsContext): ToolDispatcher {
  return async (call, signal): Promise<DispatcherResult> => {
    if (!isFsToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    const toolName = canonicalizeToolName(call.name)
    const timeoutMs = resolveTimeoutMs()
    try {
      return await raceTimeout(
        runOne(toolName, call.arguments, ctx, signal),
        timeoutMs,
        toolName,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'fs.tool.error', tool: toolName, err: msg })
      return { text: `${toolName} failed: ${msg}`, isError: true, source: 'fs' }
    }
  }
}

async function runOne(
  name: string,
  args: Record<string, unknown>,
  ctx: FsContext,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  switch (name) {
    case 'agim_read_file': return runReadFile(args, ctx)
    case 'agim_write_file': return runWriteFile(args, ctx)
    case 'agim_list_dir': return runListDir(args, ctx)
    case 'agim_glob': return runGlob(args, ctx, signal)
    case 'agim_grep': return runGrep(args, ctx, signal)
    default:
      return { text: `unknown fs tool: ${name}`, isError: true, source: 'fs' }
  }
}

// ─── path safety ─────────────────────────────────────────────────────

/** Workspace restriction is OPT-IN (default off, so native agents have real
 *  filesystem access). Operators set AGIM_NATIVE_FS_RESTRICT=1 to confine
 *  access to the cwd subtree; sensitive-paths.ts always applies regardless. */
function workspaceRestricted(): boolean {
  return process.env.AGIM_NATIVE_FS_RESTRICT === '1'
}

interface ResolvedPath {
  abs: string
  ok: boolean
  reason?: string
}

async function resolveAndCheck(input: unknown, ctx: FsContext): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.length === 0) {
    return { abs: '', ok: false, reason: 'path must be a non-empty string' }
  }
  let raw = input
  if (raw === '~') raw = homedir()
  else if (raw.startsWith('~/')) raw = homedir() + raw.slice(1)
  const abs = isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw)
  const sens = isSensitivePath(abs, { cwd: ctx.cwd })
  if (sens.sensitive) return { abs, ok: false, reason: `sensitive path: ${sens.reason}` }
  if (workspaceRestricted()) {
    const rel = relative(ctx.cwd, abs)
    if (rel.startsWith('..') || (rel.length > 0 && isAbsolute(rel))) {
      return {
        abs,
        ok: false,
        reason:
          `path "${abs}" is outside workspace "${ctx.cwd}". ` +
          'Unset AGIM_NATIVE_FS_RESTRICT (or set =0) to allow broader access.',
      }
    }
  }
  // v1.2.70 — CR-1: realpath guard against symlink escape. Lexical
  // checks alone don't see symlinks that point outside the workspace
  // or at sensitive paths (e.g. a symlink "evil" → "/etc/shadow"
  // dropped inside the agent cwd). Re-run sensitive + workspace
  // checks against the resolved real path. Non-existent paths have
  // no symlink to follow yet, so realpath ENOENT falls back to
  // resolving the parent (which catches the "directory itself is a
  // symlink" case) or leaves abs as-is.
  const real = await realpathSoft(abs)
  if (real !== abs) {
    const sensReal = isSensitivePath(real, { cwd: ctx.cwd })
    if (sensReal.sensitive) {
      return { abs: real, ok: false, reason: `sensitive path (via symlink): ${sensReal.reason}` }
    }
    if (workspaceRestricted()) {
      const relReal = relative(ctx.cwd, real)
      if (relReal.startsWith('..') || (relReal.length > 0 && isAbsolute(relReal))) {
        return {
          abs: real,
          ok: false,
          reason:
            `symlink target "${real}" is outside workspace "${ctx.cwd}". ` +
            'Unset AGIM_NATIVE_FS_RESTRICT (or set =0) to allow broader access.',
        }
      }
    }
  }
  return { abs, ok: true }
}

/** Resolve symlinks in `abs`. If the path itself doesn't exist
 *  (ENOENT — typical for write_file targeting a new file), resolve
 *  the parent and rejoin with the basename. If the parent also
 *  doesn't exist, return `abs` verbatim — there's no symlink to
 *  follow yet, so lexical checks already cover us. */
async function realpathSoft(abs: string): Promise<string> {
  try {
    return await fs.realpath(abs)
  } catch {
    const lastSep = abs.lastIndexOf(sep)
    if (lastSep <= 0) return abs
    const parent = abs.slice(0, lastSep)
    const name = abs.slice(lastSep + 1)
    try {
      const realParent = await fs.realpath(parent)
      return resolvePath(realParent, name)
    } catch {
      return abs
    }
  }
}

// ─── tools ───────────────────────────────────────────────────────────

async function runReadFile(args: Record<string, unknown>, ctx: FsContext): Promise<DispatcherResult> {
  const p = await resolveAndCheck(args.path, ctx)
  if (!p.ok) return { text: p.reason ?? 'invalid path', isError: true, source: 'fs' }
  const maxBytes = clampNumber(args.max_bytes, DEFAULT_READ_MAX_BYTES, 1, 8 * 1024 * 1024)
  try {
    const st = await fs.stat(p.abs)
    if (!st.isFile()) return { text: `not a file: ${p.abs}`, isError: true, source: 'fs' }
    if (st.size > maxBytes) {
      const head = await fs.open(p.abs, 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const { bytesRead } = await head.read(buf, 0, maxBytes, 0)
        return {
          text: `[truncated: file is ${st.size} bytes, read first ${bytesRead}]\n${buf.subarray(0, bytesRead).toString('utf-8')}`,
          isError: false,
          source: 'fs',
        }
      } finally {
        await head.close()
      }
    }
    const data = await fs.readFile(p.abs, 'utf-8')
    return { text: data, isError: false, source: 'fs' }
  } catch (err) {
    return { text: `read_file failed: ${errMsg(err)}`, isError: true, source: 'fs' }
  }
}

async function runWriteFile(args: Record<string, unknown>, ctx: FsContext): Promise<DispatcherResult> {
  const p = await resolveAndCheck(args.path, ctx)
  if (!p.ok) return { text: p.reason ?? 'invalid path', isError: true, source: 'fs' }
  const content = typeof args.content === 'string' ? args.content : ''
  if (Buffer.byteLength(content, 'utf-8') > DEFAULT_WRITE_MAX_BYTES) {
    return {
      text: `write_file refused: content > ${DEFAULT_WRITE_MAX_BYTES} bytes`,
      isError: true,
      source: 'fs',
    }
  }
  const mode = args.mode === 'append' ? 'append' : 'overwrite'
  try {
    const parent = p.abs.includes(sep) ? p.abs.slice(0, p.abs.lastIndexOf(sep)) : '.'
    await fs.mkdir(parent, { recursive: true })
    if (mode === 'append') await fs.appendFile(p.abs, content, 'utf-8')
    else await fs.writeFile(p.abs, content, 'utf-8')
    const after = await fs.stat(p.abs)
    return {
      text: `wrote ${after.size} bytes to ${p.abs} (${mode})`,
      isError: false,
      source: 'fs',
    }
  } catch (err) {
    return { text: `write_file failed: ${errMsg(err)}`, isError: true, source: 'fs' }
  }
}

async function runListDir(args: Record<string, unknown>, ctx: FsContext): Promise<DispatcherResult> {
  const p = await resolveAndCheck(args.path, ctx)
  if (!p.ok) return { text: p.reason ?? 'invalid path', isError: true, source: 'fs' }
  const maxEntries = clampNumber(args.max_entries, DEFAULT_LIST_MAX_ENTRIES, 1, 5000)
  try {
    const entries = await fs.readdir(p.abs, { withFileTypes: true })
    const rows: Array<{ name: string; type: string; size?: number }> = []
    for (const e of entries.slice(0, maxEntries)) {
      const type = e.isDirectory() ? 'dir'
        : e.isFile() ? 'file'
        : e.isSymbolicLink() ? 'symlink'
        : 'other'
      let size: number | undefined
      if (type === 'file') {
        try { size = (await fs.stat(resolvePath(p.abs, e.name))).size } catch { /* ignore */ }
      }
      rows.push({ name: e.name, type, ...(size !== undefined ? { size } : {}) })
    }
    const truncated = entries.length > maxEntries
    return {
      text: JSON.stringify({ path: p.abs, total: entries.length, returned: rows.length, truncated, entries: rows }, null, 2),
      isError: false,
      source: 'fs',
    }
  } catch (err) {
    return { text: `list_dir failed: ${errMsg(err)}`, isError: true, source: 'fs' }
  }
}

async function runGlob(args: Record<string, unknown>, ctx: FsContext, signal: AbortSignal): Promise<DispatcherResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (!pattern) return { text: 'pattern required', isError: true, source: 'fs' }
  const rootInput = typeof args.root === 'string' ? args.root : '.'
  const p = await resolveAndCheck(rootInput, ctx)
  if (!p.ok) return { text: p.reason ?? 'invalid root', isError: true, source: 'fs' }
  const maxResults = clampNumber(args.max_results, DEFAULT_GLOB_MAX_RESULTS, 1, 5000)
  // Use ripgrep --files if available — it's faster + respects .gitignore.
  // Otherwise fall back to a recursive walk + minimatch-style suffix
  // matching (intentionally simple; agent can re-narrow with grep).
  try {
    const rgResult = await tryRipgrepFiles(p.abs, pattern, maxResults, signal)
    if (rgResult.ok) {
      return { text: rgResult.text, isError: false, source: 'fs' }
    }
    const fallback = await walkAndMatch(p.abs, pattern, maxResults, signal)
    return { text: fallback, isError: false, source: 'fs' }
  } catch (err) {
    return { text: `glob failed: ${errMsg(err)}`, isError: true, source: 'fs' }
  }
}

async function runGrep(args: Record<string, unknown>, ctx: FsContext, signal: AbortSignal): Promise<DispatcherResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (!pattern) return { text: 'pattern required', isError: true, source: 'fs' }
  const inputPath = typeof args.path === 'string' ? args.path : '.'
  const p = await resolveAndCheck(inputPath, ctx)
  if (!p.ok) return { text: p.reason ?? 'invalid path', isError: true, source: 'fs' }
  const glob = typeof args.glob === 'string' ? args.glob : undefined
  const mode = args.output_mode === 'files' || args.output_mode === 'count' ? args.output_mode : 'content'
  const maxMatches = clampNumber(args.max_matches, DEFAULT_GREP_MAX_MATCHES, 1, 2000)
  const ci = args.case_insensitive === true
  try {
    const r = await runRipgrepSearch(pattern, p.abs, { glob, mode, maxMatches, ci, signal })
    if (r.ok) return { text: r.text, isError: false, source: 'fs' }
    return { text: `grep failed: ${r.reason}`, isError: true, source: 'fs' }
  } catch (err) {
    return { text: `grep failed: ${errMsg(err)}`, isError: true, source: 'fs' }
  }
}

// ─── ripgrep wrappers ────────────────────────────────────────────────

async function tryRipgrepFiles(root: string, pattern: string, max: number, signal: AbortSignal):
  Promise<{ ok: boolean; text: string }> {
  if (!hasRipgrep()) return { ok: false, text: '' }
  const args = ['--files', '--glob', pattern, '--no-messages']
  try {
    const out = await runCmd('rg', args, { cwd: root, signal })
    if (out.exitCode !== 0 && out.stdout.length === 0) return { ok: false, text: out.stderr }
    const lines = out.stdout.split('\n').filter((l) => l.length > 0)
    const slice = lines.slice(0, max)
    return {
      ok: true,
      text: JSON.stringify({ root, count: lines.length, truncated: lines.length > max, files: slice }, null, 2),
    }
  } catch {
    return { ok: false, text: '' }
  }
}

interface GrepOpts {
  glob?: string
  mode: 'content' | 'files' | 'count'
  maxMatches: number
  ci: boolean
  signal: AbortSignal
}

async function runRipgrepSearch(pattern: string, path: string, opts: GrepOpts):
  Promise<{ ok: boolean; text: string; reason?: string }> {
  if (!hasRipgrep()) return { ok: false, text: '', reason: 'ripgrep not installed (only rg-based grep supported in v1.2.58)' }
  const args: string[] = ['--no-messages']
  if (opts.ci) args.push('-i')
  if (opts.glob) args.push('--glob', opts.glob)
  if (opts.mode === 'files') args.push('-l')
  if (opts.mode === 'count') args.push('-c')
  if (opts.mode === 'content') args.push('-n', `-m`, String(opts.maxMatches))
  args.push('--', pattern, path)
  const out = await runCmd('rg', args, { signal: opts.signal })
  if (out.exitCode !== 0 && out.exitCode !== 1) {
    return { ok: false, text: '', reason: out.stderr.trim() || `rg exit ${out.exitCode}` }
  }
  const lines = out.stdout.split('\n').filter((l) => l.length > 0)
  const slice = opts.mode === 'content' ? lines.slice(0, opts.maxMatches) : lines
  return {
    ok: true,
    text: JSON.stringify({
      pattern,
      path,
      mode: opts.mode,
      total: lines.length,
      truncated: opts.mode === 'content' && lines.length > opts.maxMatches,
      results: slice,
    }, null, 2),
  }
}

let _rgCheckCache: boolean | undefined
function hasRipgrep(): boolean {
  if (_rgCheckCache !== undefined) return _rgCheckCache
  // v1.3.7 (F11) — search the two common absolute locations AND every
  // directory on $PATH, rather than only the two hardcoded paths. A user
  // with `rg` in ~/.cargo/bin or /opt/homebrew/bin was previously told
  // "ripgrep not installed" and silently fell back to the slow walker.
  _rgCheckCache = rgIsOnDisk()
  return _rgCheckCache
}

function rgIsOnDisk(): boolean {
  for (const p of ['/usr/bin/rg', '/usr/local/bin/rg']) {
    try { statSync(p); return true } catch { /* keep looking */ }
  }
  const pathEnv = process.env.PATH
  if (!pathEnv) return false
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue
    try { statSync(joinPath(dir, 'rg')); return true } catch { /* keep looking */ }
  }
  return false
}

/** Test seam: clear the ripgrep-presence cache so a test can re-probe
 *  after changing $PATH. Not used in production paths. */
export function __resetRipgrepCacheForTesting(): void {
  _rgCheckCache = undefined
}

interface CmdResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runCmd(bin: string, args: string[], opts: { cwd?: string; signal: AbortSignal }): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, signal: opts.signal as AbortSignal })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
    child.on('error', (err) => resolve({ exitCode: -1, stdout, stderr: err.message }))
  })
}

// ─── fallback glob (no rg) ───────────────────────────────────────────

async function walkAndMatch(root: string, pattern: string, max: number, signal: AbortSignal): Promise<string> {
  const matcher = simpleGlobToRegex(pattern)
  const out: string[] = []
  const queue: string[] = [root]
  while (queue.length > 0 && out.length < max) {
    if (signal.aborted) break
    const dir = queue.shift()
    if (!dir) break
    let entries: import('node:fs').Dirent[] = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = resolvePath(dir, e.name)
      const rel = relative(root, full)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        queue.push(full)
      } else if (e.isFile() && matcher.test(rel)) {
        out.push(rel)
        if (out.length >= max) break
      }
    }
  }
  return JSON.stringify({ root, count: out.length, truncated: out.length >= max, files: out }, null, 2)
}

function simpleGlobToRegex(pattern: string): RegExp {
  // Tiny glob→regex matching fast-glob / minimatch behavior closely
  // enough for typical patterns:
  //   "**/"   → (?:.*/)?    (zero or more dirs incl. root)
  //   "**"    → .*
  //   "*"     → [^/]*
  //   "?"     → .
  //   everything else literal
  //
  // CRITICAL: the glob `?` → regex `.` replacement must happen BEFORE
  // we insert any regex construct that contains a literal `?` (e.g.
  // `(?:.*/)?`). Otherwise the inserted `?` gets clobbered. Same for
  // `*` — escape glob wildcards into placeholders first, then expand
  // the placeholders last.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*\*\//g, '__DBSTAR_SLASH__')
    .replace(/\*\*/g, '__DBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DBSTAR_SLASH__/g, '(?:.*/)?')
    .replace(/__DBSTAR__/g, '.*')
  return new RegExp(`^${escaped}$`)
}

// ─── helpers ─────────────────────────────────────────────────────────

function resolveTimeoutMs(): number {
  const raw = process.env.AGIM_NATIVE_FS_TIMEOUT_MS
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0 && n <= 600_000) return n
  }
  return DEFAULT_TIMEOUT_MS
}

async function raceTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function clampNumber(input: unknown, dflt: number, min: number, max: number): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
