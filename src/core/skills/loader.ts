// skills/loader — agim-owned SKILL.md loader (Stage 3 / P0 #3).
//
// What a "skill" is, in agim:
//   - A directory containing exactly one `SKILL.md` file
//   - YAML-ish frontmatter with `name`, `description`, optional `always`
//     and `metadata.agim.requires.{bins,env}`
//   - A markdown body the agent reads on-demand (tier 2)
//   - Optional `scripts/` / `references/` / `assets/` subdirs the body
//     can refer to (tier 3)
//
// Three-tier progressive disclosure (modelled on nanobot):
//
//   tier 1: name + description, injected into every system prompt as a
//           "skills available" block. Cheap (~30-50 tokens per skill).
//   tier 2: full SKILL.md body, fetched on-demand via the
//           mcp__agim__read_skill MCP tool when the agent decides the
//           description matches the user's intent.
//   tier 3: any file inside scripts/ / references/ / assets/ — read
//           via the model's existing file-read tool when the body
//           references the path.
//
// Discovery scope (Stage 3 cut):
//
//   * `~/.agim/skills/<name>/SKILL.md` — operator-owned (highest priority)
//   * `<agim-dist>/skills/builtin/<name>/SKILL.md` — packaged with agim
//
// Name shadowing: workspace skills replace built-ins with the same name.
// This matches nanobot's behaviour and gives operators a clean override
// path without touching the install tree.
//
// Stage-3 limits:
//   - YAML parsing is intentionally minimal (regex-only). Skills using
//     fancy YAML features (nested objects beyond `metadata`, multi-line
//     strings without quotes) will fall back to a graceful "ignore that
//     field" instead of crashing. Real YAML lands when we hit a skill
//     that needs it.
//   - We do NOT discover skills inside the user's per-agent workspace
//     (`~/.agim-workspaces/<agent>/skills/`); those are managed by the
//     CLI agent itself (Claude Code et al). This loader is exclusively
//     for the agim-injected skills that ALL agents see.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger as rootLogger } from '../logger.js'
import { AGIM_HOME } from '../agim-paths.js'

const log = rootLogger.child({ component: 'skills-loader' })

/** Hard cap on the SKILL.md size we'll read. Skills longer than this
 *  almost always indicate a misconfigured doc dropped into the skills
 *  dir; we ignore the body to keep injection cheap and audit-able. */
export const MAX_SKILL_BODY_CHARS = 32_000

/** Tier-1 description hard cap. Long descriptions inflate the system
 *  prompt budget for every turn; truncate with "…" so the operator
 *  immediately notices when the cap was hit. */
export const MAX_DESCRIPTION_CHARS = 400

/** Maximum skills we'll inject into a single system prompt block.
 *  Above this, the agent is better served by a `/skill list` overview
 *  + on-demand `read_skill` than a wall of text. */
export const MAX_INJECTED_SKILLS = 32

export interface SkillMeta {
  name: string
  description: string
  /** Source: 'workspace' wins shadowing over 'builtin' with the same name. */
  source: 'workspace' | 'builtin'
  /** Absolute path of the skill's directory (parent of SKILL.md). */
  dir: string
  /** When true, the body is auto-injected after the tier-1 summary
   *  rather than waiting for a read_skill call. Use sparingly — every
   *  `always: true` skill burns tokens on every turn. */
  always: boolean
  /** Frontmatter `metadata.agim.requires.bins` declared dependencies
   *  (CLI executables in PATH). */
  requiresBins: string[]
  /** Frontmatter `metadata.agim.requires.env` declared dependencies
   *  (environment variables that must be non-empty). */
  requiresEnv: string[]
  /** True iff every `requires.bins` is on PATH AND every `requires.env`
   *  is non-empty. Unavailable skills are still listed (with a marker)
   *  so the agent can ask the operator to install the missing piece. */
  available: boolean
  /** Operator-facing reason when `available=false`. */
  unavailableReason?: string
  /** Frontmatter `origin:` value, when present. ECC pack skills declare
   *  `origin: ECC`; operators can use this to bucket / filter their own
   *  packs. Optional — most operator-authored skills omit it. */
  origin?: string
}

interface SkillDiscovered {
  name: string
  dir: string
  source: 'workspace' | 'builtin'
  /** Raw bytes of SKILL.md (already size-capped). */
  body: string
}

/** Cached scan result. Invalidated by `reload()` or env override. */
interface CacheEntry {
  scannedAt: number
  skills: SkillMeta[]
  /** Map by lowercased name for O(1) lookup in the read_skill RPC. */
  byName: Map<string, SkillMeta>
}

let cache: CacheEntry | null = null

/** Default cache TTL — skills don't change often, but we re-scan
 *  every 5 minutes so operators don't have to `/skill refresh` after
 *  dropping a new SKILL.md on disk. */
const CACHE_TTL_MS = 5 * 60 * 1000

/** Resolve the agim-owned workspace skills directory. This is the
 *  WRITE target: writeSkillFile / deleteSkill / the web editor all
 *  land files here regardless of what extra read-only roots are
 *  configured. Override via env for tests / custom deployments. */
function workspaceSkillsDir(): string {
  const override = process.env.AGIM_SKILLS_WORKSPACE_DIR
  if (override) return override
  return join(AGIM_HOME, 'skills')
}

export type SkillsMode = 'auto' | 'agim-only' | 'custom'

/** Resolve operator's skill discovery mode. See loadSkillsRoots(). */
function currentSkillsMode(): SkillsMode {
  const raw = (process.env.AGIM_SKILLS_MODE || 'auto').trim().toLowerCase()
  if (raw === 'agim-only' || raw === 'agim_only') return 'agim-only'
  if (raw === 'custom') return 'custom'
  return 'auto'
}

