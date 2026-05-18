/**
 * agim web v2 — React entrypoint.
 *
 * M1 PR-1 deliberately keeps this minimal:
 *   - Mount App into #root
 *   - Pull in globals.css (tokens + Tailwind layers)
 *
 * Subsequent PRs layer on QueryClientProvider, RouterProvider,
 * I18nProvider, ThemeProvider in this exact spot. Keeping main.tsx tiny
 * and route assembly elsewhere (routes/) makes the cold-start cost
 * obvious at a glance.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('agim: #root not found in index.html')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
