/**
 * agim web v2 — React entrypoint.
 *
 * Composition order (PR-5):
 *   <Providers>     QueryClient + i18n bind + theme bind + auth bind
 *                   + TooltipProvider + Toaster
 *   <AppRouter>    react-router config (login / home / 404)
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppRouter } from './router'
import { Providers } from './components/shell/providers'
import './styles/globals.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('agim: #root not found in index.html')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Providers>
      <AppRouter />
    </Providers>
  </React.StrictMode>,
)
