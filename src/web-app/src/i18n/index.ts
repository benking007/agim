/**
 * i18n — react-i18next setup.
 *
 * Namespaces:
 *   common — buttons / generic / states reused on every page
 *   errors — ApiClientError code → human-readable text
 *
 * Each domain route adds its own ns later (tasks / approvals /
 * memory / observability / settings / chat / ...). Loaded via
 * i18next-http-backend so the SPA initial bundle stays small; ns
 * arrive on-demand when a route's `useTranslation('tasks')` runs.
 *
 * The active language is mirrored from `usePrefs` (zustand) so a
 * single `setLang('zh')` flips both the React state tree and the
 * i18next instance. The legacy localStorage key `im-hub-lang` is
 * preserved so the v1 UI's persisted preference carries over.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import HttpBackend from 'i18next-http-backend'

// JSON bundles for the cold-start namespaces are inlined so the
// first paint already has button labels / error toasts in the right
// language — no flash-of-untranslated-content. Page-specific ns are
// loaded via HttpBackend on demand.
import commonEn from './locales/en/common.json'
import commonZh from './locales/zh/common.json'
import errorsEn from './locales/en/errors.json'
import errorsZh from './locales/zh/errors.json'

void i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn, errors: errorsEn },
      zh: { common: commonZh, errors: errorsZh },
    },
    lng: detectInitialLang(),
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    ns: ['common', 'errors'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React already escapes
    react: { useSuspense: false },         // we render skeletons ourselves
    backend: {
      // Served by Vite from src/web-app/public/locales/<lang>/<ns>.json
      // in dev; from dist/assets in prod. PR-N migrates this to inline
      // bundle once page count justifies it.
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    detection: {
      // We bypass i18next's built-in detector; usePrefs.lang is the
      // source of truth, propagated via syncI18nLanguage().
      order: [],
      caches: [],
    },
  })

function detectInitialLang(): 'en' | 'zh' {
  try {
    const v = localStorage.getItem('im-hub-lang')
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
  if (i18n.language === lang) return
  void i18n.changeLanguage(lang)
}

export default i18n
