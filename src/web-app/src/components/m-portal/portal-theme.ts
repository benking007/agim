import type { ThemeMode } from '@/stores/prefs'

export type Theme = 'dark' | 'light'

export function resolveTheme(mode: ThemeMode): Theme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}
