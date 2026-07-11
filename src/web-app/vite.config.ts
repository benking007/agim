import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const VENDOR_CHUNKS = {
  react: ['react', 'react-dom', 'scheduler'],
  router: ['@remix-run/router', 'react-router', 'react-router-dom'],
  query: ['@tanstack/query-core', '@tanstack/react-query'],
  i18n: [
    'i18next',
    'i18next-browser-languagedetector',
    'i18next-http-backend',
    'react-i18next',
  ],
  'ui-runtime': [
    '@floating-ui/core',
    '@floating-ui/dom',
    '@radix-ui',
    'aria-hidden',
    'react-remove-scroll',
    'sonner',
  ],
} as const

function vendorChunk(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/')
  for (const [chunk, packages] of Object.entries(VENDOR_CHUNKS)) {
    if (packages.some((pkg) => normalized.includes(`/node_modules/${pkg}/`))) return chunk
  }
  return undefined
}

/**
 * Vite config for the agim web v2 SPA.
 *
 * Dev:   vite dev (5173) proxies /api/* /ws /events to the agim backend
 *        running on http://localhost:3000.
 * Build: vite build → ./dist (consumed by root `npm run build` which
 *        copies dist/* into ../web/public/ to ride along with agim-cli's
 *        existing static-file server).
 *
 * `base: '/'` because the agim backend serves the SPA from the site
 * root; no sub-path mounting.
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    // Inline assets under 4KB to cut HTTP requests on mobile networks.
    assetsInlineLimit: 4096,
    rollupOptions: {
      // Stable chunk names so the agim backend's static-file cache stays
      // hot across releases (only the hashed asset chunks change).
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api':     { target: 'http://localhost:3000', changeOrigin: false },
      '/ws':      { target: 'ws://localhost:3000', ws: true },
      '/events':  { target: 'http://localhost:3000', changeOrigin: false },
      // Legacy single files that the SPA may still touch during the
      // M1-M3 transition window (deleted in M4).
      '/_app.js':   { target: 'http://localhost:3000', changeOrigin: false },
      '/_shell.css':{ target: 'http://localhost:3000', changeOrigin: false },
      '/vendor':    { target: 'http://localhost:3000', changeOrigin: false },
      // SSR public pages stay on the backend.
      '/loc':       { target: 'http://localhost:3000', changeOrigin: false },
      '/l':         { target: 'http://localhost:3000', changeOrigin: false },
      '/v':         { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
})