/** Helper: convert ~ to $HOME and resolve to absolute. */
function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return process.env.HOME || p
  if (p.startsWith('~/')) return join(process.env.HOME || '~', p.slice(2))
  return p
}

/** Parse a `:` or `,` separated list of paths from env, expanding ~. */
function parseRootsList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome)
}

/**
 * Resolve the ordered list of skill discovery roots (highest priority
 * first). The agim-owned `workspaceSkillsDir()` is ALWAYS at index 0
 * — it's the write target and must shadow same-named entries in
 * inherited roots so operator-installed skills can override defaults.
 *
 * Modes:
 *   - `auto`     (default): workspace + ~/.claude/skills + ~/.config/opencode/skills
 *                + ~/.codex/skills. Reflects the typical "I installed all three
 *                CLI agents and they share via symlink" layout — agim sees
 *                100+ shared skills out of the box without extra config.
 *                Honors AGIM_SKILLS_EXTRA_ROOTS for adding more.
 *   - `agim-only`: only the workspace dir. For deployments that want
 *                isolation from per-user CLI agent directories.
 *   - `custom`:   workspace + AGIM_SKILLS_ROOTS (explicit operator list).
 *
 * The builtin dir is NOT included here — it's tier-0 (bundled with agim)
 * and scanned separately as a last resort in doScan().
 */
export function resolveSkillsRoots(): string[] {
  const ws = workspaceSkillsDir()
  const mode = currentSkillsMode()
  const extra = parseRootsList(process.env.AGIM_SKILLS_EXTRA_ROOTS)
  if (mode === 'agim-only') return [ws]
  if (mode === 'custom') {
    const explicit = parseRootsList(process.env.AGIM_SKILLS_ROOTS)
    return Array.from(new Set([ws, ...explicit, ...extra]))
  }
  // auto: workspace + common CLI agent skill dirs (read-only inherit).
  const home = process.env.HOME || '/root'
  const autoExtras = [
    join(home, '.claude', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.codex', 'skills'),
  ]
  return Array.from(new Set([ws, ...autoExtras, ...extra]))
}

/** Public describe-only API for the web admin / diagnostics. Returns
 *  a snapshot of the active mode + the roots that will be scanned. */
export function describeSkillsConfig(): {
  mode: SkillsMode
  writeRoot: string
  readRoots: string[]
  builtinRoot: string
} {
  return {
    mode: currentSkillsMode(),
    writeRoot: workspaceSkillsDir(),
    readRoots: resolveSkillsRoots(),
    builtinRoot: builtinSkillsDir(),
  }
}

/** Resolve the bundled-builtin skills directory. We look next to the
 *  current module file (after build → dist/core/skills/) then walk up
 *  to find `skills/builtin`. Falls back to the src tree during dev. */
function builtinSkillsDir(): string {
  const override = process.env.AGIM_SKILLS_BUILTIN_DIR
  if (override) return override
  // import.meta.url works in both dev (tsx / bun) and built dist (esm).
  const thisDir = dirname(fileURLToPath(import.meta.url))
  // Most likely locations relative to this module:
  //   dev:   /workspace/src/core/skills/loader.ts → /workspace/src/core/skills/builtin
  //   built: /workspace/dist/core/skills/loader.js → /workspace/dist/core/skills/builtin
  const localCandidate = resolve(thisDir, 'builtin')
  if (existsSync(localCandidate)) return localCandidate
  // Fall back to repo root (rare; happens when tests resolve from /tmp).
  const repoCandidate = resolve(thisDir, '..', '..', '..', 'src', 'core', 'skills', 'builtin')
  if (existsSync(repoCandidate)) return repoCandidate
  return localCandidate  // path may not exist; that's fine — scan handles it
}

// ─── Public API ──────────────────────────────────────────────────────

/** Force a fresh disk scan on next call. Returned by /skill refresh. */
export function invalidateSkillsCache(): void {
  cache = null
}

/**
 * Write (create-or-overwrite) a workspace SKILL.md (P1 web editor).
 *
 *   - Lands at <workspaceSkillsDir>/<name>/SKILL.md (operator path,
 *     not builtin) so subsequent scans pick it up and it shadows any
 *     same-named builtin.
 *   - name is sanitized to safe filesystem chars (no '..', no
 *     leading dots, no slashes). Returns null on invalid name.
 *   - Body MUST already include the YAML frontmatter; we validate
 *     it parses + has a description before writing so the editor
 *     can't ship a broken SKILL.md. Returns the parsed SkillMeta
 *     on success.
 *   - Invalidates the cache so listSkills() picks up the new file
 *     on next call.
 */
export function writeSkillFile(name: string, body: string): SkillMeta | null {
  const safe = sanitizeSkillName(name)
  if (!safe) return null
  const probe = parseSkill({ name: safe, dir: '<probe>', source: 'workspace', body })
  if (!probe) return null
  if (body.length > MAX_SKILL_BODY_CHARS) {
    log.warn({ event: 'skills.write.too_long', name: safe, len: body.length })
    return null
  }
  const dir = join(workspaceSkillsDir(), safe)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8')
  } catch (err) {
    log.warn({ event: 'skills.write.failed', name: safe, err: String(err) })
    return null
  }
  invalidateSkillsCache()
  return getSkillByName(safe)
}

/**
 * Delete a workspace skill. Builtin (bundled) skills can't be
 * deleted — operators have to shadow them with a workspace entry
 * (which writeSkillFile does for them). Returns true iff a file
 * was actually unlinked.
 */
