// workspace-files-api — Agent workspace file browser + inline edit.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   GET /api/workspace-files   → list dir or read file — any authenticated peer
//   PUT /api/workspace-files   → write file content    — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, stat, readFile, writeFile, rename, unlink, realpath, open } from 'node:fs/promises'
import { resolve as resolvePath, sep as pathSep, relative as relativePath, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registry } from '../core/registry.js'
import { readBody, sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'

/** Hard cap on file content we'll ship over the wire. */
const WORKSPACE_FILE_MAX_BYTES = 1 * 1024 * 1024
/** Bytes scanned for a binary heuristic. Null byte in this window → binary. */
const BINARY_PROBE_BYTES = 8 * 1024

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleWorkspaceFilesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/workspace-files' && m === 'GET') {
    await handleWorkspaceFiles(req, res, url); return true
  }
  if (p === '/api/workspace-files' && m === 'PUT') {
    if (!requireAdmin(req, res)) return true
    await handleWorkspaceFileWrite(req, res, url); return true
  }
  return false
}

/**
 * Resolve a user-supplied path under a workspace base and verify that the
 * *real* filesystem path (after symlink resolution) still lives under `base`.
 * Returns the validated real path, or null + sends an error response.
 */
export async function validateWorkspacePath(
  base: string,
  userPath: string,
  res: ServerResponse,
): Promise<string | null> {
  const target = resolvePath(base, userPath)
  if (target !== base && !target.startsWith(base + pathSep)) {
    sendJson(res, 400, { error: 'Path escapes workspace root' })
    return null
  }
  let real: string
  try {
    real = await realpath(target)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Not found', path: relativePath(base, target) })
      return null
    }
    throw err
  }
  const realBase = await realpath(base)
  if (real !== realBase && !real.startsWith(realBase + pathSep)) {
    sendJson(res, 403, { error: 'Path resolves outside workspace root (symlink escape)' })
    return null
  }
  return real
}

