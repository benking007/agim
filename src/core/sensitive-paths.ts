// Sensitive-path & sensitive-output filters — R13 B1 / B5.
//
// Two complementary defenses against the "send me your AGENTS.md /
// ~/.agim/env content" exfiltration class:
//
//   1. checkSensitiveToolUse() — called BEFORE the approval bus's
//      readonly-auto-allow short-circuit. If the tool would access a
//      hard-denied path, we return `behavior: 'deny'` immediately —
//      no IM card, no operator opt-in. Defense against an operator
//      who would otherwise click "approve" without realizing the
//      output is about to land in a public IM channel.
//
//   2. scrubOutboundText() — called by outbox.enqueue() right before
//      the message goes to a messenger adapter. Catches the case
//      where an agent reads a sensitive file by some path the
//      denylist missed, or constructs a token from arithmetic ops on
//      its prompt context, and tries to dump it to chat anyway.
//
// Design principles:
//   * Allow-list of fields per tool — we only inspect known
//     path-bearing inputs. Unknown tools (mcp__* / third-party MCP
//     servers) fall through with no path check; their semantic
//     surface is unknown so we don't try to guess. Output scrubber
//     still applies.
//   * Bash gets a substring scan because parsing arbitrary shell is a
//     trap; false positives are preferable to false negatives for
//     security tooling.
//   * Both functions are side-effect-free (pure) — easy to unit-test.
//
// What stays user-controllable: nothing in this file. Compliance
// rationale — these blocks are non-negotiable, so the denylist is
// fixed in source. To add / remove an entry, the operator edits this
// file and rebuilds.

import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { resolve, isAbsolute, normalize, basename, dirname, join, sep } from 'node:path'

const HOME = homedir()

/**
 * Chat / IM uploads land under `…/media/` (default `~/.agim/media/web/<thread>/`).
 * That tree must stay readable by Agent tools — otherwise `[文件附件：…]` markers
 * are unusable. Secrets (env, tokens.json, …) remain under other `~/.agim/` paths
 * and stay denied.
 */
function mediaAllowRoots(): string[] {
  const roots = new Set<string>()
  roots.add(join(HOME, '.agim', 'media'))
  const homeOverride = process.env.AGIM_HOME?.trim()
  if (homeOverride) roots.add(join(homeOverride, 'media'))
  const mediaRoot = process.env.AGIM_MEDIA_ROOT?.trim()
  if (mediaRoot) roots.add(resolve(mediaRoot))
  return [...roots]
}

function isUnderDir(abs: string, root: string): boolean {
  const rootNorm = normalize(root)
  const rootWithSep = rootNorm.endsWith(sep) ? rootNorm : `${rootNorm}${sep}`
  return abs === rootNorm || abs.startsWith(rootWithSep)
}

/** True when `abs` is under an allowed upload/media root (not other ~/.agim state). */
export function isAllowedAgimMediaPath(abs: string): boolean {
  if (typeof abs !== 'string' || !abs) return false
  for (const root of mediaAllowRoots()) {
    if (isUnderDir(abs, root)) return true
  }
  return false
}

/** `/proc/<pid|self|thread-self>/{root,cwd}/…` are symlinks into the real
 *  filesystem (root = the process's `/`), so they let an agent reach e.g.
 *  `~/.agim/tokens.json` via a path that doesn't start with the protected
 *  HOME prefix. Deny the indirection outright — there is no legitimate reason
 *  for an agent tool to address files through it. */
const PROC_INDIRECTION_RE = /^\/proc\/(?:self|thread-self|\d+)\/(?:root|cwd)(?:\/|$)/

/** Best-effort symlink resolution so the denylist can't be dodged by pointing
 *  a benign-looking path at a protected file. realpath the path; if it doesn't
 *  exist yet (e.g. a Write target), realpath its deepest existing ancestor and
 *  re-append the remainder so a symlinked parent dir is still resolved.
 *  Returns the input unchanged when nothing resolves. */
function resolveReal(abs: string): string {
  try {
    return realpathSync(abs)
  } catch {
    let dir = abs
    const tail: string[] = []
    for (let i = 0; i < 64; i += 1) {
      const parent = dirname(dir)
      if (parent === dir) break
      tail.unshift(basename(dir))
      dir = parent
      try {
        return normalize(join(realpathSync(dir), ...tail))
      } catch { /* ancestor still missing — keep walking up */ }
    }
    return abs
  }
}

/** Resolve a path argument to an absolute canonical form for matching.
 *  Handles `~/...` expansion + relative-to-cwd. Falls back to the
 *  literal string when input isn't a normal path (defensive — we still
 *  want a comparable string for the denylist check). */
function canonical(p: string, cwd?: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  let candidate = p
  if (p === '~') candidate = HOME
  else if (p.startsWith('~/')) candidate = HOME + p.slice(1)
  try {
    return normalize(isAbsolute(candidate) ? candidate : resolve(cwd || process.cwd(), candidate))
  } catch {
    return candidate
  }
}

/** Path patterns that must NEVER be read / written / touched by an
 *  agent tool — regardless of whether the operator would have
 *  approved the prompt. */
