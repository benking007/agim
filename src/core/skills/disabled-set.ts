// Per-account skill enable/disable flags.
//
// Persistence:
//   ~/.agim/users/<usr_id>/skills-disabled.json   (signed-in account)
//   ~/.agim/skills-disabled.json                  (no account ALS)
//
// The list is a JSON array of skill names (case-insensitive). Names in
// the file are skipped by system-prompt injection; listSkills() still
// returns them so the Portal can show a toggle.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from '../agim-paths.js'
import { currentAccountUserId } from '../accounts.js'

function disabledPath(): string {
  const uid = currentAccountUserId()
  if (uid) return join(AGIM_HOME, 'users', uid, 'skills-disabled.json')
  return join(AGIM_HOME, 'skills-disabled.json')
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function readDisabled(): string[] {
  const path = disabledPath()
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    const names: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const key = normalizeName(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      names.push(key)
    }
    return names
  } catch {
    return []
  }
}

function writeDisabled(names: string[]): void {
  const path = disabledPath()
  mkdirSync(dirname(path), { recursive: true })
  const unique = [...new Set(names.map(normalizeName).filter(Boolean))].sort()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(unique, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

/** Names currently disabled for the ALS account (lowercase). */
export function listDisabledSkillNames(): string[] {
  return readDisabled()
}

export function isSkillEnabled(name: string): boolean {
  const key = normalizeName(name)
  if (!key) return true
  return !readDisabled().includes(key)
}

/** Persist the toggle. Returns the resulting enabled flag. */
export function setSkillEnabled(name: string, enabled: boolean): boolean {
  const key = normalizeName(name)
  if (!key) return enabled
  const current = new Set(readDisabled())
  if (enabled) current.delete(key)
  else current.add(key)
  writeDisabled([...current])
  return enabled
}
