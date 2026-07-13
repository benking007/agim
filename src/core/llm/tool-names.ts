// Agim Agent tool name canonicalization.
//
// Historical tools were advertised as `native_*`. Canonical names are now
// `agim_*`. Dispatchers accept BOTH during the migration window; models are
// advertised the `agim_*` form only.

/** Map legacy `native_*` → canonical `agim_*`. Identity for already-canonical. */
export const NATIVE_TO_AGIM_TOOL: Readonly<Record<string, string>> = {
  native_echo: 'agim_echo',
  native_now: 'agim_now',
  native_sleep_ms: 'agim_sleep_ms',
  native_random_uuid: 'agim_random_uuid',
  native_read_file: 'agim_read_file',
  native_write_file: 'agim_write_file',
  native_list_dir: 'agim_list_dir',
  native_glob: 'agim_glob',
  native_grep: 'agim_grep',
  native_web_fetch: 'agim_web_fetch',
  native_web_search: 'agim_web_search',
  native_exec: 'agim_exec',
  native_todo_write: 'agim_todo_write',
  native_exit_plan_mode: 'agim_exit_plan_mode',
  native_edit_file: 'agim_edit_file',
}

const AGIM_TO_NATIVE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NATIVE_TO_AGIM_TOOL).map(([legacy, canon]) => [canon, legacy]),
)

/** Resolve any accepted name to the canonical `agim_*` form. */
export function canonicalizeToolName(name: string): string {
  if (!name) return name
  if (NATIVE_TO_AGIM_TOOL[name]) return NATIVE_TO_AGIM_TOOL[name]
  return name
}

/** True when `name` is the canonical tool or its legacy `native_*` alias. */
export function toolNameMatches(name: string, canonical: string): boolean {
  const c = canonicalizeToolName(name)
  return c === canonicalizeToolName(canonical)
}

/** Expand a deny/allow list so both legacy and canonical spellings match. */
export function expandToolNameList(names: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const raw of names) {
    const n = raw.trim()
    if (!n) continue
    out.add(n)
    const canon = canonicalizeToolName(n)
    out.add(canon)
    const legacy = AGIM_TO_NATIVE[canon]
    if (legacy) out.add(legacy)
  }
  return out
}

/** All names (canonical + legacy) that should be treated as the same tool. */
export function toolNameVariants(canonicalOrLegacy: string): string[] {
  const canon = canonicalizeToolName(canonicalOrLegacy)
  const legacy = AGIM_TO_NATIVE[canon]
  return legacy && legacy !== canon ? [canon, legacy] : [canon]
}