const SENSITIVE_ABS_PREFIXES: string[] = [
  // Operator's agim state — tokens, env, sockets
  `${HOME}/.agim/`,
  // SSH keys
  `${HOME}/.ssh/`,
  // Cloud / package credentials
  `${HOME}/.aws/`,
  `${HOME}/.gcp/`,
  `${HOME}/.azure/`,
  `${HOME}/.kube/`,
  `${HOME}/.docker/`,
  // System auth
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/',
  '/etc/ssh/',
  '/etc/ssl/private/',
  // /root/.ssh covered via HOME-relative prefix when running as root.
  // We intentionally do NOT blacklist all of /root/ — that would
  // make a root-owned agim install think every legit working path is
  // sensitive.
  // Process / kernel introspection — readable by uid but contents leak env
  '/proc/self/environ',
  '/proc/self/maps',
]

/** Per-file denials regardless of directory. Matches the basename
 *  (path tail). Use when the file is sensitive wherever it shows up
 *  in a project — e.g. .env in any repo, AGENTS.md anywhere. */
const SENSITIVE_BASENAMES: string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  // Project agent guides — these direct the agent itself; reading
  // them and dumping to IM is the prompt-injection persistence
  // vector flagged in B2. Blocked at B1 as a belt + suspenders for
  // the most obvious exfil path.
  'AGENTS.md',
  'CLAUDE.md',
  // Common credential files in arbitrary cwd
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  // Cloud / service-account credential files commonly named
  // `credentials.json` / `credentials.yaml` in GCP, AWS CLI exports,
  // Firebase, etc.
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
]

/** Sensitive command substrings for Bash. Cheap substring matching
 *  on the command string. False positives are OK (an agent that
 *  legitimately needs to `grep AGENTS.md` to navigate a project just
 *  has to ask the operator out-of-band) — false negatives are not. */
const SENSITIVE_BASH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Allow `…/.agim/media/…` (chat uploads); still block env/tokens/etc.
  { re: /(?:^|\s|\/)\.agim(?!\/media(?:\/|\s|$))(?:\/|\s|$)/i, reason: 'attempts to access ~/.agim/' },
  { re: /(?:^|\s|\/)tokens?\.json\b/i, reason: 'attempts to access tokens.json' },
  { re: /(?:^|\s|\/)admin-bootstrap-token\b/i, reason: 'attempts to access admin-bootstrap-token' },
  { re: /(?:^|\s|\/)acp-token\b/i, reason: 'attempts to access acp-token' },
  { re: /(?:^|\s|\/)\.env(?:\s|$|\.|:)/i, reason: 'attempts to access .env' },
  { re: /(?:^|\s)\/etc\/shadow\b/i, reason: 'attempts to access /etc/shadow' },
  { re: /(?:^|\s)\/etc\/sudoers\b/i, reason: 'attempts to access /etc/sudoers' },
  { re: /(?:^|\s|\/)\.ssh\//i, reason: 'attempts to access ~/.ssh/' },
  { re: /(?:^|\s|\/)id_(?:rsa|ed25519|ecdsa|dsa)\b/i, reason: 'attempts to access an SSH private key' },
  { re: /(?:^|\s|\/)AGENTS\.md\b/, reason: 'attempts to read AGENTS.md (use in-agent guidance, do not dump to IM)' },
  { re: /(?:^|\s|\/)CLAUDE\.md\b/, reason: 'attempts to read CLAUDE.md (use in-agent guidance, do not dump to IM)' },
  { re: /\/proc\/self\/environ\b/, reason: 'attempts to read process environ' },
  // Common reflection commands that leak env: `env`, `printenv`, `set`
  { re: /(?:^|[;&|]|\s)(?:env|printenv|set)\s*(?:$|[;&|>])/, reason: 'attempts to dump environment variables' },
  // Cloud / service-account credential files surface up via shell too.
  { re: /(?:^|\s|\/)credentials\.(?:json|ya?ml)\b/i, reason: 'attempts to access credentials.*' },
]

/** True iff `absPath` falls under a sensitive prefix or has a
 *  sensitive basename. */
export function isSensitivePath(p: string, opts?: { cwd?: string }): { sensitive: boolean; reason?: string } {
  const lit = canonical(p, opts?.cwd)
  // Block /proc/<pid>/{root,cwd} indirection regardless of whether the target
  // currently exists — it maps straight onto the real filesystem.
  if (PROC_INDIRECTION_RE.test(lit)) {
    return { sensitive: true, reason: 'path uses /proc/<pid>/{root,cwd} indirection into the real filesystem' }
  }
  // Match against BOTH the literal path and its symlink-resolved form so a
  // symlink pointing at a protected file (or a /proc/self/root/... path that
  // resolves into HOME) is caught even though its literal string looks benign.
  const real = resolveReal(lit)
  const candidates = real === lit ? [lit] : [lit, real]
  for (const abs of candidates) {
    // User-uploaded chat media (`~/.agim/media/…`) is intentionally outside
    // the ~/.agim denylist — agents must read `[文件附件：…]` / `[图片附件：…]`.
    if (isAllowedAgimMediaPath(abs)) {
      // Still apply basename denials (e.g. someone renaming upload to `.env`).
      if (SENSITIVE_BASENAMES.includes(basename(abs))) {
        return { sensitive: true, reason: `file basename "${basename(abs)}" is protected` }
      }
      continue
    }
    for (const prefix of SENSITIVE_ABS_PREFIXES) {
      if (abs === prefix.replace(/\/$/, '') || abs.startsWith(prefix)) {
        return { sensitive: true, reason: `path is under protected prefix ${prefix}` }
      }
    }
    if (SENSITIVE_BASENAMES.includes(basename(abs))) {
      return { sensitive: true, reason: `file basename "${basename(abs)}" is protected` }
    }
  }
  return { sensitive: false }
}