async function handleWorkspaceFiles(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const agent = url.searchParams.get('agent') || ''
    const userPath = url.searchParams.get('path') || ''

    if (!agent) {
      sendJson(res, 400, { error: 'Missing required ?agent=' })
      return
    }
    const known = new Set(registry.listAgents())
    if (!known.has(agent)) {
      sendJson(res, 404, { error: `Unknown agent "${agent}"` })
      return
    }

    const { defaultAgentCwd } = await import('../core/agent-cwd.js')
    const base = resolvePath(defaultAgentCwd(agent))
    const target = await validateWorkspacePath(base, userPath, res)
    if (!target) return

    const st = await stat(target)

    if (st.isDirectory()) {
      const realBase = await realpath(base)
      const names = await readdir(target)
      const entries = await Promise.all(names.map(async (name) => {
        try {
          const childPath = `${target}/${name}`
          let childReal: string
          try {
            childReal = await realpath(childPath)
          } catch {
            return { name, isDir: false, size: null, mtime: null, broken: true }
          }
          if (childReal !== realBase && !childReal.startsWith(realBase + pathSep)) {
            return { name, isDir: false, size: null, mtime: null, symlink_escape: true }
          }
          const sub = await stat(childPath)
          return {
            name,
            isDir: sub.isDirectory(),
            size: sub.isDirectory() ? null : sub.size,
            mtime: sub.mtime.toISOString(),
          }
        } catch {
          return { name, isDir: false, size: null, mtime: null, broken: true }
        }
      }))
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      sendJson(res, 200, {
        type: 'dir',
        agent,
        path: relativePath(base, target),
        base,
        entries,
      })
      return
    }

    if (!st.isFile()) {
      sendJson(res, 400, { error: 'Not a regular file' })
      return
    }

    const truncated = st.size > WORKSPACE_FILE_MAX_BYTES
    let buf: Buffer
    if (truncated) {
      const fd = await open(target, 'r')
      try {
        buf = Buffer.alloc(WORKSPACE_FILE_MAX_BYTES)
        const { bytesRead } = await fd.read(buf, 0, WORKSPACE_FILE_MAX_BYTES, 0)
        buf = buf.subarray(0, bytesRead)
      } finally {
        await fd.close()
      }
    } else {
      buf = await readFile(target)
    }
    const probe = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES))
    const isBinary = probe.includes(0)
    sendJson(res, 200, {
      type: 'file',
      agent,
      path: relativePath(base, target),
      size: st.size,
      mtime: st.mtime.toISOString(),
      encoding: isBinary ? 'base64' : 'utf-8',
      content: isBinary ? buf.toString('base64') : buf.toString('utf-8'),
      truncated,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleWorkspaceFileWrite(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const agent = url.searchParams.get('agent') || ''
    const userPath = url.searchParams.get('path') || ''

    if (!agent) {
      sendJson(res, 400, { error: 'Missing required ?agent=' })
      return
    }
    if (!userPath) {
      sendJson(res, 400, { error: 'Missing required ?path=' })
      return
    }
    const known = new Set(registry.listAgents())
    if (!known.has(agent)) {
      sendJson(res, 404, { error: `Unknown agent "${agent}"` })
      return
    }

    const { defaultAgentCwd } = await import('../core/agent-cwd.js')
    const base = resolvePath(defaultAgentCwd(agent))

    const logicalTarget = resolvePath(base, userPath)
    if (logicalTarget !== base && !logicalTarget.startsWith(base + pathSep)) {
      sendJson(res, 400, { error: 'Path escapes workspace root' })
      return
    }
    if (logicalTarget === base) {
      sendJson(res, 400, { error: 'Cannot overwrite workspace root' })
      return
    }
    const parentDir = dirname(logicalTarget)
    try {
      const realParent = await realpath(parentDir)
      const realBase = await realpath(base)
      if (realParent !== realBase && !realParent.startsWith(realBase + pathSep)) {
        sendJson(res, 403, { error: 'Parent path resolves outside workspace root (symlink escape)' })
        return
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        sendJson(res, 400, { error: 'Parent directory does not exist' })
        return
      }
      throw err
    }
    try {
      const realTarget = await realpath(logicalTarget)
      const realBase = await realpath(base)
      if (realTarget !== realBase && !realTarget.startsWith(realBase + pathSep)) {
        sendJson(res, 403, { error: 'Path resolves outside workspace root (symlink escape)' })
        return
      }
    } catch {
      // ENOENT is fine — the file doesn't exist yet
    }
    const target = logicalTarget

    const body = await readBody(req, res)
    let parsed: { content?: unknown }
    try { parsed = JSON.parse(body) as typeof parsed } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    if (typeof parsed.content !== 'string') {
      sendJson(res, 400, { error: 'content must be a string' })
      return
    }
    const content = parsed.content
    const buf = Buffer.from(content, 'utf-8')
    if (buf.length > WORKSPACE_FILE_MAX_BYTES) {
      sendJson(res, 413, { error: 'Content exceeds 1 MiB cap' })
      return
    }
    if (buf.includes(0)) {
      sendJson(res, 400, { error: 'NUL byte in content — only UTF-8 text accepted' })
      return
    }

    try {
      const st = await stat(target)
      if (st.isDirectory()) {
        sendJson(res, 400, { error: 'Target is a directory' })
        return
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
      const parent = dirname(target)
      try {
        const ps = await stat(parent)
        if (!ps.isDirectory()) {
          sendJson(res, 400, { error: 'Parent path is not a directory' })
          return
        }
      } catch {
        sendJson(res, 400, { error: 'Parent directory does not exist' })
        return
      }
    }

    const tmp = `${target}.tmp.${randomBytes(6).toString('hex')}`
    try {
      await writeFile(tmp, buf, { mode: 0o600 })
      await rename(tmp, target)
    } catch (err) {
      try { await unlink(tmp) } catch { /* tmp may not have been created */ }
      throw err
    }

    const finalSt = await stat(target)
    const savedPath = relativePath(base, target)
    if (savedPath === 'MEMORY.md') {
      try {
        const { ensureAgentMemoryLink } = await import('../core/agent-cwd.js')
        await ensureAgentMemoryLink(agent)
      } catch { /* best-effort: memory file itself was saved successfully */ }
    }
    sendJson(res, 200, {
      ok: true,
      agent,
      path: savedPath,
      size: finalSt.size,
      mtime: finalSt.mtime.toISOString(),
    })
  } catch (err) {
    const e = err as Error & { handled?: boolean; statusCode?: number }
    if (e?.handled) return
    if (!res.headersSent) sendJson(res, e?.statusCode || 500, { error: e instanceof Error ? e.message : String(err) })
  }
}
