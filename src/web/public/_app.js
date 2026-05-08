// im-hub-pro web console — shared utilities (theme / i18n / error boundary / api).
//
// Loaded as a CLASSIC script in <head> by every page before any page-specific
// code, so it sits in the same global lexical scope. Wrapped in an IIFE so the
// only thing that leaks is `window.imhub`.
//
// IMPORTANT: this file is served as `/_app.js` by web/server.ts. It does NOT
// have access to `window.IMHUB_TOKEN` until the inline <script> tag inside
// each page <head> runs — make sure `imhub.api(...)` is only called after
// the inline token bootstrap has executed (i.e. from inside DOMContentLoaded
// or a deferred page script). Reading `window.__lang` follows the same rule.

(() => {
  // ============================================================
  // Error boundary
  // ============================================================
  // Sticky red banner at the top of the viewport whenever a script error
  // or unhandled promise rejection escapes the page-level try/catch. The
  // tasks.html SyntaxError that produced a fully blank page (because the
  // script that fills tab labels / button text never ran) was the
  // motivating example — silent JS death must surface visually.
  let errorBar = null
  function showError(msg) {
    if (!errorBar) {
      errorBar = document.createElement('div')
      errorBar.id = 'imhub-error-bar'
      errorBar.setAttribute('role', 'alert')
      errorBar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'padding:8px 16px', 'background:#dc3545', 'color:#fff',
        'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.25)',
        'display:flex', 'align-items:center', 'gap:12px',
      ].join(';')
      errorBar.innerHTML =
        '<span style="flex:1;white-space:pre-wrap;word-break:break-word" data-imhub-error-msg></span>'
        + '<button data-imhub-error-close style="background:rgba(255,255,255,.18);'
        + 'color:#fff;border:none;padding:4px 10px;border-radius:3px;cursor:pointer">'
        + '×</button>'
      const init = () => {
        if (!document.body) return setTimeout(init, 30)
        document.body.prepend(errorBar)
        errorBar.querySelector('[data-imhub-error-close]')
          .addEventListener('click', () => { errorBar.remove(); errorBar = null })
      }
      init()
    }
    const slot = errorBar?.querySelector('[data-imhub-error-msg]')
    if (slot) slot.textContent = String(msg).slice(0, 600)
  }

  function installErrorBoundary() {
    window.addEventListener('error', (e) => {
      const file = (e.filename || '?').split('/').pop()
      showError(`JS error: ${e.message} (${file}:${e.lineno})`)
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      const msg = r && (r.message || r.toString && r.toString())
      showError(`Unhandled rejection: ${msg ?? '(no message)'}`)
    })
  }
  installErrorBoundary()

  // ============================================================
  // Theme manager (light / dark / system three-state)
  // ============================================================
  // Three-state toggle persists in localStorage. `system` removes
  // `[data-theme]` and lets `prefers-color-scheme` decide; `light` /
  // `dark` set the attribute explicitly so CSS `:root[data-theme="..."]`
  // selectors win regardless of OS preference.
  //
  // Applied as early as possible (before first paint) so the page doesn't
  // flash the wrong theme on load. This file is loaded synchronously in
  // <head> precisely for that reason.
  const THEME_KEY = 'im-hub-pro-theme'
  const VALID_MODES = ['system', 'light', 'dark']

  function getThemeMode() {
    const stored = localStorage.getItem(THEME_KEY)
    return VALID_MODES.includes(stored) ? stored : 'system'
  }

  function applyTheme() {
    const mode = getThemeMode()
    if (mode === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', mode)
  }

  function setThemeMode(mode) {
    if (!VALID_MODES.includes(mode)) mode = 'system'
    if (mode === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, mode)
    applyTheme()
  }

  function cycleThemeMode() {
    const cur = getThemeMode()
    const next = VALID_MODES[(VALID_MODES.indexOf(cur) + 1) % VALID_MODES.length]
    setThemeMode(next)
    return next
  }

  function bindThemeToggle(el) {
    if (!el) return
    const ICONS = { system: '🖥', light: '☀', dark: '🌙' }
    const LABELS = {
      en: { system: 'System', light: 'Light', dark: 'Dark', tip: 'Click to cycle theme' },
      zh: { system: '跟随系统', light: '浅色', dark: '深色', tip: '点击切换主题' },
    }
    const lang = (window.__lang === 'zh') ? 'zh' : 'en'
    const L = LABELS[lang]
    function refresh() {
      const m = getThemeMode()
      el.innerHTML = `<span style="font-size:14px">${ICONS[m]}</span> <span>${L[m]}</span>`
      el.title = `${L[m]} — ${L.tip}`
      el.setAttribute('data-theme-mode', m)
    }
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => { cycleThemeMode(); refresh() })
    // Refresh when the OS preference flips (relevant only when mode='system').
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', refresh)
    }
    refresh()
  }

  applyTheme()

  // ============================================================
  // i18n (data-attribute driven)
  // ============================================================
  // Replaces the previous N×getElementById().textContent= boilerplate.
  // Pages mark elements with `data-i18n="key"` (sets textContent) and
  // optional `data-i18n-attr="placeholder:key1;title:key2"` (sets one or
  // more attributes from the same dictionary). Missing keys leave the
  // element's existing text/attribute intact, so a partial dictionary
  // doesn't blank out the UI.
  function applyI18n(T, root = document) {
    if (!T || typeof T !== 'object') return
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      if (key && T[key] !== undefined) el.textContent = T[key]
    })
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const spec = el.getAttribute('data-i18n-attr') || ''
      for (const pair of spec.split(';')) {
        const [attr, key] = pair.split(':').map((s) => (s || '').trim())
        if (attr && key && T[key] !== undefined) el.setAttribute(attr, T[key])
      }
    })
  }

  // ============================================================
  // API helper
  // ============================================================
  // Auto-attaches X-IM-Hub-Token header. Throws on non-2xx with the
  // server-provided `error` field as the message when present. Always
  // returns parsed JSON on success — pages handle data shape themselves.
  async function apiFetch(path, init = {}) {
    const headers = {
      'X-IM-Hub-Token': window.IMHUB_TOKEN || '',
      ...(init.headers || {}),
    }
    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
    const res = await fetch(path, { ...init, headers })
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try { const j = await res.json(); if (j && j.error) msg = j.error } catch { /* ignore */ }
      const err = new Error(msg)
      err.status = res.status
      throw err
    }
    if (res.status === 204) return null
    const ct = res.headers.get('content-type') || ''
    return ct.includes('application/json') ? res.json() : res.text()
  }

  // ============================================================
  // Expose
  // ============================================================
  window.imhub = Object.freeze({
    showError,
    theme: {
      get: getThemeMode,
      set: setThemeMode,
      cycle: cycleThemeMode,
      bindToggle: bindThemeToggle,
      apply: applyTheme,
    },
    i18n: { apply: applyI18n },
    api: apiFetch,
  })
})()
