/**
 * Vitest configuration. Inherits Vite resolve aliases (so `@/...`
 * imports work in tests the same way they do at build time) and
 * runs in jsdom so DOM APIs (localStorage, document, etc.) are
 * available without a real browser.
 *
 * Note: we don't `import { mergeConfig } from 'vite'` and merge with
 * vite.config.ts because vite.config carries dev-only proxy + build
 * settings that don't apply to tests; replicating only the path
 * alias keeps the test runner lean.
 */

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: false,         // explicit `import { describe, it, expect } from 'vitest'`
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,             // skip CSS parsing in tests
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      exclude: [
        'src/main.tsx',
        'src/router.tsx',
        'src/components/ui/**',   // shadcn primitives — covered by integration
        'src/test/**',
        '**/*.config.*',
      ],
    },
  },
})
