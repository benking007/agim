/**
 * Global vitest setup.
 *
 * Imports @testing-library/jest-dom matchers (toBeInTheDocument,
 * toHaveTextContent, etc.) so individual test files don't repeat
 * the import.
 *
 * Also installs a localStorage stub for jsdom — the stores/* code
 * touches localStorage on import, and jsdom's default localStorage
 * is fine, but private-mode throwing behavior is what we want to
 * exercise. Each test file can override per-test with vi.spyOn.
 */

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { bootstrapI18n, ensureLazyNamespacesLoaded } from '@/i18n'

// jsdom does not implement blob URLs; composer attachments use them for
// image previews (same path as "+" pick and clipboard paste).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:agim-test'
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {}
}
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// vitest is configured with `globals: false`, so RTL's auto-cleanup
// (which keys off a global `afterEach`) doesn't activate by default.
// Register it explicitly so JSX renders don't leak DOM between tests
// — without this, repeated render() calls in the same file shadow
// getByTestId / getByRole queries with "found multiple elements".
afterEach(() => {
  cleanup()
})

// Make sure private-mode style storage exceptions don't bubble into
// tests as uncaught errors. Some Node/jsdom combinations also expose a
// partial read-only localStorage when NODE_OPTIONS contains
// --localstorage-file without a usable path; install a tiny in-memory
// Storage shim in that case so route tests can keep using
// localStorage.setItem('agim_token', 'tok').
function createStorageShim(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear() {
      data.clear()
    },
    getItem(key: string) {
      return data.get(key) ?? null
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null
    },
    removeItem(key: string) {
      data.delete(key)
    },
    setItem(key: string, value: string) {
      data.set(key, String(value))
    },
  }
}

function ensureLocalStorage(): Storage {
  const current = window.localStorage
  const complete = current
    && typeof current.getItem === 'function'
    && typeof current.setItem === 'function'
    && typeof current.removeItem === 'function'
    && typeof current.clear === 'function'
  if (complete) return current

  const shim = createStorageShim()
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: shim,
    })
  } catch {
    // Ignore read-only globals; tests that need storage will still use
    // globalThis.localStorage below when the window override is blocked.
  }
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: shim,
    })
  } catch {
    // Same read-only proxy guard as above.
  }
  return shim
}

const localStorageRef = ensureLocalStorage()
const _origRemoveItem = typeof localStorageRef.removeItem === 'function'
  ? localStorageRef.removeItem.bind(localStorageRef)
  : (_key: string): void => {}
function safeRemoveItem(key: string): void {
  try {
    _origRemoveItem(key)
  } catch {
    // swallow — matches our production fallback behavior
  }
}
try {
  localStorageRef.removeItem = safeRemoveItem
} catch {
  // Some runtimes expose localStorage through a read-only proxy.
}

// Cold-start + page i18n namespaces load async in production. Preload
// both languages and page ns here so route tests don't race the backend.
await bootstrapI18n('en')
await ensureLazyNamespacesLoaded()
