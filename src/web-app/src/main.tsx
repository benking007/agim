/**
 * agim web v2 — React entrypoint.
 *
 * Composition order (PR-4):
 *   <Providers> = QueryClientProvider + i18n bind + theme bind +
 *                 TooltipProvider + Toaster
 *   <App>      = current smoke route; replaced by RouterProvider in PR-5.
 *
 * `main.tsx` stays tiny on purpose — every additional concern goes
 * into providers.tsx or the eventual router config. Reading main.tsx
 * should reveal cold-start cost at a glance.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Providers } from './components/shell/providers'
import './styles/globals.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('agim: #root not found in index.html')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
)
