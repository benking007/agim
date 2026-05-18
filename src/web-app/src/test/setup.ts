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

// Make sure private-mode style storage exceptions don't bubble into
// tests as uncaught errors. Tests that want to assert the catch
// behavior should spy on the specific call.
const _origRemoveItem = window.localStorage.removeItem.bind(window.localStorage)
window.localStorage.removeItem = (key: string) => {
  try {
    return _origRemoveItem(key)
  } catch {
    // swallow — matches our production fallback behavior
  }
}
