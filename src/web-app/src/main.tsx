/**
 * Agim web SPA entrypoint.
 *
 * Composition order:
 *   bootstrapI18n()  load common/errors for the active language
 *   <Providers>      QueryClient + i18n bind + theme bind + auth bind
 *                    + TooltipProvider + Toaster
 *   <AppRouter>      react-router config (login / home / 404)
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppRouter } from './router'
import { Providers } from './components/shell/providers'
import { ensureCjkFonts } from './lib/ensure-cjk-fonts'
import { bootstrapI18n } from './i18n'
import './styles/globals.css'

ensureCjkFonts()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('agim: #root not found in index.html')

void bootstrapI18n().then(() => {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <Providers>
        <AppRouter />
      </Providers>
    </React.StrictMode>,
  )
})
