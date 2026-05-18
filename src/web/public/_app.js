// Agim web console — shared utilities (theme / i18n / error boundary / api).
//
// Loaded as a CLASSIC script in <head> by every page before any page-specific
// code, so it sits in the same global lexical scope. Wrapped in an IIFE so the
// only thing that leaks is `window.imhub`.
//
// Served as `/_app.js` by web/server.ts. Page scripts should call `imhub.api`
// from inside DOMContentLoaded or a deferred script so `window.__lang` is set.

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
      const msg = r && (r.message || r.toString?.())
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
  const THEME_KEY = 'agim-theme'
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
  // Throws on non-2xx with the server-provided `error` field as the message
  // when present. Returns parsed JSON on success.
  async function apiFetch(path, init = {}) {
    const headers = { ...(init.headers || {}) }
    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
    // v1.1.10: attach the web access token from localStorage (set after a
    // successful /login). Cookie is also set by /api/auth/login, but adding
    // the header makes the API directly usable via curl + a bearer prefix.
    if (!headers['Authorization']) {
      try {
        const tk = localStorage.getItem('agim_token')
        if (tk) headers['Authorization'] = `Bearer ${tk}`
      } catch { /* ignore */ }
    }
    const res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
    if (res.status === 401) {
      // Token missing / invalid / expired — kick the user to /login.
      try { localStorage.removeItem('agim_token') } catch { /* ignore */ }
      const next = encodeURIComponent(location.pathname + location.search)
      location.href = `/login?next=${next}`
      const err = new Error('unauthorized')
      err.status = 401
      throw err
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
      const err = new Error(msg)
      err.status = res.status
      throw err
    }
    if (res.status === 204) return null
    const ct = res.headers.get('content-type') || ''
    return ct.includes('application/json') ? res.json() : res.text()
  }

  // ============================================================
  // Global fetch interceptor (v1.1.10)
  // ============================================================
  // Static pages (tasks.html / reminders.html / memos.html) often call
  // `fetch('/api/foo')` directly without going through apiFetch. Patch
  // window.fetch so the access token attaches automatically + 401 kicks
  // the user back to /login.
  ;(function installFetchAuth(){
    if (window.__agimFetchPatched) return
    window.__agimFetchPatched = true
    var origFetch = window.fetch.bind(window)
    window.fetch = function(input, init){
      var opts = init || {}
      var url = typeof input === 'string' ? input : (input && input.url) || ''
      // Only inject for same-origin API paths (/api/...) and the static
      // route serving — leave external fetches (CDN) alone.
      var isLocalApi = url.startsWith('/') || url.startsWith(location.origin)
      if (isLocalApi) {
        var headers = new Headers(opts.headers || (typeof input !== 'string' ? input.headers : undefined))
        if (!headers.has('Authorization')) {
          try {
            var tk = localStorage.getItem('agim_token')
            if (tk) headers.set('Authorization', 'Bearer ' + tk)
          } catch { /* ignore */ }
        }
        opts = Object.assign({}, opts, { headers, credentials: opts.credentials || 'same-origin' })
      }
      return origFetch(input, opts).then(function(res){
        if (res.status === 401 && isLocalApi && !url.startsWith('/api/auth/')) {
          try { localStorage.removeItem('agim_token') } catch {}
          var next = encodeURIComponent(location.pathname + location.search)
          // Only redirect from non-login pages to avoid loops.
          if (!location.pathname.startsWith('/login')) {
            location.href = '/login?next=' + next
          }
        }
        return res
      })
    }
  })()

  // ============================================================
  // Shell — unified topbar + design tokens for non-chat pages
  // ============================================================
  //
  // Goal: every secondary page (tasks / approvals / reminders / memos /
  // memory / workspace / observability / settings) shares the same
  // topbar instead of each rolling its own. Pages only ship their
  // domain content; navigation is one source of truth here.
  //
  // Usage from a page:
  //
  //   <body class="ag-shell">
  //     <!-- ag-topbar injected here -->
  //     <main>...page content...</main>
  //   </body>
  //   <script src="/_app.js"></script>
  //   <script>imhub.shell.mount({ active: 'tasks' })</script>
  //
  // The nav definition lives here so adding a new page is a one-line
  // change (NAV.push(...)). Order = visual order; the `groupAfter`
  // flag inserts a 1px divider before the item so daily tools / assets
  // / observability stay visually segmented even on one row.
  const NAV = [
    { id: 'chat',          href: '/',              icon: '💬', en: 'Chat',         zh: '对话' },
    { id: 'tasks',         href: '/tasks',         icon: '📋', en: 'Tasks',        zh: '任务' },
    { id: 'approvals',     href: '/approvals',     icon: '🔐', en: 'Approvals',    zh: '审批' },
    { id: 'reminders',     href: '/reminders',     icon: '🔔', en: 'Reminders',    zh: '提醒' },
    { id: 'memos',         href: '/memos',         icon: '📝', en: 'Memos',        zh: '备忘' },
    { id: 'memory',        href: '/memory',        icon: '🧠', en: 'Memory',       zh: '记忆', groupAfter: true },
    { id: 'workspace',     href: '/workspace',     icon: '📂', en: 'Workspace',    zh: '工作区' },
    { id: 'observability', href: '/observability', icon: '📊', en: 'Observability',zh: '观测' },
    { id: 'settings',      href: '/settings',      icon: '⚙️', en: 'Settings',     zh: '设置', groupAfter: true, align: 'right' },
  ]

  function ensureShellCss() {
    if (document.getElementById('ag-shell-css-link')) return
    const link = document.createElement('link')
    link.id = 'ag-shell-css-link'
    link.rel = 'stylesheet'
    link.href = '/_shell.css'
    document.head.appendChild(link)
  }

  function renderTopbar({ active }) {
    const lang = (window.__lang === 'zh') ? 'zh' : 'en'
    const bar = document.createElement('header')
    bar.className = 'ag-topbar'
    bar.setAttribute('role', 'navigation')

    // Brand at the far left links to the chat page — discoverable
    // "go home" affordance.
    const brand = document.createElement('a')
    brand.className = 'ag-topbar__brand'
    brand.href = '/'
    brand.innerHTML = '<span style="font-size:18px">🤖</span><span>Agim</span>'
    bar.appendChild(brand)

    // Main nav (chat is doubled as brand → exclude from the nav list to
    // avoid a duplicate active state)
    const nav = document.createElement('nav')
    nav.className = 'ag-topbar__nav'
    for (const item of NAV) {
      if (item.id === 'chat') continue           // brand stands in
      if (item.align === 'right') continue       // handled below
      const a = document.createElement('a')
      a.className = 'ag-topbar__nav-item'
      if (item.id === active) a.classList.add('is-active')
      a.href = item.href
      a.title = item[lang]
      a.innerHTML = `<span class="ag-topbar__nav-icon">${item.icon}</span><span>${item[lang]}</span>`
      nav.appendChild(a)
    }
    bar.appendChild(nav)

    // Right-aligned controls: theme toggle, lang select, right-aligned
    // nav items (settings).
    const actions = document.createElement('div')
    actions.className = 'ag-topbar__actions'

    const themeBtn = document.createElement('button')
    themeBtn.type = 'button'
    themeBtn.className = 'ag-topbar__action'
    themeBtn.setAttribute('data-shell-theme-toggle', '')
    actions.appendChild(themeBtn)

    const langWrap = document.createElement('label')
    langWrap.className = 'ag-topbar__action'
    const langSel = document.createElement('select')
    langSel.setAttribute('data-shell-lang-select', '')
    langSel.innerHTML = '<option value="en">EN</option><option value="zh">中文</option>'
    langWrap.appendChild(langSel)
    actions.appendChild(langWrap)

    for (const item of NAV) {
      if (item.align !== 'right') continue
      const a = document.createElement('a')
      a.className = 'ag-topbar__action'
      a.href = item.href
      a.title = item[lang]
      a.innerHTML = `<span>${item.icon}</span><span>${item[lang]}</span>`
      if (item.id === active) a.style.color = 'var(--ag-accent)'
      actions.appendChild(a)
    }

    bar.appendChild(actions)
    return bar
  }

  /**
   * Inject the shared topbar + design tokens at the top of <body>.
   * Pages may pass `active` to highlight the current nav item. Replaces
   * any element marked `data-shell-replace` so a page can render a
   * placeholder server-side and have it swapped on script load — keeps
   * the no-JS render from showing nothing.
   *
   * Safe to call multiple times; subsequent calls just refresh the
   * active state.
   */
  function mountShell(opts = {}) {
    ensureShellCss()
    document.body.classList.add('ag-shell')

    const existing = document.getElementById('ag-topbar')
    if (existing) existing.remove()

    const bar = renderTopbar({ active: opts.active || '' })
    bar.id = 'ag-topbar'

    const placeholder = document.querySelector('[data-shell-replace]')
    if (placeholder) {
      placeholder.replaceWith(bar)
    } else {
      document.body.prepend(bar)
    }

    // Wire theme toggle to the existing helper.
    const themeBtn = bar.querySelector('[data-shell-theme-toggle]')
    if (themeBtn) bindThemeToggle(themeBtn)

    // Wire lang select. We persist via the same `im-hub-lang` key all
    // existing pages read at the top of their <head> IIFE — see
    // tasks.html / reminders.html for the read path. Reload so that
    // pre-script IIFE rebuilds the i18n table for the new language.
    const langSel = bar.querySelector('[data-shell-lang-select]')
    if (langSel) {
      const cur = (window.__lang === 'zh') ? 'zh' : 'en'
      langSel.value = cur
      langSel.addEventListener('change', () => {
        try { localStorage.setItem('im-hub-lang', langSel.value) } catch { /* ignore */ }
        location.reload()
      })
    }
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
    shell: { mount: mountShell, NAV },
  })
})()
