// env-compat — single point of truth for env-variable aliasing.
//
// History: most env vars use the `IMHUB_*` prefix (matches the `im-hub`
// project name, no separator). A small set landed early as `IM_HUB_*`
// (underscored) and stayed for backwards compatibility. The mismatch
// became a regular source of operator confusion ("I set
// IMHUB_AUDIT_RETENTION_DAYS, why doesn't it apply?" — because the
// only reader was `IM_HUB_AUDIT_RETENTION_DAYS`).
//
// This helper:
//   1. Reads the canonical name first.
//   2. Falls back to any deprecated alias, emitting a one-time warn
//      so the operator notices but the deployment keeps working.
//   3. Returns undefined if neither is set.
//
// Use `readEnvCompat('IMHUB_FOO_BAR', 'IM_HUB_FOO_BAR')` in place of
// `process.env.IMHUB_FOO_BAR || process.env.IM_HUB_FOO_BAR`.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'env-compat' })
const warned = new Set<string>()

/**
 * Resolve an env value, preferring the canonical name and falling back
 * to each provided alias in order. Emits a deprecation warn (once per
 * process per alias) when the value comes from an alias.
 *
 * Empty strings are treated as "not set" — operators sometimes export
 * `FOO=` to mean "use the default" and we want that semantics.
 */
export function readEnvCompat(canonical: string, ...aliases: string[]): string | undefined {
  const canon = process.env[canonical]
  if (canon !== undefined && canon !== '') return canon
  for (const alias of aliases) {
    const v = process.env[alias]
    if (v !== undefined && v !== '') {
      if (!warned.has(alias)) {
        warned.add(alias)
        log.warn({
          event: 'env-compat.deprecated',
          deprecated: alias,
          canonical,
        }, `env "${alias}" is deprecated; rename to "${canonical}"`)
      }
      return v
    }
  }
  return undefined
}

/** Test-only — clear the warn-once set so repeated tests can verify the warn fires. */
export function _resetEnvCompatWarnings(): void { warned.clear() }