/** Decide whether a tool call should be hard-denied because it
 *  targets sensitive state. Returns `{deny: true, reason}` when so;
 *  otherwise `{deny: false}`. Caller (approval-bus) should still
 *  honour its normal flow on `deny: false` — this is a strict
 *  pre-filter, not a complete approval policy. */
export function checkSensitiveToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined,
): { deny: boolean; reason?: string } {
  if (!input || typeof input !== 'object') return { deny: false }

  // Tools that take a single file path. Read includes file_path (Anthropic
  // SDK convention) and path (some MCP servers); cover both.
  const pathTools: Record<string, string[]> = {
    Read:         ['file_path', 'path'],
    Edit:         ['file_path', 'path'],
    Write:        ['file_path', 'path'],
    NotebookRead: ['notebook_path', 'path'],
    NotebookEdit: ['notebook_path', 'path'],
    Glob:         ['path'],
    Grep:         ['path'],
    LS:           ['path'],
  }

  const fields = pathTools[toolName]
  if (fields) {
    for (const k of fields) {
      const v = (input as Record<string, unknown>)[k]
      if (typeof v === 'string') {
        const r = isSensitivePath(v)
        if (r.sensitive) {
          return { deny: true, reason: `tool=${toolName} blocked: ${r.reason}` }
        }
      }
    }
  }

  // Shell-style command scans. agim_exec (legacy: native_exec) uses the SAME
  // command-string shape as Bash, so it gets the same denylist — otherwise an
  // agent can dodge `Bash`'s sensitive-string guard simply by routing through
  // agim_exec (the case observed in v1.2.100 field testing where
  // `cat .../fin_data/.env; env | grep DB_` ran past auto-allow).
  // Multiple sub-commands across &&, ;, |, $(...) are all caught
  // because we scan the whole string.
  if (toolName === 'Bash' || toolName === 'native_exec' || toolName === 'agim_exec') {
    const cmd = (input as Record<string, unknown>).command
      ?? (input as Record<string, unknown>).cmd
    if (typeof cmd === 'string') {
      for (const { re, reason } of SENSITIVE_BASH_PATTERNS) {
        if (re.test(cmd)) {
          return { deny: true, reason: `tool=${toolName} blocked: ${reason}` }
        }
      }
    }
  }

  return { deny: false }
}

/** Patterns that look like a secret in arbitrary text. Replace each
 *  match with [REDACTED]. Tuned to common token prefixes — order
 *  doesn't matter since we run them all. */
const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
  // agim's own tokens
  { re: /agim_[a-f0-9]{40}/g,                                           name: 'agim_token' },
  // OpenAI / Anthropic / xAI etc.
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g,                                    name: 'openai_or_anthropic' },
  // GitHub PATs / fine-grained tokens
  { re: /\bgh[pousr]_[A-Za-z0-9_]{30,}/g,                               name: 'github_token' },
  // Slack
  { re: /\bxox[abopsr]-[A-Za-z0-9-]{10,}/g,                             name: 'slack_token' },
  // Google API key
  { re: /\bAIza[0-9A-Za-z\-_]{35}/g,                                    name: 'google_api_key' },
  // AWS access key id
  { re: /\b(?:AKIA|ASIA|AIDA|AGPA|ANPA|ANVA|AROA|AIPA)[0-9A-Z]{16}\b/g, name: 'aws_access_key_id' },
  // Telegram bot token: <bot-id>:<35-char>
  { re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,                            name: 'telegram_bot_token' },
  // Discord bot token (3 dotted base64-ish segments)
  { re: /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, name: 'discord_token' },
  // Generic PEM private keys
  { re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, name: 'pem_private_key' },
  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g,    name: 'jwt' },
]

export interface ScrubResult {
  text: string
  /** Sorted list of secret-pattern names that matched, deduplicated.
   *  Caller (outbox) can use this to emit a single audit event with
   *  the categories of redactions without disclosing the secrets. */
  redactedKinds: string[]
}

/** Replace every secret-shaped substring in `text` with [REDACTED-<name>].
 *  Idempotent (running twice produces the same output). */
export function scrubOutboundText(text: string): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', redactedKinds: [] }
  }
  let out = text
  const kinds = new Set<string>()
  for (const { re, name } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      kinds.add(name)
      return `[REDACTED-${name}]`
    })
  }
  return { text: out, redactedKinds: [...kinds].sort() }
}
