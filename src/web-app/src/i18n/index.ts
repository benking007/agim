/**
 * i18n — react-i18next setup.
 *
 * Cold-start (inlined in the entry chunk):
 *   common — buttons / nav / chat shell / generic states
 *   errors — ApiClientError code → human-readable text
 *
 * Page namespaces load on demand via Vite async chunks
 * (`import.meta.glob` of ./locales/<lng>/<ns>.json). This keeps the
 * SPA entry under the 350 KiB budget — settings.json alone is ~105 KiB
 * raw across en+zh when both languages are inlined.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import commonEn from './locales/en/common.json'
import commonZh from './locales/zh/common.json'
import errorsEn from './locales/en/errors.json'
import errorsZh from './locales/zh/errors.json'

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

const ALL_NAMESPACES = ['common', 'errors', ...LAZY_NAMESPACES] as const

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

const initialLang = detectInitialLang()

export const i18nReady: Promise<typeof i18n> = i18n
  .use(viteLocaleBackend)
  .use(initReactI18next)
  .init({
    // Tell i18next that common/errors are already present so the backend
    // is not asked to re-fetch them.
    partialBundledLanguages: true,
    resources: {
      en: { common: commonEn, errors: errorsEn },
      zh: { common: commonZh, errors: errorsZh },
    },
    lng: initialLang,
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    ns: [...ALL_NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React already escapes
    react: { useSuspense: false },         // we render skeletons ourselves
  })
  .then(() => {
    syncDocumentLang(i18n.language === 'zh' ? 'zh' : 'en')
    return i18n
  })

function detectInitialLang(): 'en' | 'zh' {
  try {
    const v = localStorage.getItem('agim-lang')
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* ignore */
  }
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

/** Preload every lazy namespace (used by vitest so assertions don't race). */
export async function ensureLazyNamespacesLoaded(): Promise<void> {
  await i18nReady
  await i18n.loadNamespaces([...LAZY_NAMESPACES])
}

export default i18n