export function deleteSkill(name: string): boolean {
  const safe = sanitizeSkillName(name)
  if (!safe) return false
  const path = join(workspaceSkillsDir(), safe, 'SKILL.md')
  if (!existsSync(path)) return false
  try {
    rmSync(join(workspaceSkillsDir(), safe), { recursive: true, force: true })
  } catch (err) {
    log.warn({ event: 'skills.delete.failed', name: safe, err: String(err) })
    return false
  }
  invalidateSkillsCache()
  return true
}

/** Sanitize a skill name for filesystem use. */
function sanitizeSkillName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 64) return ''
  if (trimmed === '.' || trimmed === '..') return ''
  if (trimmed.startsWith('.')) return ''
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return ''
  return trimmed
}

/** Read-only access to the loaded skill list. Triggers a scan on first
 *  call or when the cache has expired. Never throws — disk errors yield
 *  the partial list discovered up to that point. */
export function listSkills(): SkillMeta[] {
  return ensureCache().skills
}

/** Look up one skill by name (case-insensitive). Returns null when
 *  unknown; caller decides whether to surface "no such skill" to the
 *  agent or the operator. */
export function getSkillByName(name: string): SkillMeta | null {
  return ensureCache().byName.get(name.toLowerCase()) ?? null
}

/** Read the full SKILL.md body for a known skill. Returns null on
 *  unknown name OR read failure. Honors the MAX_SKILL_BODY_CHARS cap;
 *  oversize files come back truncated with a `[truncated …]` footer. */
export function readSkillBody(name: string): string | null {
  const skill = getSkillByName(name)
  if (!skill) return null
  const path = join(skill.dir, 'SKILL.md')
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.length <= MAX_SKILL_BODY_CHARS) return raw
    return `${raw.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[truncated to ${MAX_SKILL_BODY_CHARS} chars by agim skills loader]`
  } catch (err) {
    log.warn({ event: 'skills.body_read_failed', name, err: String(err) })
    return null
  }
}

/**
 * Build the tier-1 system-prompt block. Injected once per turn by the
 * router. Returns '' when no skills are configured (router drops empty
 * blocks). Bounded to MAX_INJECTED_SKILLS rows; above the cap we keep
 * the first N alphabetically and append a one-line "+ N more (call
 * /skill list to see)" note.
 *
 * Format (kept close to nanobot's so models trained on its docs feel
 * at home):
 *
 *   [agim skills available — read full body with mcp__agim__read_skill(name)]
 *   - skill-a: one-line description
 *   - skill-b: one-line description (unavailable: missing bin `foo`)
 *   - skill-c: one-line description
 *   …
 */
/**
 * v1.2.149 — recommended ECC skills for the system-prompt injection
 * cap (priority bucket 2 below).
 *
 * Rationale: agim is a generic IM ↔ Agent bridge; the framework should
 * not assume the operator's business domain. So operator-authored
 * skills (workspace source) and the bundled ECC pack are NOT injected
 * by default — they're reachable via `mcp__agim__read_skill('name')`
 * when their description matches. But ECC ships 200+ skills covering
 * agent harness engineering and general-purpose dev methodology that
 * benefit every agim install; this list pins ~20 of those into the
 * default-32 injection so the agent has the harness vocabulary front
 * of mind without burying it under alphabet order.
 *
 * Selection: 11 agent-harness skills + 9 cross-language methodology
 * skills. Excludes framework / language / industry specialties and
 * ECC-internal tooling. (django / kotlin / healthcare / content-engine /
 * security-review packs were pruned from the shipped builtin set.)
 *
 * Add / remove freely — this is a curated list, not a registry.
 */
const ECC_TOP_PICKS_DEFAULT: ReadonlySet<string> = new Set([
  // Agent harness engineering (11)
  'agentic-engineering', 'agent-eval', 'agent-introspection-debugging',
  'agent-harness-construction', 'autonomous-agent-harness', 'autonomous-loops',
  'continuous-learning-v2', 'verification-loop', 'prompt-optimizer',
  'cost-aware-llm-pipeline', 'context-budget',
  // Cross-language methodology + content (9)
  'blueprint', 'coding-standards', 'architecture-decision-records',
  'backend-patterns', 'tdd-workflow', 'security-scan', 'benchmark',
  'article-writing', 'api-design',
])

/**
 * v1.2.151 — Resolve the active ECC top-pick set. Operators can override
 * via `AGIM_SKILLS_ECC_PICKS=name1,name2,...`. An empty or unset value
 * falls back to the default 20-name list. Validation is intentionally
 * forgiving: unknown names pass through (they just become no-ops when
 * the named skill isn't installed).
 */
export function resolveEccTopPicks(): ReadonlySet<string> {
  const raw = (process.env.AGIM_SKILLS_ECC_PICKS || '').trim()
  if (!raw) return ECC_TOP_PICKS_DEFAULT
  const names = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return ECC_TOP_PICKS_DEFAULT
  return new Set(names)
}

/**
 * v1.2.151 — ECC remainder injection policy. Default `on` emits the
 * cluster block. `off` suppresses it entirely (token-saving for ops
 * who only want the recommended picks). A comma-list value flips to
 * "allowlist" mode: only remainder skills in the list are emitted.
 */
type EccRemainderMode =
  | { mode: 'on' }
  | { mode: 'off' }
  | { mode: 'allowlist'; names: Set<string> }

export function resolveEccRemainderMode(): EccRemainderMode {
  const raw = (process.env.AGIM_SKILLS_INJECT_ECC_REMAINDER || '').trim().toLowerCase()
  if (!raw || raw === 'on' || raw === '1' || raw === 'true') return { mode: 'on' }
  if (raw === 'off' || raw === '0' || raw === 'false') return { mode: 'off' }
  // Anything else is treated as a comma/whitespace-separated allowlist.
  const names = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return { mode: 'on' }
  return { mode: 'allowlist', names: new Set(names) }
}

