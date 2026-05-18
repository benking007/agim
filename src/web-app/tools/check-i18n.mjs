#!/usr/bin/env node
/**
 * check-i18n.mjs — assert key parity across i18n namespaces.
 *
 * For every namespace under src/i18n/locales/<lang>/<ns>.json,
 * compare the flattened key set in EVERY language against the
 * union of keys across all langs. Any missing key in any lang →
 * exit 1 with a report.
 *
 * Why "union" rather than "match en exactly": guards both
 * directions — a forgotten zh translation AND a stale zh key the
 * en file never had (translation drift after backend i18n refresh).
 *
 * Run:
 *   node tools/check-i18n.mjs              # standard CI gate
 *   node tools/check-i18n.mjs --verbose    # log per-ns counts too
 *
 * Exit codes:
 *   0  every namespace's keys match across all langs
 *   1  drift detected — script prints a per-ns diff before exit
 *
 * Dependencies: none. Pure Node 18+ (top-level await, fs/promises,
 * url.fileURLToPath). Designed to slot into CI before vitest so a
 * missing translation kills the run early.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(SCRIPT_DIR, '..', 'src', 'i18n', 'locales')

const verbose = process.argv.includes('--verbose')

/** Walk one JSON object and flatten its leaf keys to a sorted array
 *  of dot-paths. Arrays are treated as leaves (you don't translate
 *  array indices — interpolation is the right answer when a string
 *  has variable parts). */
function flattenKeys(obj, prefix = '') {
  const out = []
  if (obj == null || typeof obj !== 'object') {
    if (prefix) out.push(prefix)
    return out
  }
  if (Array.isArray(obj)) {
    if (prefix) out.push(prefix)
    return out
  }
  for (const k of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${k}` : k
    const v = obj[k]
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flattenKeys(v, next))
    } else {
      out.push(next)
    }
  }
  return out
}

/** Returns a Map<lang, Map<ns, Set<key>>>. */
async function loadAll() {
  const langs = await readdir(LOCALES_DIR, { withFileTypes: true })
  const byLang = new Map()
  for (const lang of langs) {
    if (!lang.isDirectory()) continue
    const langPath = join(LOCALES_DIR, lang.name)
    const files = await readdir(langPath)
    const nsMap = new Map()
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const ns = f.replace(/\.json$/, '')
      const raw = await readFile(join(langPath, f), 'utf-8')
      const parsed = JSON.parse(raw)
      nsMap.set(ns, new Set(flattenKeys(parsed)))
    }
    byLang.set(lang.name, nsMap)
  }
  return byLang
}

function setDiff(a, b) {
  const out = []
  for (const x of a) if (!b.has(x)) out.push(x)
  return out
}

async function main() {
  const byLang = await loadAll()
  const langs = [...byLang.keys()].sort()
  if (langs.length < 2) {
    console.log(`[check-i18n] only ${langs.length} lang found at ${LOCALES_DIR}; nothing to compare.`)
    process.exit(0)
  }

  // Build the union of namespace names across all langs. A ns
  // missing from one lang entirely is itself a violation.
  const allNs = new Set()
  for (const nsMap of byLang.values()) for (const ns of nsMap.keys()) allNs.add(ns)

  let problems = 0
  for (const ns of [...allNs].sort()) {
    // 1. Detect missing namespaces (one lang has the file, another doesn't).
    const missingIn = langs.filter((l) => !byLang.get(l).has(ns))
    if (missingIn.length > 0) {
      console.error(`[check-i18n] namespace "${ns}" missing in: ${missingIn.join(', ')}`)
      problems += missingIn.length
      continue
    }

    // 2. Compute the union of keys across all langs for this ns.
    const union = new Set()
    for (const l of langs) for (const k of byLang.get(l).get(ns)) union.add(k)

    let nsDrift = 0
    for (const l of langs) {
      const missing = setDiff(union, byLang.get(l).get(ns))
      if (missing.length > 0) {
        console.error(`[check-i18n] ${l}/${ns}.json — missing ${missing.length} key(s):`)
        for (const k of missing.sort()) console.error(`  - ${k}`)
        nsDrift += missing.length
      }
    }
    problems += nsDrift
    if (verbose && nsDrift === 0) {
      console.log(`[check-i18n] ${ns}: ${union.size} keys × ${langs.length} langs OK`)
    }
  }

  if (problems > 0) {
    console.error(`\n[check-i18n] ${problems} parity issue(s) detected. Add the missing keys (or remove the orphan ones) and re-run.`)
    process.exit(1)
  }
  console.log(`[check-i18n] OK — ${[...allNs].length} ns × ${langs.length} langs in parity (${langs.join('/')}).`)
}

await main()
