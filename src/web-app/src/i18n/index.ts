/**
 * i18n — react-i18next setup.
 *
 * Cold-start namespaces (`common`, `errors`) load for the **active**
 * language only (dynamic `import()` → own Vite chunk). The other
 * language arrives on `changeLanguage`. Page namespaces stay on-demand.
 *
 * This keeps both languages' JSON out of the entry chunk.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

/** Namespaces fetched only when a route/dialog first calls useTranslation. */
export const LAZY_NAMESPACES = [
  'tasks',
  'approvals',
  'reminders',
  'memos',
  'memory',
  'skills',
  'workspace',
  'observability',
  'settings',
] as const

export type LazyNamespace = (typeof LAZY_NAMESPACES)[number]

const COLD_START_NAMESPACES = ['common', 'errors'] as const
const ALL_NAMESPACES = [...COLD_START_NAMESPACES, ...LAZY_NAMESPACES] as const

/** Vite turns each match into its own async chunk. */
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/*/*.json',
)

type ReadCallback = (err: Error | null, data: false | Record<string, unknown>) => void

/** Minimal i18next backend — no HTTP round-trip, just dynamic import(). */
const viteLocaleBackend = {
  type: 'backend' as const,
  init(): void { /* no-op */ },
  read(language: string, namespace: string, callback: ReadCallback): void {
    const key = `./locales/${language}/${namespace}.json`
    const loader = localeModules[key]
    if (!loader) {
      callback(new Error(`missing locale module ${key}`), false)
      return
    }
    loader()
      .then((mod) => callback(null, mod.default))
      .catch((err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), false)
      })
  },
}

async function loadLocaleJson(
  language: 'en' | 'zh',
  namespace: 'common' | 'errors',
): Promise<Record<string, unknown>> {
  const key = `./locales/${language}/${namespace}.json`
  const loader = localeModules[key]
  if (!loader) throw new Error(`missing locale module ${key}`)
  const mod = await loader()
  return mod.default
}

let bootstrapped: Promise<typeof i18n> | null = null

/**
 * Load cold-start strings for one language and init i18next.
 * Call once from `main.tsx` (and vitest setup) before first render.
 * Subsequent calls reuse the first bootstrap (lang arg ignored).
 */
export function bootstrapI18n(lang: 'en' | 'zh' = detectInitialLang()): Promise<typeof i18n> {
  if (bootstrapped) return bootstrapped
  bootstrapped = (async () => {
    const [common, errors] = await Promise.all([
      loadLocaleJson(lang, 'common'),
      loadLocaleJson(lang, 'errors'),
    ])

    await i18n
      .use(viteLocaleBackend)
      .use(initReactI18next)
      .init({
        // Only `lang`'s common/errors are preloaded; the other language
        // + page namespaces go through the Vite backend.
        partialBundledLanguages: true,
        resources: {
          [lang]: { common, errors },
        },
        lng: lang,
        fallbackLng: 'en',
        supportedLngs: ['en', 'zh'],
        ns: [...ALL_NAMESPACES],
        defaultNS: 'common',
        interpolation: { escapeValue: false },
        react: { useSuspense: false },
      })

    syncDocumentLang(lang)
    return i18n
  })()
  return bootstrapped
}

/** Resolves after `bootstrapI18n` finishes (does not start bootstrap itself). */
export function i18nReady(): Promise<typeof i18n> {
  if (!bootstrapped) {
    return Promise.reject(new Error('i18n: call bootstrapI18n() before i18nReady()'))
  }
  return bootstrapped
}

export function detectInitialLang(): 'en' | 'zh' {
  try {
    const v = localStorage.getItem('agim-lang')
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* ignore */
  }
  if (typeof navigator === 'undefined') return 'en'
  return (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Imperatively flip the active language. Called by setLang() and
 *  also by tests that want to force a language without going through
 *  the zustand store. */
export function syncI18nLanguage(lang: 'en' | 'zh'): void {
  syncDocumentLang(lang)
  if (i18n.language === lang) return
  void i18n.changeLanguage(lang)
}

function syncDocumentLang(lang: 'en' | 'zh'): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}

/** Preload lazy page namespaces (and both languages) for vitest. */
export async function ensureLazyNamespacesLoaded(): Promise<void> {
  await bootstrapI18n()
  await Promise.all([
    i18n.loadLanguages(['en', 'zh']),
    i18n.loadNamespaces([...LAZY_NAMESPACES]),
  ])
}

export default i18n