// ─── v1.2.151 — operator-tunable injection override ────────────────────
//
// Operators frequently want to nudge the auto-generated skills block —
// pin a specific skill higher, hide one that's noisy, add a routing
// hint about a custom env, etc. Rather than expanding the env-knob
// surface for every dimension, agim accepts a verbatim text file at
// `~/.agim/skill-injection-override.md` that REPLACES the auto block.
//
// When the file exists and is non-empty, buildSkillsSummary returns:
//   - the standard "[agim tool routing — skills first]" header
//   - the override file contents (verbatim, trimmed)
//   - the always-on skill bodies (unchanged)
//
// The auto-generated block (priority buckets + clusters) is suppressed.
// Tests and CI override the path via AGIM_SKILLS_INJECTION_OVERRIDE_PATH
// to avoid polluting the operator's real ~/.agim/.
//
// Editor entrypoint: the SPA page `/settings/skill-injection` calls
// admin endpoints to read auto + read/write/delete the override.

const INJECTION_OVERRIDE_FILENAME = 'skill-injection-override.md'

export function injectionOverridePath(): string {
  const override = process.env.AGIM_SKILLS_INJECTION_OVERRIDE_PATH
  if (override) return override
  return join(AGIM_HOME, INJECTION_OVERRIDE_FILENAME)
}

/** Read the override file. Returns the trimmed body, or null when the
 *  file is missing / empty / unreadable. Never throws. */
export function readInjectionOverride(): string | null {
  const path = injectionOverridePath()
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8').trim()
    return raw || null
  } catch (err) {
    log.warn({ event: 'skills.injection_override.read_failed', path, err: String(err) })
    return null
  }
}

/** Write (or replace) the override file. The caller is responsible for
 *  authorization — this is a thin filesystem helper. Returns true on
 *  success, false on any disk error. */
export function writeInjectionOverride(body: string): boolean {
  const path = injectionOverridePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body, 'utf-8')
    return true
  } catch (err) {
    log.warn({ event: 'skills.injection_override.write_failed', path, err: String(err) })
    return false
  }
}

/** Delete the override file. Returns true when a file was actually
 *  removed (or already gone), false on filesystem error. */
export function deleteInjectionOverride(): boolean {
  const path = injectionOverridePath()
  try {
    if (!existsSync(path)) return true
    rmSync(path, { force: true })
    return true
  } catch (err) {
    log.warn({ event: 'skills.injection_override.delete_failed', path, err: String(err) })
    return false
  }
}

/**
 * v1.2.149 — Rank a skill into one of four buckets for system-prompt
 * injection. Lower rank wins (fills the visible 32 first). Within a
 * bucket, alphabetical order. Buckets:
 *
 *   0 — agim framework skills (name starts with `agim-`). Always relevant
 *       to anyone running agim; should never miss the cap.
 *   1 — non-ECC builtin skills (the small in-tree agim pack: github,
 *       image-generation, long-goal, my, skill-creator, summarize, tmux,
 *       weather). Curated by us specifically for the framework.
 *   2 — ECC recommended (the curated list above). Pinned harness / dev
 *       methodology essentials from the ECC pack.
 *   3 — Everything else: ECC remainder (210+) and operator workspace
 *       skills (the operator's business domain — fin-data, ash, etc.).
 *       Reachable via read_skill on description match; not strapped to
 *       the front of the prompt.
 *
 * Workspace skills land in 3 rather than 1 because operator-authored
 * content varies wildly per install — pinning them all means a finance
 * operator's 60 fin-data skills push out an unrelated operator's 60
 * homelab skills. Both belong in the on-demand pool, not the cap.
 */
export function rankSkillBucket(s: SkillMeta): number {
  // v1.2.150 — refined buckets to support cluster-aware injection.
  //   0  agim-* framework skills (always visible, individual rows)
  //   1  non-ECC builtin (agim's own small pack)
  //   2  ECC top picks (recommended, individual rows)
  //   3  workspace skills (operator-installed business — clustered when many)
  //   4  ECC remainder (210 of them — always heavily clustered)
  if (s.name.startsWith('agim-')) return 0
  // Detect bundled ECC pack. ECC's own SKILL.md files use multiple
  // `origin:` values (`ECC`, `community`, `ECC direct-port adaptation`,
  // …) so frontmatter alone isn't reliable. The packaging script stamps
  // a `[ECC]` prefix on every imported description; that's the load-
  // bearing marker. We also honour any non-empty `origin` that begins
  // with `ECC` for forward compat (e.g. operator-authored skills tagged
  // `origin: ECC fork`). Order matters: prefix check comes first because
  // it's the actually-reliable signal.
  const isEcc = s.source === 'builtin'
    && (s.description.startsWith('[ECC] ') || /^ECC\b/i.test(s.origin ?? ''))
  if (isEcc) return resolveEccTopPicks().has(s.name) ? 2 : 4
  if (s.source === 'workspace') return 3
  // non-ECC builtin (agim's own small in-tree pack)
  return 1
}

/**
 * v1.2.150 — A prefix-based skill cluster. Many skills sharing a name
 * prefix (`fin-data-aspd-*`, `white-pig-*`, …) get collapsed into one
 * block: title + name list + brief trigger hint. The LLM still sees
 * every skill name, just not every full description; it can call
 * `read_skill('exact-name')` for granular content.
 */
export interface SkillCluster {
  /** The shared prefix, e.g. "fin-data-aspd" or "white-pig". */
  prefix: string
  /** Skill names in the cluster, alphabetically sorted. */
  names: string[]
  /** One-line trigger summary derived from member descriptions
   *  (best effort). Empty when descriptions are unhelpful. */
  triggerHint: string
}

