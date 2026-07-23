import { dirname } from 'node:path'

/** Fallback prefix length for tools without a semantic key (Glob/Grep
 *  patterns, WebSearch queries, unknown tools). The mainline path uses
 *  per-tool semantic fingerprints — see inputFingerprint() — so this only
 *  governs the long tail. Kept at 10 for parity with the pre-semantic
 *  behavior. */
const AUTO_ALLOW_PREFIX_LEN = 10

export function autoAllowRuleKey(toolName: string, fingerprint: string): string {
  return `${toolName}::${fingerprint}`
}

/**
 * Translate a raw fingerprint string (e.g. `cmd:git+status`) into the
 * human-readable form shown in IM receipts and `/approval` listings
 * (e.g. `命令 git status`). The inverse of inputFingerprint()'s internal
 * encoding — keep the scheme list in sync if you add new fingerprint
 * variants.
 *
 * Unknown / legacy schemes pass through unchanged so the function is
 * forward-compatible with future fingerprint additions and backward-
 * compatible with rules created before the semantic split (no scheme).
 */
export function humanizeFingerprint(fingerprint: string): string {
  const sep = fingerprint.indexOf(':')
  if (sep < 0) return fingerprint
  const scheme = fingerprint.slice(0, sep)
  const rest = fingerprint.slice(sep + 1)
  switch (scheme) {
    case 'cmd':   return `命令 ${rest.replace(/\+/g, ' ')}`
    case 'dir':   return `目录 ${rest}`
    case 'host':  return `主机 ${rest}`
    case 'path':  return `路径 ${rest}`
    case 'pat':   return `模式 ${rest}`
    case 'query': return `查询 ${rest}`
    case 'url':   return `URL ${rest}`
    case 'raw':   return `入参 ${rest}`
    default:      return fingerprint
  }
}

/**
 * Compute the auto-allow fingerprint — the "kind" of call that, when
 * approved with `all`, covers future similar calls.
 *
 * Semantic per tool (rather than a uniform prefix slice) — fixes two
 * footguns of the old prefix-based approach:
 *   1. `Bash git status` and `git stash` collided at 5 chars but split at
 *      10 — neither setting matched user intuition. We extract the first
 *      two tokens (`cmd:git+status` vs `cmd:git+stash`) so the family is
 *      narrow and predictable.
 *   2. `Read /tmp/a.txt` and `Read /tmp/b.txt` got distinct fingerprints
 *      at any prefix length below the filename, forcing users to re-`all`
 *      every file. We key on dirname (`dir:/tmp`) so one approval covers
 *      the whole directory.
 *
 * Prefixes (`cmd:` / `dir:` / `host:` / `path:` / `pat:` / `query:` /
 * `url:` / `raw:`) keep the key space disambiguated — rules from
 * different schemes can never accidentally alias each other, and `raw:`
 * preserves backward compatibility for unknown tools.
 *
 * EXPORTED for unit tests. Not part of the bus's public API; production
 * call sites all live inside this module.
 */
export function inputFingerprint(toolName: string, input: Record<string, unknown>): string {
  const getStr = (k: string): string | null => {
    const v = input[k]
    return typeof v === 'string' && v.length > 0 ? v : null
  }

  switch (toolName) {
    case 'Bash':
    case 'agim_exec': {
      const cmd = getStr('command')
      if (!cmd) break
      // First 1–2 whitespace-separated tokens. Quoted strings aren't
      // unwrapped — we want `bash -c "..."` to fingerprint as `bash+-c`,
      // not whatever's inside the quotes (the user is approving "running
      // bash -c", a meta-pattern). Same scheme for agim_exec so
      // "Auto for similar" groups by command family (e.g. `cmd:curl+-s`).
      const tokens = cmd.trim().split(/\s+/).slice(0, 2)
      return `cmd:${tokens.join('+')}`
    }

    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
    case 'NotebookRead': case 'LS': {
      const fp = getStr('file_path') ?? getStr('path')
      if (!fp) break
      // dirname('/tmp/x.txt') → '/tmp'  (group all files in dir)
      // dirname('file.txt')   → '.'     (no dir — fall back to the path
      //                                  itself so we don't lump every
      //                                  relative-path call together)
      const d = dirname(fp)
      return d === '.' || d === '' ? `path:${fp.slice(0, AUTO_ALLOW_PREFIX_LEN)}` : `dir:${d}`
    }

    case 'WebFetch': {
      const u = getStr('url')
      if (!u) break
      // Hostname captures "calls to this API"; path / query string are
      // intentionally dropped — they vary per call but the user means
      // "trust this host" when they say `all`.
      try { return `host:${new URL(u).hostname}` }
      catch { return `url:${u.slice(0, AUTO_ALLOW_PREFIX_LEN)}` }
    }

    case 'WebSearch': {
      const q = getStr('query')
      if (!q) break
      return `query:${q.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
    }

    case 'Glob': case 'Grep': {
      const p = getStr('pattern')
      if (!p) break
      return `pat:${p.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
    }
  }

  // Unknown tool or known tool whose primary field was missing — fall
  // back to a stringified prefix so the dedup key remains stable.
  let s: string
  try { s = JSON.stringify(input) } catch { s = '' }
  return `raw:${s.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
}
