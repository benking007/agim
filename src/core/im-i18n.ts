// Bilingual IM error templates. Telegram/Discord default to English;
// other channels default to Chinese. A per-user override can be stored
// in ~/.agim/im-lang.json (userKey → 'en' | 'zh').

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'

export type ImLang = 'zh' | 'en'

const PREF_FILE = join(AGIM_HOME, 'im-lang.json')

const GLOBAL_IM = new Set(['telegram', 'discord'])

function loadPrefs(): Record<string, ImLang> {
  try {
    const raw = JSON.parse(readFileSync(PREF_FILE, 'utf8')) as Record<string, unknown>
    const out: Record<string, ImLang> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v === 'en' || v === 'zh') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function rememberImLang(userKey: string, lang: ImLang): void {
  if (!userKey) return
  try {
    const prefs = loadPrefs()
    prefs[userKey] = lang
    mkdirSync(dirname(PREF_FILE), { recursive: true, mode: 0o700 })
    writeFileSync(PREF_FILE, JSON.stringify(prefs, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch { /* best-effort */ }
}

export function resolveImLang(input: {
  platform?: string
  userId?: string
  channelId?: string
} = {}): ImLang {
  const userKey = [input.platform, input.userId || input.channelId].filter(Boolean).join(':')
  if (userKey) {
    const prefs = loadPrefs()
    const saved = prefs[userKey]
    if (saved) return saved
  }
  const platform = (input.platform ?? '').toLowerCase()
  if (GLOBAL_IM.has(platform)) return 'en'
  return 'zh'
}

export function imText(lang: ImLang, zh: string, en: string): string {
  return lang === 'en' ? en : zh
}