/**
 * v1.2.150 — Pure helper: group `skills` into prefix-based clusters.
 *
 * Algorithm:
 *   1. Group by first dash-segment (`fin-data-aspd-*` → key `fin`).
 *   2. For groups of size ≥ minSize, try refining to TWO segments
 *      (`fin-data-*`). If at least 2 two-segment sub-groups themselves
 *      reach minSize, emit each sub-group as a cluster and the leftover
 *      single-segment-only members as a fallback `<seg1>-*` cluster.
 *   3. Sub-clustering attempts also at THREE segments before bottoming
 *      out, so `fin-data-aspd-*` peels off `fin-data-aspd` instead of
 *      drowning in a generic `fin-data`.
 *   4. Skills that don't land in any cluster (≤ minSize − 1 with their
 *      prefix peers) are returned as singletons; the caller renders
 *      them as individual rows.
 *
 * Pure / deterministic — same input always yields same output.
 */
export function clusterSkills(
  skills: ReadonlyArray<SkillMeta>,
  minSize = 3,
): { clusters: SkillCluster[]; singletons: SkillMeta[] } {
  const clusters: SkillCluster[] = []
  const used = new Set<string>()

  // Recursive refiner: attempt to peel deeper prefixes when the group is
  // large enough and has internal structure. Up to 3 segments deep.
  function refine(group: SkillMeta[], segDepth: number): void {
    if (group.length < minSize) return
    if (segDepth >= 4) {
      // Can't refine further — emit as one cluster.
      emitCluster(group, segDepth - 1)
      return
    }
    // Try splitting at segDepth.
    const sub = new Map<string, SkillMeta[]>()
    for (const s of group) {
      const parts = s.name.split('-')
      const key = parts.length >= segDepth ? parts.slice(0, segDepth).join('-') : s.name
      const arr = sub.get(key) ?? []
      arr.push(s)
      sub.set(key, arr)
    }
    // Count how many sub-keys reach minSize.
    const qualified = Array.from(sub.entries()).filter(([, entries]) => entries.length >= minSize)
    if (qualified.length >= 2) {
      for (const [, entries] of qualified) refine(entries, segDepth + 1)
      // Leftover (sub-keys with < minSize) become singletons unless they
      // collectively form a fallback cluster.
      const leftover: SkillMeta[] = []
      for (const entries of sub.values()) if (entries.length < minSize) leftover.push(...entries)
      if (leftover.length >= minSize) {
        // Emit as `<segDepth-1>-*` fallback.
        const fallbackPrefix = `${group[0].name.split('-').slice(0, segDepth - 1).join('-')}-*`
        leftover.sort((a, b) => a.name.localeCompare(b.name))
        clusters.push({
          prefix: fallbackPrefix,
          names: leftover.map((s) => s.name),
          triggerHint: extractTriggerHint(leftover),
        })
        for (const s of leftover) used.add(s.name)
      }
    } else if (qualified.length === 1 && sub.size === 1) {
      // v1.2.151 — single sub-key contains ALL members (e.g. all `fin-*`
      // are `fin-data-*` at depth 2). Recurse deeper to split by depth+1
      // instead of collapsing into a single coarse `fin-data-*` group.
      // Without this fix, 69 fin-data skills land in one cluster and
      // the LLM can't tell aspd / stock / fund families apart by name.
      const onlyQualified = qualified[0]
      if (onlyQualified) refine(onlyQualified[1], segDepth + 1)
    } else {
      emitCluster(group, segDepth - 1)
    }
  }

  function emitCluster(group: SkillMeta[], _depth: number): void {
    group.sort((a, b) => a.name.localeCompare(b.name))
    // Use the actual longest common whole-segment prefix of the group's
    // names — gives `fin-data` for `fin-data-s000` siblings instead of
    // falling back to the depth-1 single segment `fin`. Splits each
    // name on `-`, walks segments left-to-right, stops at first mismatch.
    const parts = group.map((s) => s.name.split('-'))
    const lcp: string[] = []
    const minLen = Math.min(...parts.map((p) => p.length))
    for (let i = 0; i < minLen; i++) {
      const seg = parts[0][i]
      if (parts.every((p) => p[i] === seg)) lcp.push(seg)
      else break
    }
    // If LCP is empty (no common segment — shouldn't happen for grouped
    // members), fall back to the first segment of the first name.
    const prefix = lcp.length > 0 ? lcp.join('-') : parts[0][0]
    clusters.push({
      prefix,
      names: group.map((s) => s.name),
      triggerHint: extractTriggerHint(group),
    })
    for (const s of group) used.add(s.name)
  }

  // Group by first segment.
  const byHead = new Map<string, SkillMeta[]>()
  for (const s of skills) {
    const head = s.name.split('-')[0]
    const arr = byHead.get(head) ?? []
    arr.push(s)
    byHead.set(head, arr)
  }
  // Iterate in deterministic order.
  const headGroups = Array.from(byHead.entries()).sort(([a], [b]) => a.localeCompare(b))
  for (const [, group] of headGroups) refine(group, 2)

  const singletons = skills.filter((s) => !used.has(s.name))
  return { clusters, singletons }
}

/** Pull a short trigger phrase from the FIRST few skills' descriptions.
 *  Strips `[ECC] ` prefix and truncates aggressively (each contribution
 *  ≤ 40 chars). Returned string is ≤ 240 chars total. */
function extractTriggerHint(skills: ReadonlyArray<SkillMeta>): string {
  const parts: string[] = []
  for (const s of skills.slice(0, 5)) {
    const raw = (s.description || '').replace(/^\[ECC\]\s*/, '').trim()
    if (!raw) continue
    // Pull a short snippet: first sentence-ish or first 40 chars.
    const stop = raw.search(/[。.!?！？]/)
    let snippet = stop > 0 && stop < 60 ? raw.slice(0, stop) : raw.slice(0, 40)
    snippet = snippet.replace(/\s+/g, ' ').trim()
    if (snippet) parts.push(snippet)
  }
  return parts.join(' · ').slice(0, 240)
}

