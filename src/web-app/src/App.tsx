/**
 * App — placeholder root component for M1 PR-1.
 *
 * Purpose of this file in PR-1: prove the toolchain works (Vite + React
 * + TS + Tailwind tokens + dark mode) by rendering a single page that
 * exercises all of:
 *
 *   - Tailwind utility classes against the HSL token palette
 *   - data-theme cycling (light / dark / system)
 *   - viewport / safe-area handling on mobile
 *   - 100dvh full-height layout
 *
 * Real route assembly (RequireAuth, RouterProvider, QueryClientProvider,
 * etc.) ships in PR-4 / PR-5 / PR-6 per the plan. Don't grow this file
 * into App-the-shell; new code goes into routes/ + components/shell/.
 */

import { useState, useEffect } from 'react'

type ThemeMode = 'system' | 'light' | 'dark'
const THEME_KEY = 'agim-theme'

function getInitialTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* private-mode storage exceptions */
  }
  return 'system'
}

function applyTheme(mode: ThemeMode): void {
  if (mode === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', mode)
  }
}

export default function App(): JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(getInitialTheme)

  useEffect(() => {
    applyTheme(mode)
    try {
      if (mode === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  const cycle = (): void => {
    setMode((m) => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'))
  }

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b border-border bg-surface px-4 py-3 pt-safe shadow-sm">
        <span className="text-md font-semibold">
          <span className="mr-2">🤖</span>Agim
        </span>
        <span className="rounded-full bg-accent-bg px-2 py-0.5 text-xs font-semibold text-accent">
          v2 skeleton
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="tap-target rounded-md border border-border bg-surface px-3 py-1 text-sm text-text-dim hover:border-border-strong hover:bg-surface-hover hover:text-text"
            onClick={cycle}
          >
            Theme: <strong>{mode}</strong>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Agim Web v2 — skeleton</h1>
        <p className="mt-2 text-sm text-text-dim">
          Vite + React 18 + TypeScript + Tailwind 3 + design tokens loaded.
          Subsequent PRs add routing, i18n, shadcn components, and the
          eleven domain pages.
        </p>

        <section className="mt-8 rounded-lg border border-border bg-surface p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Token sanity check</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['surface', 'accent', 'success', 'warning', 'danger', 'info'] as const).map(
              (k) => (
                <div
                  key={k}
                  className="flex flex-col gap-1 rounded border border-border p-3 text-xs"
                >
                  <span className="font-medium text-text-dim">{k}</span>
                  <span
                    className="h-8 rounded"
                    style={{
                      background: `hsl(var(--ag-${k === 'surface' ? 'surface' : k}))`,
                    }}
                  />
                </div>
              ),
            )}
          </div>
          <p className="mt-4 text-xs text-text-muted">
            Click the theme button to cycle <code>system → light → dark</code>;
            the palette updates without a reload. The chip behind <em>Agim</em>{' '}
            stays accent-tinted across both modes.
          </p>
        </section>

        <section className="mt-6 rounded-lg border border-border bg-surface p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Mobile baselines</h2>
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-text-dim">
            <li>
              <code>viewport-fit=cover</code> + <code>pt-safe</code> on the header so
              the brand chip sits below the iOS notch.
            </li>
            <li>
              <code>min-h-dvh</code> on the root so 100% height honors the soft
              keyboard / URL bar (vs <code>100vh</code> which lies on mobile).
            </li>
            <li>
              Theme toggle is a 44×44 hit target (<code>.tap-target</code>) — thumb-
              friendly even on small phones.
            </li>
          </ul>
        </section>
      </main>
    </div>
  )
}