/** v1.2.150 — heading text for each cluster bucket. */
const BUCKET_HEADINGS: Record<number, string> = {
  0: 'Framework (agim-* — 长期事实 / 提醒 / 自检 / skill 发现)',
  1: 'Agim builtin',
  2: 'ECC harness + methodology picks (recommended)',
  3: 'Workspace skills (operator-installed business)',
  4: 'ECC remainder (read full description via mcp__agim__read_skill)',
}

/**
 * v1.2.137 — Routing rule prepended to every turn's skill block.
 * v1.2.151 — Extracted into a constant so the override path and the
 * auto path share the same header verbatim.
 */
const SKILLS_ROUTING_HEADER: string = [
  '[agim tool routing — skills first]',
  'Before calling any generic tool (web_fetch / web_search / native_exec /',
  'shell-style commands), you MUST scan the skill list below. If any entry\'s',
  'description matches the user\'s intent — even loosely — you MUST call',
  'mcp__agim__read_skill(\'<name>\') first to load that skill\'s body. Skill',
  'bodies contain dedicated tools, endpoints, or queries that produce',
  'higher-quality, structured results than free-text web pages for the',
  'same intent. Falling back to the generic tool is only valid when:',
  '  (a) no skill description plausibly matches, OR',
  '  (b) you already read a relevant skill and its body explicitly says',
  '      "this skill is not suitable for X" or lacks the needed coverage.',
  'This is a routing discipline, not a hint. Skipping it counts as a',
  'tool-routing error in this conversation.',
].join('\n')

/**
 * v1.2.151 — Render one skill as a tier-1 row with full description.
 * The body is defensive against malformed YAML block-scalar leakage.
 *
 * NOTE: workspace skills (bucket 3) MUST always go through this path
 * — operator-installed business skills are an "I want this" signal
 * from the deployment, so we keep their full descriptions for routing
 * precision regardless of how many there are. The token cost is real
 * but intentional; operators with 100+ workspace skills can use the
 * SPA `/settings/skill-injection` editor to prune (see override path).
 */
function renderSkillRow(s: SkillMeta): string {
  const reason = s.available ? '' : ` (unavailable: ${s.unavailableReason ?? 'requires not met'})`
  const flag = s.always ? ' [always]' : ''
  const descClean = (s.description || '').trim()
  const description = descClean && descClean !== '>-' && descClean !== '|'
    ? descClean
    : '(no description in SKILL.md — read body via mcp__agim__read_skill)'
  return `- ${s.name}: ${description}${reason}${flag}`
}

/** Inline `always: true` skill bodies. Shared between override + auto. */
function appendAlwaysOnBodies(all: ReadonlyArray<SkillMeta>, lines: string[]): void {
  const alwaysOn = all.filter((s) => s.always && s.available)
  for (const s of alwaysOn) {
    const body = readSkillBody(s.name)
    if (!body) continue
    lines.push('')
    lines.push(`### Always-on skill: ${s.name}`)
    lines.push(body)
  }
}

/**
 * v1.2.151 — Build the auto-generated tier-1 block (no header, no
 * always-on bodies — caller wraps). Separated so the SPA editor can
 * preview "what would auto produce right now" via the admin API.
 *
 * Bucket render order:
 *   0 framework → 1 builtin → **3 workspace** → 2 ECC picks → 4 ECC remainder
 *
 * Operator-installed workspace skills out-rank ECC pinned picks because
 * they are the strongest "I want this" signal. ECC picks (curated
 * harness vocabulary) come right after so the LLM still has them
 * within reach. ECC remainder lives at the bottom as the on-demand
 * pool.
 *
 * Buckets 0/1/2/3 all emit full rows (renderSkillRow). Only bucket 4
 * (ECC remainder) clusters — and even then, the cluster path can be
 * disabled or scoped via `AGIM_SKILLS_INJECT_ECC_REMAINDER`.
 */
export function buildAutoInjectionBlock(all: ReadonlyArray<SkillMeta>): string {
  const byBucket: Record<number, SkillMeta[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] }
  for (const s of all) byBucket[rankSkillBucket(s)].push(s)
  for (const b of [0, 1, 2, 3, 4]) {
    byBucket[b].sort((a, b2) => a.name.localeCompare(b2.name))
  }
  const lines: string[] = ['[agim skills available — read full body with mcp__agim__read_skill(name)]']

  // Render order: 0 framework, 1 builtin, 3 workspace, 2 ECC picks.
  // Workspace before ECC picks per v1.2.151 iron rule: operator-installed
  // business skills rank above framework-curated harness picks.
  for (const b of [0, 1, 3, 2]) {
    const items = byBucket[b]
    if (items.length === 0) continue
    lines.push('')
    lines.push(`## ${BUCKET_HEADINGS[b]} (${items.length})`)
    for (const s of items) lines.push(renderSkillRow(s))
  }

  // Bucket 4 (ECC remainder) — cluster, with operator opt-out / allowlist.
  const eccRem = byBucket[4]
  if (eccRem.length > 0) {
    const remainderMode = resolveEccRemainderMode()
    const filtered: SkillMeta[] =
      remainderMode.mode === 'off' ? []
      : remainderMode.mode === 'allowlist'
        ? eccRem.filter((s) => remainderMode.names.has(s.name))
        : eccRem
    if (filtered.length > 0) {
      lines.push('')
      lines.push(`## ${BUCKET_HEADINGS[4]} (${filtered.length})`)
      const { clusters, singletons } = clusterSkills(filtered, 3)
      for (const c of clusters) {
        lines.push(`- ${c.prefix}-* (${c.names.length}): ${c.names.join(' · ')}`)
      }
      if (singletons.length > 0) {
        const names = singletons.map((s) => s.name).join(' · ')
        lines.push(`- (other ECC, ${singletons.length}): ${names}`)
      }
    }
  }
  return lines.join('\n')
}

export function buildSkillsSummary(): string {
  // v1.2.151 — operator override path: if `~/.agim/skill-injection-
  // override.md` exists, return its body verbatim (still wrapped by
  // the routing header + always-on bodies). The auto block is
  // suppressed; the operator gets full editorial control. The SPA at
  // `/settings/skill-injection` is the recommended way to author this.
  const override = readInjectionOverride()
  const all = listSkills()
  if (override) {
    const lines: string[] = [SKILLS_ROUTING_HEADER, '', override]
    appendAlwaysOnBodies(all, lines)
    return `${lines.join('\n')}\n`
  }

  if (all.length === 0) return ''

  const lines: string[] = [SKILLS_ROUTING_HEADER, '', buildAutoInjectionBlock(all)]
  appendAlwaysOnBodies(all, lines)
  return `${lines.join('\n')}\n`
}

// ─── Scanning ────────────────────────────────────────────────────────

function ensureCache(): CacheEntry {
  if (cache && Date.now() - cache.scannedAt < CACHE_TTL_MS) return cache
  cache = doScan()
  return cache
}

function doScan(): CacheEntry {
  const discovered: SkillDiscovered[] = []
  // 1. Walk the configured roots in priority order. The first root is
  //    always the agim-owned workspace dir, so any operator-installed
  //    skill shadows same-named entries from inherited CLI agent dirs.
  const roots = resolveSkillsRoots()
  const seen = new Set<string>()
  for (const root of roots) {
    const found: SkillDiscovered[] = []
    scanDir(root, 'workspace', found)
    for (const f of found) {
      if (seen.has(f.name)) continue
      seen.add(f.name)
      discovered.push(f)
    }
  }
  // 2. built-in tier 0; skip names already taken by any root above.
  const builtinDir = builtinSkillsDir()
  const builtinFound: SkillDiscovered[] = []
  scanDir(builtinDir, 'builtin', builtinFound)
  for (const b of builtinFound) {
    if (seen.has(b.name)) continue
    seen.add(b.name)
    discovered.push(b)
  }

  const skills: SkillMeta[] = []
  for (const d of discovered) {
    const meta = parseSkill(d)
    if (meta) skills.push(meta)
  }
  const byName = new Map<string, SkillMeta>()
  for (const s of skills) byName.set(s.name.toLowerCase(), s)

  log.info({
    event: 'skills.scanned',
    mode: currentSkillsMode(),
    roots,
    builtinDir,
    total: skills.length,
    available: skills.filter((s) => s.available).length,
  })
  return { scannedAt: Date.now(), skills, byName }
}

function scanDir(dir: string, source: 'workspace' | 'builtin', out: SkillDiscovered[]): void {
  if (!dir || !existsSync(dir)) return
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch (err) {
    log.debug({ event: 'skills.scan.readdir_failed', dir, err: String(err) })
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const skillDir = join(dir, name)
    let st: import('node:fs').Stats
    try { st = statSync(skillDir) } catch { continue }
    if (!st.isDirectory()) continue
    const md = join(skillDir, 'SKILL.md')
    if (!existsSync(md)) continue
    let body = ''
    try {
      const raw = readFileSync(md, 'utf-8')
      body = raw.length > MAX_SKILL_BODY_CHARS
        ? raw.slice(0, MAX_SKILL_BODY_CHARS)
        : raw
    } catch (err) {
      log.warn({ event: 'skills.scan.read_failed', dir: skillDir, err: String(err) })
      continue
    }
    out.push({ name, dir: skillDir, source, body })
  }
}

/**
 * Parse a discovered SKILL.md into a SkillMeta. Returns null when the
 * frontmatter is missing required fields — we don't load corrupt
 * skills, but we DO log a warning so the operator notices.
 */
function parseSkill(d: SkillDiscovered): SkillMeta | null {
  const front = extractFrontmatter(d.body)
  if (!front) {
    log.warn({ event: 'skills.parse.no_frontmatter', name: d.name, dir: d.dir })
    return null
  }
  // v1.2.148 — operators can disable the bundled ECC skill pack
  // (229 entries imported from github.com/affaan-m/ECC, MIT) via env.
  // Detection: each ECC SKILL.md declares `origin: ECC` in frontmatter.
  // Operator-authored skills with the same `origin` value are honoured
  // (the assumption is the operator wrote the frontmatter knowingly).
  if (
    String(front.origin || '').trim() === 'ECC'
    && (process.env.AGIM_INCLUDE_ECC_SKILLS ?? '').toLowerCase().trim() === 'off'
  ) {
    return null
  }
  const name = (front.name || d.name).trim()
  if (!name) return null
  let description = (front.description || '').trim().slice(0, MAX_DESCRIPTION_CHARS)
  // v1.2.148 — defensive: when the YAML block-scalar marker leaks
  // through (`>-` / `>` / `|` / `|-` left as the literal value because
  // the continuation was malformed, the marker was prefixed by something
  // else, or the operator left the body empty), we'd otherwise ship a
  // garbage description into the system prompt. Substitute a fallback +
  // warn so the operator notices.
  if (/^(?:>-?|\|-?)$/.test(description)) {
    log.warn({ event: 'skills.parse.literal_block_scalar', name, dir: d.dir, raw: description })
    description = '(SKILL.md description used an unsupported YAML form — read body via mcp__agim__read_skill)'
  }
  if (!description) {
    log.warn({ event: 'skills.parse.no_description', name, dir: d.dir })
    return null
  }
  const always = parseBool(front.always)
  const requiresBins = parseRequiresList(front, 'bins')
  const requiresEnv = parseRequiresList(front, 'env')
  let available = true
  let unavailableReason: string | undefined
  const missingBins = requiresBins.filter((b) => !isBinOnPath(b))
  if (missingBins.length > 0) {
    available = false
    unavailableReason = `missing bin${missingBins.length === 1 ? '' : 's'} ${missingBins.map((b) => `\`${b}\``).join(', ')}`
  } else {
    const missingEnv = requiresEnv.filter((e) => !process.env[e])
    if (missingEnv.length > 0) {
      available = false
      unavailableReason = `missing env ${missingEnv.map((e) => `\`${e}\``).join(', ')}`
    }
  }
  return {
    name,
    description,
    source: d.source,
    dir: d.dir,
    always,
    requiresBins,
    requiresEnv,
    available,
    unavailableReason,
    origin: front.origin ? String(front.origin).trim() : undefined,
  }
}

interface Frontmatter {
  name?: string
  description?: string
  always?: string
  /** v1.2.148 — ECC origin tag. Used by the bundled ECC pack so the
   *  `AGIM_INCLUDE_ECC_SKILLS=off` switch can drop them in one place
   *  without a name allowlist. Operator-written skills may set this
   *  too; that's intentional. */
  origin?: string
  /** Full "metadata: …" JSON-ish string when the YAML uses the
   *  inline-JSON form `metadata: '{"agim":{"requires":...}}'`. */
  metadataJson?: string
  /** Direct list-of-strings under `requires.bins` (alt parse path). */
  binsLine?: string
  /** Direct list-of-strings under `requires.env`. */
  envLine?: string
}

/**
 * Extract the YAML-ish frontmatter (between `---` delimiters at the
 * top of the file). Returns null when missing.
 *
 * Limited parser — handles:
 *   key: value
 *   key: "quoted value"
 *   metadata: '{"agim":{"requires":{"bins":["x"],"env":["Y"]}}}'
 *
 * Doesn't handle multi-line strings, nested block mappings (other than
 * the metadata JSON shortcut), or list literals beyond simple
 * comma-separated `[a, b, c]` inside the metadata JSON. Skills that
 * need richer YAML can wait for a real parser.
 */
function extractFrontmatter(body: string): Frontmatter | null {
  if (!body.startsWith('---')) return null
  // Find the closing delimiter; tolerate \r\n.
  const closeIdx = body.indexOf('\n---', 3)
  if (closeIdx === -1) return null
  const raw = body.slice(3, closeIdx).trim()
  const front: Frontmatter = {}
  const lines = raw.split('\n')
  // v1.2.65 — support YAML literal block scalars (`>`, `>-`, `|`, `|-`)
  // so SKILL.md files with multi-line `description: >- \n  line1 \n  line2`
  // don't end up with description = literal "&gt;-". We collect the
  // indented continuation lines and join them per the operator (`>` =
  // folded with spaces; `|` = preserve newlines).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const valueRaw = m[2].trim()
    let value: string
    if (valueRaw === '>' || valueRaw === '>-' || valueRaw === '|' || valueRaw === '|-') {
      // Collect continuation: subsequent lines with leading whitespace.
      const foldStyle = valueRaw[0] === '>'
      const parts: string[] = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        // Stop at next top-level key (no leading whitespace + key:value)
        // or a blank line followed by a top-level key.
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(next)) break
        // Strip up to 2 spaces of indentation; preserve everything else.
        parts.push(next.replace(/^\s{1,4}/, ''))
        i++
      }
      const joined = foldStyle ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim()
      value = stripQuotes(joined)
    } else {
      value = stripQuotes(valueRaw)
    }
    if (key === 'name') front.name = value
    else if (key === 'description') front.description = value
    else if (key === 'always') front.always = value
    else if (key === 'origin') front.origin = value
    else if (key === 'metadata') front.metadataJson = value
  }
  return front
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false
  const v = raw.toLowerCase()
  return v === 'true' || v === 'yes' || v === '1'
}

/**
 * Pull `bins` or `env` out of the metadata JSON shortcut. Format:
 *
 *   metadata: '{"agim":{"requires":{"bins":["x"],"env":["Y"]}}}'
 *
 * Also accepts the legacy `openclaw` key (nanobot's name) for
 * compatibility with skills written for nanobot.
 */
function parseRequiresList(front: Frontmatter, which: 'bins' | 'env'): string[] {
  if (!front.metadataJson) return []
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(front.metadataJson) as Record<string, unknown>
  } catch {
    return []
  }
  const nestedAgim = (obj.agim && typeof obj.agim === 'object') ? obj.agim as Record<string, unknown> : null
  const nestedOpenclaw = (obj.openclaw && typeof obj.openclaw === 'object') ? obj.openclaw as Record<string, unknown> : null
  const nested = nestedAgim ?? nestedOpenclaw
  if (!nested) return []
  const requires = (nested.requires && typeof nested.requires === 'object') ? nested.requires as Record<string, unknown> : null
  if (!requires) return []
  const arr = requires[which]
  if (!Array.isArray(arr)) return []
  return arr.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function isBinOnPath(bin: string): boolean {
  // Cheap synchronous PATH probe. Doesn't follow symlinks; that's fine
  // for a "is this binary likely to work?" hint.
  if (!bin || bin.includes('/')) {
    // If the skill declared an absolute path, just check existence.
    return existsSync(bin)
  }
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, ext ? `${bin}${ext}` : bin)
      try {
        if (existsSync(candidate)) return true
      } catch { /* ignore */ }
    }
  }
  return false
}
