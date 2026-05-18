# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Largest single batch since v1.0 — 10 commits closing 17 of 17 reachable
findings from the 2026-05-18 code review (plus a full Web console UI
rework). 42 files, +4494/−420 lines, 113 new tests, 1127 pass / 0 fail.
Full report: [`docs/code-review-2026-05-18-main.md`](./docs/code-review-2026-05-18-main.md).

### Security — Web / auth surface

- **Session cookie hardened.** `agim_token` cookie now sets `HttpOnly`
  unconditionally and `Secure` when the request looks HTTPS
  (`req.socket.encrypted` or `x-forwarded-proto: https`). The front-end
  uses localStorage + `Authorization: Bearer`, so `HttpOnly` does not
  break the UI. Override with `IMHUB_WEB_COOKIE_SECURE=auto|on|off`.
- **Loopback bypass is now reverse-proxy-aware.** When `IMHUB_WEB_BIND`
  is public (`0.0.0.0` or a routable IP), `req.socket.remoteAddress ==
  127.0.0.1` is no longer auto-trusted — without this, an nginx/Caddy
  on the same host effectively forwarded auth to anyone it let through.
  Override with `IMHUB_TRUST_LOOPBACK=auto|on|off`.
- **ACP CORS allowlist.** Default is now no CORS headers; browser
  callers opt in via `IMHUB_ACP_CORS_ORIGINS=https://a.com,https://b.com`
  (or `*` to keep the legacy wildcard). Server-to-server and curl
  callers were never subject to CORS and are unaffected.
- **Admin bootstrap token uses `safeEqual`.** Constant-time comparison
  uniform with `access-token.ts` / `acp-server.ts`, so any future REST
  surface that touches the path inherits the safe default.

### Security — Approval bus / RPC

- **`_im_context` fallback gated.** `reminder` and `memo` RPCs let any
  agent sending a `_im_context` payload assert its `userId` — fine in
  single-user mode, dangerous when an MCP daemon is shared across users
  (the opencode HTTP bridge shape). New `IMHUB_RPC_INLINE_CTX_MODE=off`
  rejects the fallback; default `single-user` preserves current
  behavior. Push RPC was already refusing the fallback.
- **Protocol error frames on unsupported version.** Frames with `v !== 1`
  used to be silently dropped; a future v2-speaking sidecar would then
  hang on its 30-min MCP timeout per `reqId`. Now echoes a v1 `error`
  frame back, mirroring `reqId` when present.
- **Heartbeat / dead-peer detection.** Each socket gets a periodic
  liveness sweep: if a connection owns pending approvals and has been
  silent for 60s, the bus sends `ping`; if no inbound traffic within
  30s, the socket is torn down and its pendings denied. Sidecars that
  don't know about `ping` keep working (any inbound frame refreshes
  liveness). Wedged-sidecar pending now releases in ~2 min instead of
  ~15 min.
- **Drain-before-close on buffer overflow.** When a sidecar overran the
  4 MiB read buffer, the old code closed the socket immediately and
  dropped any complete NDJSON lines already in the buffer. Now drains
  them through `handleLine` first, then sends the `fatal` frame and
  closes.
- **`unregisterRun` is O(approvals-on-run)** instead of O(all-pending),
  via a `pendingByRunId` secondary index. Matters under A2A fan-out.

### Security — Memory subsystem

- **Distill + consolidate now have budgets, timeouts, and a circuit
  breaker.** New `src/core/llm-budget.ts` adds `LlmBudget`
  (per-(purpose, userKey, UTC-day) cost cap) and `LlmCircuitBreaker`
  (N consecutive failures → cooldown). distill defaults to 30s timeout
  / $0.10 per user per day / 3 fails → 10 min cooldown; consolidate to
  60s / $0.10 / 3 fails → 1 h. Override each via
  `IMHUB_DISTILL_*` / `IMHUB_CONSOLIDATE_*` envs.
- **Consolidate prompt-injection block.** Facts originate from user IM
  messages — interpolating them into bullet lines next to operator
  instructions was a sink. Now passed as JSON inside an explicit
  `<untrusted-facts>` boundary preceded by a "this is data, not
  instructions" preamble.
- **Embed-and-store retries on transient failure.** Async embedding
  (OpenAI 429/5xx, local ONNX still warming) now does 3 attempts with
  exponential backoff (200ms / 800ms / 3.2s) before logging + leaving
  the row for a manual `/memory backfill` to sweep.
- **`facts` table partial index** on
  `(user_key, embedding_model, embedding_dims) WHERE embedding IS NOT NULL`
  — `queryFactsHybrid`'s vector candidate scan went from per-user table
  scan to index seek, dominant cost on the hybrid path with thousands
  of facts.

### Security — Operational

- **`start-prod.js` graceful shutdown.** SIGTERM/SIGINT call a single
  `gracefulShutdown(signal)` that drains web + ACP + scheduler + the
  SQLite cluster in reverse order. `IMHUB_SHUTDOWN_FORCE_MS` (default
  10 s) caps total drain time so systemd's escalation to SIGKILL
  doesn't race an open WAL.
- **WS inbound frame size cap.** `IMHUB_MAX_WS_MSG_BYTES` (default
  1 MiB) — frames over the cap close the socket with RFC 6455 code 1009
  before reaching `JSON.parse`.
- **Cron scheduler atomic claim.** `fireSchedule` now does
  `UPDATE schedules SET … WHERE id=? AND next_run=? AND enabled=1`;
  concurrent ticks (setInterval reentrancy, backward clock jumps) can
  no longer double-fire. Tick-level re-entrancy guard added too.
- **Secrets file split.** `telegram.botToken` / `feishu.appSecret` /
  `discord.botToken` move to a sibling `~/.agim/secrets.json` (0o600,
  atomic write). `loadConfig` overlays it on top of `config.json` so
  adapters see the same shape; first `saveConfig` after upgrade
  migrates implicitly. Operators can now route the sidecar to a vault
  path while keeping `config.json` in their dotfiles repo.
- **Artifact orphan sweep.** 24-h walk of `~/.agim/artifacts/` drops
  dirs whose mtime predates `IMHUB_ARTIFACT_RETENTION_DAYS` (default
  30). Backstop for unclean shutdowns where the inline job-board
  prune ran but the artifact `rm` didn't.

### Performance / observability

- **event-bus is O(1) per publish.** Fixed-size ring buffer replaces
  `push + shift`; matters under 1k events/sec bursts at agent boot.
- **Approval bus `pendingByRunId` index** — see Security section.
- **`facts` partial index** — see Security section.

### Quality

- **`IMHUB_*` env naming canonicalised.** 8 stragglers that landed as
  `IM_HUB_*` (e.g. `IM_HUB_AUDIT_RETENTION_DAYS`) now read the canonical
  `IMHUB_*` form first; the legacy alias still works but emits a
  one-time deprecation warn.
- **Clock abstraction primitive.** New `src/core/clock.ts` `nowMs()` /
  `setNow(fixed|null)` so tests can freeze time without monkey-patching
  `Date.now()` globally. Consumer migration is opt-in module-by-module.

### Web console — IA + visual rework

- **`/tasks` no longer a 13-tab catch-all.** Four new top-level URLs
  carved out:
  - `/approvals` — pending approvals (was a tab)
  - `/memory` — facts + persona + skills (was 2 tabs)
  - `/workspace` — agent working directories (was a tab)
  - `/observability` — health + audit + cost (was 3 tabs)

  `/tasks` keeps only the actual task domain: jobs, subtasks,
  schedules, background scripts, outbox, A2A. Each URL is now
  deep-linkable and unambiguous.

  Implementation: server `fileMap` routes all four new URLs to
  `tasks.html`; the page reads `location.pathname` into a `PAGE_MODE`
  struct that hides out-of-scope tabs and collapses the tab bar when
  a mode has only one tab. 3700 lines of domain JS untouched.

- **Unified shell topbar.** `imhub.shell.mount({ active })` (in
  `_app.js`) injects the same topbar on every secondary page — single
  source of truth for the 8 nav destinations + theme cycle + language
  switcher.

- **Canonical design tokens + component classes.** New
  `src/web/public/_shell.css` ships `--ag-*` tokens (light + dark
  palettes) and `.ag-topbar` / `.ag-card` / `.ag-btn` / `.ag-table` /
  `.ag-badge` / `.ag-subnav` / `.ag-modal` / `.ag-form-row` / `.ag-stat`
  primitives. Legacy class names (`.stats`, `.toolbar`, `.data-table`,
  `.tabs`, `.pill`, `.modal-bg`, `.filter-btn`) get scoped overrides
  under `body.ag-shell` so existing markup picks up the new look
  without touching class attributes.

- **Memory page reordered.** User picker → Persona → Facts → vector
  backend (collapsed `<details>`). The previous order led with a
  60-line one-time-setup card; the daily workflow now sits above the
  fold. All element IDs preserved — existing JS handlers fire
  unchanged.

- **Chat page (`/`) header visually aligned.** Sticky 56px header, the
  shell's `--ag-*` tokens, shell-style action buttons for the 8 nav
  destinations. Does not adopt `body.ag-shell` — the chat surface has
  bespoke message-stream layout that the global legacy overrides would
  interfere with — but consumes the same palette and spacing scale.

- **Page subtitles.** Every secondary page now renders a one-line
  "what is this page for" subtitle under its title; new i18n keys
  (`navTasksSub` / `navApprovalsSub` / `navMemorySub` /
  `navWorkspaceSub` / `navObservabilitySub`) for both languages.

### Verified-already-fixed (no code change, prevents spurious changelog churn)

The 2026-05-18 review subagents flagged these as needing fixes; main-
thread verification found existing code already addresses each one:

- `reminders.tick` already uses atomic CAS (`reminders.ts:977-980`).
- `/cron create` already enforces workspace whitelist
  (`commands/cron.ts:76`); `createSchedule` has no other call sites.
- `verifyTokenSync` startup race doesn't exist —
  `_tokenModule = await import(...)` resolves before
  `httpServer.listen` (`server.ts:277` vs `986`).

## [1.2.2] - 2026-05-17

Three small but noticeable hotfixes on top of 1.2.1:

### Added — Admin invite from CLI / interactive menu

Onboarding the FIRST admin uses an auto-generated bootstrap token. Adding
MORE admins after the fact required either editing `~/.agim/env` by hand
or having the new admin send their `platform:userId` to the existing
admin so it could be typed into the web Safety card. Tedious.

- `agim admin invite` (CLI) — generates a fresh single-use token,
  overwrites `~/.agim/admin-bootstrap-token`, and prints
  `/setup admin <token>` ready to forward to the invitee.
- `agim admin list` (CLI) — show current allowlist (env + runtime).
- Entry menu (bare `agim`) gains "邀请新管理员 / Invite a new admin"
  between "Manage web access tokens" and "Uninstall".
- Reuses the existing `/setup admin <token>` IM flow — no IM-side code
  changes; works on every messenger the bot is on.
- Invite tokens stay single-use and overwrite the previous unconsumed
  one, so abandoned invites can't accumulate.

### Changed — Vector backend eager-warm at boot

`LocalBgeBackend`'s autowarm (1.2.1) only fired when `getActiveBackend()`
was first called — i.e. on the first inbound message OR the first Memory
tab visit. In quiet periods the backend stayed cold and the status badge
showed "未就绪" until something poked it.

- `cli.ts` boot now calls `getActiveBackend()` once after `setBootPhase('ready')`
  when memory is enabled, triggering the constructor's autowarm
  immediately. Status badge flips to `↻ 加载中…` → `✓ ready` within a
  few seconds of restart.

### Changed — Async consolidate (no more "失败: 554" timeout)

`POST /api/memory/consolidate` used to hold the connection for the full
30–60s LLM call. Intermediate proxies / cloudflare / browser fetch
defaults would close the connection long before the work finished,
surfacing as a cryptic "失败: 554" in the UI even when the persona was
actually rebuilt.

- Endpoint now returns `202 + { jobId }` immediately and runs the
  consolidation in the background.
- New `GET /api/memory/consolidate/status` returns the recent jobs +
  phase (`running` / `done` / `failed`).
- Memory tab button polls every 2s, shows elapsed seconds during
  `running`, terminal text on completion. 5min poll cap; UI hint to
  refresh if exceeded.
- Concurrent click protection: a 2nd POST while one is `running`
  returns the same `jobId`.

## [1.2.1] - 2026-05-17

Hotfix for two issues found right after 1.2.0 went live.

### Fixed — Vector backend stays "not ready" after restart

The local BGE backend's `ready` flag only flipped to true after `embed()` /
`test()` / `download` actively loaded the pipeline. On every service
restart it reset to false — even when the model files were sitting in
`~/.agim/cache/transformers/`. Result: saveFact silently skipped embedding
writes until the user clicked something.

- `LocalBgeBackend` constructor now auto-warms (fire-and-forget
  `ensureReady()`) when `isDownloaded()` is true, so the in-memory pipeline
  loads within seconds of boot.
- New `downloaded: true | false` field on the backend status; UI shows
  `↻ local · 模型已下载，加载中…` (amber) during the warmup window
  instead of the misleading `○ local · 未就绪`.
- Initial `isDownloaded()` used `require()` inside an ESM module — the
  ReferenceError was caught by a try/catch and returned false silently.
  Replaced with static `import { existsSync } from 'node:fs'`.

### Fixed — Cost & Health / Memory tab labels untranslated

Tab nav buttons `tab-cost` / `tab-memory` had hardcoded English text in
the HTML and weren't in the explicit `textContent = T.tabsXxx` boot
sweep. Other tabs are filled by JS at boot; these two were missed.
Added `tabsCost` + `tabsMemory` to en/zh dicts and wired the assignments.

## [1.2.0] - 2026-05-17

The biggest agim release since 1.0: long-term memory, agent-initiated push,
a Cost & Health dashboard, native inline-button recovery cards on Telegram,
and a handful of P0 / P1 hardening fixes uncovered in pre-release CR.

### Added — Long-term memory (`memory.db`)

Persistent per-user fact store + auto-distilled "persona" summary that gets
injected into every agent prompt. Default OFF; opt in via Settings →
**自动化记忆** toggle (or `IMHUB_MEMORY_ENABLED=1`).

- **Storage**: `~/.agim/memory.db` (SQLite). FTS5 index for keyword recall.
  Per-user partition key `${platform}:${userId}` so the same human across
  multiple IMs converges to one memory.
- **Auto-distillation**: after each agent reply, a small JSON-extraction
  prompt runs on the SAME agent (no Claude lock-in) and writes 0–5 facts
  to the user's row. Fire-and-forget; never blocks the user.
- **Daily consolidation cron**: rebuilds the persona summary from the
  newest 50 facts so the always-on snippet stays small (~150–300 tokens).
- **4 MCP tools** so agents can introspect / extend memory:
  `mcp__imhub__memory_query`, `_save`, `_list`, `_delete`.
- **Web admin tab** (`/tasks#memory`): per-user user selector → persona
  text editor + paginated facts table with FTS5 search + bulk-delete
  filters + JSON export.
- **Slash command** `/memo …` still works — writes go to memory.db now.

### Added — Vector retrieval (optional)

Layer dense-vector recall on top of FTS5 for synonym / cross-lingual /
conceptual queries. Default OFF; opt in per user via the Memory tab's
🔍 vector card. Two backends:

- **Local BGE** (`@xenova/transformers` + Xenova BGE-zh ONNX): one-time
  ~100 / 250 / 500 MB download (small / base / large preset). Runs fully
  offline after that. CPU inference, no GPU required.
- **OpenAI-compatible** (`baseUrl + model + apiKey`): works with the
  OpenAI cloud, Azure, Ollama, 智谱 — anyone serving `/v1/embeddings`.

Reciprocal-Rank-Fusion (k=60) merges FTS5 + vector top-K into a single
ranked list. Backfill button generates embeddings for existing facts.
Clear button wipes the index when switching backends (different model =
incompatible vector space).

### Added — Agent-initiated push (`mcp__imhub__push_message`)

Lets a running agent push a follow-up message back into the IM thread
without an inbound trigger. Useful for long-running jobs ("CI green") or
schedule-aware notifications.

- Per-user rate limit (`IMHUB_PUSH_RATE_PER_HOUR`, default 20).
- Cross-thread push gated by `IMHUB_PUSH_CROSS_THREAD` (default off:
  push must target the same thread the run started in).
- `POST /api/notify` HTTP endpoint exposes the same primitive for
  webhooks / cron / external tools.

### Added — Cost & Health dashboard (`/tasks#cost`)

Per-day spend / calls / errors / p95 latency from the audit log.

- Window selector: 1 / 7 / 30 / 90 days.
- KPI cards: total spend, p95 latency, error rate.
- Daily trend chart with metric toggle (calls / cost / errors / avg latency).
- Top-N by user / agent / platform with ordering toggle.
- Claude per-run cost now auto-extracted from `--output-format json` and
  fed into `audit-log` (Claude was previously the only adapter not
  reporting cost — now matches OpenAI / Codex / Copilot).

### Added — Recovery card with inline buttons (Telegram, Feishu)

The 1.1.x crash-recovery flow used to send a plain "回复 1 重发 / 2 取消"
text prompt. v1.2.0 now sends a **native inline-button card** on
adapters that support it (`sendChoiceCard`); falls back to text on
WeChat-iLink / DingTalk where buttons aren't a primitive.

- Tap `🔁 重发` → original prompt re-runs in the same thread.
- Tap `✖ 取消` → row marked cancelled.
- Buttons disappear after a tap (card edited to terminal text) so a
  stale tap can't double-fire.
- Text reply ("1" / "重发") also edits the card to the same terminal
  state — no orphan buttons after the choice is already made.
- Group-chat safety: only the original requester (`creator_id`) can
  resolve the card; bystanders get a toast "只有发起者可以处理".

### Changed — Web auth / env editor

- `IMHUB_MEMORY_VECTOR_OPENAI_API_KEY` joins the SECRET_KEYS allowlist:
  masked on GET, click-to-reveal for editing, masked-value writes are
  no-ops (defense in depth so a stale masked echo can't overwrite).
- `PUT /api/env` rejects masked echoes for any secret key (was only
  protected for nested telegram/feishu structs before).
- Restart UX: spawn detached + unref so the HTTP response returns
  immediately; client polls `bootPhase` not just HTTP-up. The IM ack
  ("重启中…") now arrives before the web button visibly updates.

### Fixed — Pre-release CR (P0 / P1 hardening)

- **P0** persona-injection sanitization: stored facts containing
  `[/long-term memory]` / `<system>` markers no longer escape the
  always-on memory envelope (persona.ts).
- **P0** memory + push: removed agent-asserted `_im_context` fallback
  in approval-bus to prevent a shared-MCP daemon (opencode-style) from
  spoofing userId across users. Reminder + memo still keep the fallback
  (single-user MCP daemons).
- **P0** recovery `🔁 重发` button used to create the replacement
  inline-job row but never run the agent (orphan row stayed pending).
  Now invokes an executor cli.ts registers at boot that synthesizes a
  MessageContext and runs handleMessage.
- **P0** `bufferToFloat32` crash from better-sqlite3's non-aligned
  BLOB buffer (memory-vector.ts) — copy into a fresh ArrayBuffer first.
- **P1** FTS5 `MATCH` injection: wrap user queries in `"…"` so `C++`,
  `foo:bar`, `(`, `OR`, etc. stop crashing the prepared statement.
- **P1** CJK tokenization: pre-tokenize by inserting spaces between
  adjacent CJK chars so "杭州" actually matches a fact indexed as
  "用户在杭州工作" (unicode61 doesn't bigram CJK).
- **P1** hybrid retrieval now filters candidates by
  `embedding_model = active`, not just `embedding_dims`, so swapping
  vector backends doesn't poison the cosine ranking with stale vectors.
- **P1** silent-embed-skip: warn once per session when a fact saves
  without an embedding because the vector backend is configured but
  not ready.
- **P1** distill call now passes `onUsage` + writes an audit row
  (intent=`memory.distill`) so memory cost shows up in Cost & Health.
- **P1** saveFact / deleteFact wrapped in transactions so a crash
  between row and FTS index leaves no orphan rows.
- **P1** Telegram `editChoiceCard` classifies errors: not-modified /
  gone / too-old / rate-limited are silent; only "other" warns.
- **P1** vector download / backfill in-flight check prevents concurrent
  jobs from racing on the model cache.
- **P1** Memory tab auto-stops its 2 s status poller once nothing is
  running; skips loading the vector card when memory is disabled.

### Changed — Telemetry / data

- `IMHUB_MEMORY_*` env keys editable via `PUT /api/env`.
- `~/.agim/memory.db` is new; safe to delete — recreated on next save.
- Vector cache: `~/.agim/cache/transformers` (BGE ONNX model files).
- `audit-log` adds `intent='memory.distill'` rows so distillation cost
  is filterable in Cost & Health.

## [1.1.11] - 2026-05-17

### Fixed — Viewer page unreadable in OS dark mode

`/v/:id` loaded `github-markdown-light.min.css` + `highlight.js github.min.css`
— both light-mode-only stylesheets. When the user's OS / browser was in
dark mode, the page background flipped (via our custom dark-mode CSS) but
the markdown body kept its hard-coded dark text on the new dark background,
rendering as low-contrast grey-on-black.

Fix: switch to `github-markdown-css`'s auto-mode bundle (`github-markdown.min.css`,
respects `prefers-color-scheme`) and load both highlight.js light + dark
themes gated by `media="(prefers-color-scheme: …)"` so the right code-block
palette loads per OS preference.

## [1.1.10] - 2026-05-16

### Added — Web console token authentication

Web console used to ship with **no built-in auth**: anyone who could reach
the port (after a reverse-proxy / tunnel) had full dashboard access. v1.1.10
adds token-gated login.

- **`agim token` CLI**: `create [label]` / `list` / `revoke <id>`.
  Bootstrap token auto-generated at first start and printed to stdout +
  `journalctl -u agim` so the operator can copy it from logs.
- **Interactive menu**: bare `agim` → "Manage web access tokens" submenu
  (create / list / revoke). Mirrors the CLI flow for non-power-users.
- **`/login` page** (bilingual EN/中文) with step-by-step instructions
  for getting a token from the terminal.
- **Auth gate** in `web/server.ts`:
  - Loopback peers (127.0.0.1 / ::1) bypass (local dev unaffected).
  - Public paths bypass: `/v/:id` viewer pages, `/loc` location capture,
    `/l/<token>` short links, `/api/health`, `/api/loc{,/*}` (single-use
    location token still required by the loc layer itself).
  - All other paths require an `Authorization: Bearer <token>`, an
    `agim_token` cookie, or `?token=` query (for WS upgrade).
  - 401 for `/api/*`; 302 → `/login?next=…` for HTML routes.
- **Storage**: `~/.agim/tokens.json` (chmod 600). Server only stores
  SHA-256; raw token is shown once at create time.
- **Cookie**: 30-day `agim_token` cookie set on successful login;
  `SameSite=Strict`, `Path=/`. Logout via `POST /api/auth/logout`.
- **Disable**: `IMHUB_WEB_AUTH=off` reverts to pre-1.1.10 open access
  (for ops who do auth at the reverse proxy layer).
- **Global fetch interceptor** in `_app.js` auto-attaches `Authorization`
  + redirects to `/login` on 401. Existing pages keep working without
  changes; new tabs get auth transparently.

### Changed — A2A robustness

The HSTECH / Lens debate sessions surfaced two pain points:

- **Default timeout raised from 10 min → 30 min** (`IMHUB_A2A_TIMEOUT_DEFAULT_MS`).
  Codex routinely takes 15-25 min for a 4-API-pull + writing-a-report job;
  the old 10 min cutoff killed it mid-flight and left orphan files in
  `_agim-output/`. New `IMHUB_A2A_MAX_TIMEOUT_MS` (default 1h) caps the
  ceiling so an agent can't accidentally write `timeoutMs: 86400000`.
- **Abort on timeout** — `AgentSendOpts.signal` plumbed through `sendPrompt`
  → `spawnStream` so callees actually get SIGTERM'd when A2A gives up.
  No more orphan child processes writing into shared output dirs.
- **New `src/core/a2a-notify.ts`** pushes 4 lifecycle events to the
  caller's IM thread so users see what's happening downstream:
  - `🔀 转给 codex (#jobId · depth N)` — start
  - `✓ codex 完成 (耗时 5m20s) 📎 file.md 🔗 viewer-link` — complete
    with auto-snapshot of the first `.md` output as a viewer paste
  - `⌛ codex 超时 (10m 未返回) — 子进程已停` — timeout
  - `❌ codex 失败 ... <err>` — failure
- **Verbose heartbeat mode** detects file changes in `_agim-output/`
  every `IMHUB_A2A_HEARTBEAT_MIN` minutes (default 5):
  - With change: lists new files + links the first new `.md` once.
  - Without change: "still thinking" note.
- **Notify scope**: source='system' (never routes through viewer);
  default mode 'essential' (start + terminal events only); depth ≤1
  by default (no spam on deep call chains).
- **Settings UI** has a new 🔀 A2A Notifications card (timeouts in
  minutes, mode dropdown, depth, heartbeat interval — bilingual).

### Fixed

- **Restart message order**: `/restart` used to send "🔄 重启中…" via the
  outbox queue, which the dying process never drained — the new process's
  high-priority "✅ 已重启完成…" then arrived first. Now `initiateRestart()`
  delivers the in-flight ack synchronously (`priority: 'high'`) before
  spawning `systemctl restart`. Command return becomes `''` so the
  pipeline doesn't double-deliver.
- **Slash command outputs no longer route through viewer**: `cli.ts`
  string-branch was incorrectly tagged `source: 'agent'` in 1.1.9.
  Corrected to `source: 'system'` so `/job list`, `/a2a tree`, `/outbox`,
  `/audit` etc always render inline regardless of length.

### Migration

- After upgrade, **set up at least one access token** before exposing the
  web port publicly. First start auto-creates a bootstrap token — copy
  the value from `journalctl -u agim` or `agim status` output.
- Existing users on a reverse proxy with their own auth: set
  `IMHUB_WEB_AUTH=off` if you don't want a second factor.
- Local-only / loopback users: nothing changes (auth bypassed on
  127.0.0.1).

## [1.1.9] - 2026-05-16

### Fixed — Viewer no longer steals operational/system replies

Memo confirmations, reminder fires, approval cards, restart notices,
error blurbs and command outputs all run through `sink.deliver()` —
and v1.1.6's viewer router happily picked them up the moment their
char count crossed the threshold (the encoded Baidu map URL in a memo
confirmation is enough to do it). The result: a `✅ 已记下'<地点>'`
reply got hidden behind a `📎 https://…/v/<uuid>` link, defeating the
point — the user wanted to *see* the operational outcome in chat.

**Fix**: `SinkPayload` gains a `source: 'agent' | 'system'` field,
defaulting to `'system'`. The viewer router now only fires when
`source === 'agent'`. Updated the two freeform-LLM callsites in
`cli.ts` to pass `source: 'agent'`; every other call path keeps the
default and stays inline. Future system message types stay inline
automatically — no opt-out needed.

This means anything from `/memo`, `/remind`, `/approval`, `/restart`,
`/job`, `/outbox`, `/a2a`, queued / error / recovery / restart-completion
notices, web `/api/notify` pushes, and the location-capture
confirmation now always render in full inside the IM thread,
regardless of length.

## [1.1.8] - 2026-05-16

### Added — Viewer auto-tunnel (cloudflared quick mode)

For operators who don't have a public domain / reverse proxy and can't
otherwise expose their agim host, the viewer can now auto-launch a
cloudflared "quick tunnel" so /v/:id links in IM are reachable from
a phone with zero infrastructure setup.

- **New env var `IMHUB_VIEWER_TUNNEL_MODE`** — `off` (default) or
  `quick`. When `quick`, agim startup forks `cloudflared tunnel --url`
  pointing at the local web port and captures the assigned
  `https://*.trycloudflare.com` URL from its log output. The URL
  becomes the effective base for link building.
- **Precedence**: `IMHUB_VIEWER_PUBLIC_BASE_URL` always wins when set.
  Tunnel is only used as a fallback. So operators can keep their
  static reverse proxy and only switch to tunnel during travel /
  testing without changing anything else.
- **Auto-restart** — if cloudflared exits non-cleanly (network blip,
  upstream restart), agim waits 30 s and respawns. The URL after
  respawn is different; in-flight IM links from before become dead.
- **Clean shutdown** — cloudflared is SIGTERM'd as part of agim's
  graceful shutdown before WAL checkpoints.
- **Binary detection** — agim does NOT bundle cloudflared (binary is
  architecture-specific + ~30 MB). It checks `$PATH` plus a few
  common locations (`/usr/local/bin`, `/opt/homebrew/bin`,
  `~/.agim/bin`). When missing, agim logs a friendly install hint and
  silently keeps the tunnel disabled — viewer falls back to inline
  truncation for long replies.
- **`GET /api/viewer/tunnel`** — read-only status (`{ running, url,
  binaryFound, binaryPath, lastError, startedAt }`) consumed by the
  Settings page tunnel panel.
- **Settings page** — Viewer card now has a "Auto-tunnel" dropdown
  (off / quick) and a live status panel showing whether the tunnel is
  running, the current trycloudflare.com URL, and an install hint when
  cloudflared is missing.

### Trade-off

Quick-tunnel URLs are ephemeral — they change every time cloudflared
process (re)starts. Old `/v/:id` links in IM thus become dead after a
restart. Operators who want permanent links should configure a static
reverse proxy (cloudflared named tunnel, caddy, tailscale funnel,
nginx, …) and set `IMHUB_VIEWER_PUBLIC_BASE_URL` instead. The
auto-tunnel mode is intentionally a "zero-config fallback", not a
recommended permanent deployment.

### Install cloudflared

```
# macOS
brew install cloudflared

# Debian/Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb

# Generic Linux binary
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.agim/bin/cloudflared
chmod +x ~/.agim/bin/cloudflared
```

## [1.1.7] - 2026-05-16

### Fixed — Viewer page leaked the IM user id

- `/v/:id` rendered the `source` field (thread key
  `platform:channelId:threadId`) in the page header. That string
  contains the IM user id (wxid on WeChat, numeric id on Telegram).
  Since the `/v/:id` URL is anyone-with-link, this exposed the user
  id to anyone the link was forwarded to. The render template now
  omits `source` entirely — the field stays in the local DB for the
  operator's own dashboard but no longer ships in HTML.

## [1.1.6] - 2026-05-16

### Added — IM long-message viewer (local-first, never leaves your host)

- **Local viewer for long agent replies.** When the agent's reply
  exceeds the size threshold (default: > 500 chars / > 12 lines /
  contains a markdown table / contains a code block ≥ 10 lines),
  agim stashes the full markdown in a brand-new **local-only**
  SQLite at `~/.agim/viewer.db` and replaces the IM payload with
  a short summary plus a `📎 https://<your-host>/v/<uuid>` link.
  The link is served by agim's own web console — the content
  **never leaves your machine**; the public URL is a reverse-proxy
  pass-through to your local web port.
- **`GET /v/:id`** — public render route on the web console. Renders
  the stored markdown with `marked` + `DOMPurify` + `highlight.js`
  (loaded from jsdelivr CDN). Mobile-friendly, dark-mode aware,
  `noindex,nofollow`, copy-raw button.
- **`GET /api/viewer{,/:id}`** + **`DELETE /api/viewer/:id`** —
  list / read / delete pastes from the dashboard or via curl.
- **Permanent storage by default.** No TTL; rows are kept until
  `IMHUB_VIEWER_MAX_PASTES` (default 10 000) is exceeded, at which
  point oldest rows are LRU-pruned.
- **Two-section envelope for agents.** Router prepends a small
  `[IM-render hint]` block to every prompt when the viewer is
  enabled, asking the agent to wrap long answers in
  `<im-summary>…</im-summary><full-md>…</full-md>`. agim falls back
  to first-paragraph truncation if the agent ignores the envelope.
- **Standalone reference service.** A separate
  [`agim-viewer`](https://github.com/benking007/agim-viewer)
  repo provides the same routes packaged as a Docker container —
  for the small set of users who can't expose their agim host but
  can run a dedicated public service. The local mode in agim is
  the recommended deployment.

### Config

| Env var | Default | Notes |
|---|---|---|
| `IMHUB_VIEWER_ENABLED` | `false` | Master switch. |
| `IMHUB_VIEWER_PUBLIC_BASE_URL` | _(empty)_ | Your public URL pointing at this agim host, e.g. `https://agim.example.com`. Used to build the link placed in IM. |
| `IMHUB_VIEWER_CHARS` | `500` | Char-count threshold above which routing to web kicks in. |
| `IMHUB_VIEWER_LINES` | `12` | Line-count threshold. |
| `IMHUB_VIEWER_CODE_LINES` | `10` | Single-fence code-block line threshold. |
| `IMHUB_VIEWER_MAX_PASTES` | `10000` | Local SQLite row cap (LRU prune). |

### Notes

- Reverse-proxy your agim web port (default 3000) to a public
  hostname via cloudflared / caddy / tailscale-funnel etc. Set
  `IMHUB_VIEWER_PUBLIC_BASE_URL` to that hostname.
- Privacy posture: content is stored locally on your host only.
  The link uses an unguessable uuidv4 — treat it like a private
  share link.

## [1.1.5] - 2026-05-15

### Fixed — Web console header parity + complete i18n

- **Header parity for Tasks / Reminders / Memos.** All three pages
  now share the same flex header (gap:16px, h1 flex:1, uniform
  border-button for nav links / theme toggle / language select).
  Removed the legacy `<nav>` wrapper from Reminders + Memos so the
  DOM matches Tasks; the only intended difference per page is the
  self-referencing nav link being omitted.
- **Emoji prefix unified.** Page titles consolidated through
  `T.h1` (`🗂 任务与定时` / `🔔 提醒` / `📋 备忘`) instead of
  some pages baking the emoji into HTML and others omitting it.
  Nav-link `↩ Chat` / `↩ 对话` prefix moved into `T.backToChat`.
- **Complete i18n migration of JS template strings.** Hardcoded
  English strings in Reminders + Memos JS (loading / empty /
  snooze / cancel / confirm dialogs / delete / map links / toast
  text) were missed in the first pass and showed up as mixed
  zh/en when the language was set to 中文. All ~19 strings now
  resolve through `T.*` with en + zh parity.
- **Pre-1.0 schema rows surfacing Invalid Date** in older deploys —
  belt-and-suspenders fix already in 1.1.4 carried forward.

## [1.1.4] - 2026-05-15

### Added — Web console catches up with task-recovery + A2A

- **Outbox tab in /tasks** — three-color stats (pending / delivered /
  giving_up), filterable table, per-row Retry button for `giving_up`
  rows. Backed by `GET /api/outbox{,/stats}` + `POST
  /api/outbox/:id/retry`. Same machinery the IM `/outbox` command
  drives.
- **A2A tab in /tasks** — stats card (total / 24h / max depth /
  by-status / top callees), recent-calls table, depth-bounded tree
  walk rooted at any job id. Tree nodes link directly to artifact
  downloads (`📎 commits.txt`). Backed by `GET /api/a2a/{stats,recent}`
  and `GET /api/a2a/tree/:id`.
- **Artifacts download API** — `GET /api/artifacts/:jobId` lists
  inputs+outputs, `GET /api/artifacts/:jobId/file/:name` streams the
  file (Content-Type auto-detected from extension, inline disposition).
  Used by the A2A tab and the Job-detail modal.
- **Jobs tab enrichment** — table grows Kind / Parent / Depth columns;
  status filter gains the Phase 3 values (delivered / interrupted /
  replaced / abandoned); kind filter (all / job / inline). Click a
  parent link to re-open showJob() on that row.
- **Job-detail modal** — surfaces kind pill, parent + depth, thread
  key, replaced_by, last_outbox_id, delivered_at. New `📎 Artifacts`
  section listing inputs/outputs with download links when files exist.
- **Help-tooltip system** — small `(?)` button next to jargon
  (Outbox / Inline / A2A / Artifacts / Call depth / Parent /
  Replaced-by / Giving-up) opens a centered modal explaining the
  concept in the active language. Eight entries; en + zh.
- **Language switcher on Reminders + Memos pages** — they had English
  hard-coded headers and no langSelect. Now match the Tasks layout
  (themed h1 + theme-toggle + EN/中文 dropdown + nav links), with
  full en/zh dictionaries for filter labels, status pills, time
  helpers ("just now" / "刚才", "5 min ago" / "5 分钟前").

### Fixed

- **Invalid Date** across Outbox / A2A / Audit time cells. Safari and
  iOS WebView reject the space-separated `"YYYY-MM-DD HH:MM:SS"` SQLite
  emits; Chrome happens to parse it. `fmtTime` now normalizes to
  RFC3339 (swap space for T, suffix Z) and falls back to the raw
  string if the result is still NaN. Outbox + A2A tables also stopped
  slicing the timestamps raw and route through fmtTime for locale
  rendering.
- **`/api/a2a/*` returning 503** — the read-only sqlite helper in
  web/server.ts used CommonJS `require('better-sqlite3')` under ESM
  (no `require` at runtime). Switched to dynamic `await import(...)`
  and added the `await` at three call sites (stats / recent / tree).
  This is why the live A2A tab showed empty data on first deploy.

### Changed

- **Mobile usability** — the Tasks page tab bar (10 tabs) and the new
  wide tables (10 columns each) used to overflow phone-width WebViews.
  Tab bar now horizontally scrolls (`white-space: nowrap`), tables get
  `overflow-x: auto` + `min-width: 720px` so cells stay legible and
  the user scrolls horizontally instead of seeing squished content.

## [1.1.3] - 2026-05-15

### Added — Agent-to-Agent Layer 2 (shared artifacts)

- **File exchange between agents.** `mcp__imhub__call_agent` now accepts
  optional `inputs[]` and `expectOutputs[]` so caller and callee can
  hand off files instead of round-tripping bytes through prompts /
  results.
  - `inputs` entries pick a source: `fromAbsolutePath` (host file),
    `fromCallerOutput` (caller's own `_agim-output/`), or inline
    `content` (UTF-8 string).
  - `expectOutputs` is a soft contract — missing files become entries
    in `warnings`, never a hard failure.
  - Each A2A run gets `~/.agim/artifacts/<jobId>/{_agim-input,_agim-output}/`.
    The callee learns about its workspace through a `[A2A workspace]`
    envelope prepended to its prompt: absolute paths, input inventory
    with sizes, expected-output checklist.
  - Response includes `artifactsDir`, `outputs[]` (name + bytes + mtime),
    and optional `warnings[]`. Caller reads `outputs[]` and uses the
    `Read` tool to pull file contents on demand.
- **Hard-link first, copy second.** `fromAbsolutePath` and
  `fromCallerOutput` use `link(2)` when source and destination share a
  filesystem — near-zero cost for read-only inputs. Falls back to plain
  copy on EXDEV.
- **Size caps**: `IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_FILE` (default 50 MB),
  `IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_JOB` (200 MB),
  `IMHUB_A2A_ARTIFACT_MAX_FILES_PER_JOB` (200). Failed setup fails the
  job before any tokens are spent.
- **Retention follows the inline-job row.** When job-board's sweep
  deletes a row, `pruneArtifactsBatch` removes its directory. Fire-and-
  forget — orphan dirs (if disk pruning fails) never block DB cleanup.
- **`/a2a tree <id>`** now lists `📎 <name> (<size>)` under each row
  that left files in `_agim-output/`.

### Changed

- `mcp__imhub__call_agent` description grew a paragraph documenting the
  L2 fields; existing L1 callers (no `inputs` / `expectOutputs`) keep
  the L1 string-in / string-out behavior unchanged.

### Reference docs

- `docs/a2a-l2-plan.md` — full Layer 2 design, decision register, and
  the L3 punt list (cross-thread artifacts, remote ACP artifacts,
  versioning) are documented but not implemented.

## [1.1.2] - 2026-05-15

### Added — Task recovery (3-phase, all on by default)

- **Outbox-backed IM delivery.** Every outbound message (replies, reminder
  fires, approval prompts/receipts, restart-completion notices, web
  notifications) now flows through a SQLite-backed outbox in
  `~/.agim/outbox.db`. A worker drains pending rows with exponential
  backoff (1s → 5s → 30s → 5min → 30min → 2h → `giving_up`). Replies
  survive IM platform glitches, brief disconnects, and adapter restarts
  — no more "agent answered but the user never got it" black holes.
  - `/outbox status` aggregate counts.
  - `/outbox list [N]` recent rows.
  - `/outbox failed` rows in `giving_up`.
  - `/outbox retry <id>` resurrect a `giving_up` row.
  - Retention: 24h after `delivered` / `giving_up`. Override with
    `IMHUB_OUTBOX_RETENTION_HOURS`.
- **Inline-job tracking.** Every inbound agent-bound message now creates
  a row in `jobs.db` with `kind='inline'`, going through the full
  lifecycle `pending → running → completed → delivered` (or `failed`).
  The state machine survives crashes; this is the substrate Phase 3
  recovery and A2A both rely on.
  - Visible in `/job list` and per-row in `/job check <id>`.
  - Retention: 24h (vs 30d for `kind='job'` rows from explicit `/job
    create`). Override with `IMHUB_INLINE_JOB_RETENTION_HOURS`.
  - Kill switch: `IMHUB_INLINE_JOB_TRACKING=0` disables creation; the
    user reply path falls back to the unchanged in-memory pipeline.
- **Crash-recovery flow.** When agim exits (SIGTERM/SIGINT/crash), any
  in-flight inline job is stamped `interrupted`. On startup, jobs
  interrupted within the last 10 minutes get a per-thread retry prompt
  through the outbox: `⚠️ 上次的消息被服务重启中断了：「<prompt 摘要>…」
  回复 1 重发 / 2 取消（10 分钟内有效）`.
  - Reply `1` → fresh inline job with the original prompt, old row
    stamped `replaced_by=<new id>`.
  - Reply `2` → old row marked `cancelled`.
  - No reply → old row swept to `abandoned` by the next startup.
  - Window override: `IMHUB_RECOVERY_WINDOW_MS` (default 600000).

### Added — Agent-to-Agent (A2A) Layer 1

- **`mcp__imhub__call_agent` MCP tool.** A running agent (claude-code /
  opencode / codex / copilot) can now program-call another agent and
  wait for the result inside its own tool loop. The tool description
  uses imperative + Chinese trigger phrases so models invoke it
  naturally when the user says e.g. "用 codex 帮我跑 git status" or
  "ask opencode to run the tests".
- **Guardrails enforced inside agim, not on the model**:
  - `IMHUB_A2A_MAX_DEPTH` (default 3) — caps nested call chains.
  - Self-call ban — `claude-code` can't recursively call `claude-code`.
  - Workspace whitelist — callee must be in the caller's workspace
    `agents[]`. Caller's `userId` carries through.
  - `IMHUB_A2A_TIMEOUT_DEFAULT_MS` (default 600_000) — accumulation
    timeout. Callee keeps running on timeout; caller stops waiting.
  - Kill switch: `IMHUB_A2A_ENABLED=0` disables the whole feature.
- **`/a2a stats | recent [N] | tree <id>`** — observability for A2A
  traffic. Each callee row is linked to its caller via `parent_id`
  + `call_depth`, so `/a2a tree <root>` renders the full chain.
- **Audit integration** — `intent='a2a'` lights up in `/audit` queries
  and feeds the same per-user budget that user-originated calls do.

### Changed

- `SIGTERM` now reuses the same graceful-shutdown path as `SIGINT`.
  Prior to 1.1.2, `systemctl restart` invocations skipped session-
  manager / WAL-checkpoint cleanup because only `SIGINT` was hooked.
  Recommended systemd unit drop-in: `KillMode=mixed` so children get
  `TimeoutStopSec` of grace before SIGKILL.
- `jobs` table schema migrated (idempotent ALTER TABLE) with
  `thread_key`, `kind`, `started_at`, `delivered_at`, `replaced_by`,
  `last_outbox_id`, `parent_id`, `call_depth`. Pre-v1.0 databases
  (which still had only the original 8 columns) are auto-upgraded
  on first startup.
- `MessengerAdapter.sendMessage` call sites consolidated through
  `core/message-sink.ts`. Reminder polish / memo polish run upstream of
  sink and are unaffected; sink only takes the final plain payload.

### Fixed

- Schema-vs-migrate ordering broke job-board on legacy databases. The
  v1.0 ownership migration's `CREATE INDEX idx_jobs_creator ON
  jobs(creator_id)` was inside the schema string, which `sqlite-helper`
  exec()s **before** `migrateOwnership`. Against a pre-v1.0
  `~/.agim/jobs.db` (no `creator_id` column yet) this threw
  `no such column: creator_id` and disabled the entire job-board for
  the lifetime of the process. The bug shipped silently in v1.0 and
  only surfaced when Phase 2 forced everyone to actually look at the
  jobs table. Column-dependent indexes now live inside `migrateColumns`,
  after the ALTER TABLE pass.
- Recovery retry path no longer creates orphan `pending` rows. The
  retry interceptor's pre-created replacement job (so it could stamp
  `replaced_by` atomically) is now reused by `handleMessage` instead
  of being shadowed by a second `createInlineJob` call.

### Reference docs

- `docs/task-recovery-plan.md` — 3-phase design + risk register +
  cross-session handoff guide.
- `docs/task-recovery-testing.md` — grey-deploy step-by-step verifier.
- `docs/agent-to-agent-plan.md` — 3-layer A2A design (L1 implemented;
  L2 shared-artifacts and L3 workflow-DSL are documented for later).

## [1.1.1] - 2026-05-14

### Changed

- **Approval timeout default 30 min → 15 min.** Long enough for slow IM
  channels to round-trip a y/n; short enough to unblock downstream tools.
  Override with `IMHUB_APPROVAL_TIMEOUT_MS`.
- **Agent child-process budget switched from 30-min hard total cap →
  60-min idle watchdog.** Every stdout / stderr chunk resets the timer,
  so slow human-in-the-loop approvals no longer eat the budget. A truly
  hung child (no output for the idle window) still gets SIGTERM →
  SIGKILL escalation. Covers `agent-base` (claude-code, codex,
  opencode-stdio) and the opencode HTTP adapter (SSE watchdog).
- **Auto-allow rule fingerprint is now per-tool semantic, not a fixed
  10-char input prefix.** Bash keys on `cmd:<verb+arg2>`, file tools key
  on `dir:<dirname>`, WebFetch keys on `host:<hostname>`, etc. One `all`
  on `Read /tmp/a.txt` now covers all reads in `/tmp/`; `git status` and
  `git stash` are correctly distinct rules.
- **Plain-text approval card layout — compact** (3-line minimum, no
  blank separators), with `(N 行·X KB)` size hints when a big content
  field is truncated. Primary param (path, short command, URL) inlined
  into the header.
- **Self-protect guard split by tool intent.** `BASH_DANGER_PATTERNS`
  (systemctl / pkill / agim restart / …) now only scan `Bash.command`;
  `CODE_DANGER_PATTERNS` (only `process.kill(pid, 'SIGTERM')`) only scan
  Edit/Write content fields; other tools skip the scan entirely. Fixes
  the "operator can't debrand / refactor / document their own service
  because the guard blocks legitimate edits containing the literal
  `systemctl restart agim`" footgun.

### Added

- **`IMHUB_TIMEOUT_DEFAULT=allow | deny`** env (default `deny`) — what
  the bus returns when a normal-mode approval times out with no human
  reply. `allow` is "user away" mode. Hot-reloadable from the new Web
  Settings → **Approval Policy** card (no service restart needed).
- **`IMHUB_AGENT_IDLE_TIMEOUT_MS`** global env + `${NAME}_IDLE_TIMEOUT_MS`
  per-agent override for the idle watchdog. `0` disables.
- **`OPENCODE_IDLE_TIMEOUT_MS`** env for the opencode HTTP adapter.
- **`humanizeFingerprint()`** — `/approval` listing and auto-allow
  receipts now render `命令 git status` / `目录 /tmp` / `主机 api.x.com`
  instead of leaking internal scheme prefixes (`cmd:`, `dir:`, `host:`).
- Approval card timeout footer reads the live timeout + the effective
  `IMHUB_TIMEOUT_DEFAULT` setting (e.g. `15min 未回 → 放行 · req XXX`),
  instead of hard-coded "5 分钟未回 = 拒绝".

### Fixed

- **Self-protect no longer false-positives on legitimate edits** that
  delete or insert the literal `systemctl restart agim` in docs / i18n /
  comments (`old_string` JSON-stringify catch-all removed; `new_string`
  only scans true code-side dangers like `process.kill`).
- **Telegram `sendApprovalCard` failure → retry once after 200 ms before
  falling back to plain text.** The common cause (`Telegram adapter not
  started` during bot reconnect, transient 429) clears in well under a
  second; without the retry, every blip dropped the card to plain text.
- **Button-click race no longer overwrites an already-resolved card.**
  Late `n`/`y` clicks (after auto-allow grace already fired and edited
  the card to `allowed`) now skip the re-edit, keeping the visual
  terminal state correct.
- **WebFetch / WebSearch approval cards now show the URL / query** even
  when it's too long to fit in the header row (previously the card
  rendered as just "🔐 审批 · WebFetch" with no URL info — users were
  blind-signing arbitrary requests).
- **`/approval` listings and auto-allow receipts** stop leaking the
  internal fingerprint scheme (`cmd:git+status`) to users.
- **idle watchdog now escalates SIGTERM → SIGKILL after 5 s**, matching
  the abort path. A signal-ignoring child can no longer wedge the
  parent indefinitely.
- **`sendDecision` socket-not-writable** previously dropped the decision
  silently; now logs `approval.bus.send_dropped` so operators can
  diagnose "auto-allow showed the card but didn't fire" complaints.
- **Notifier error message** is now forwarded to the agent (and through
  to the user) instead of being replaced with a generic `'notifier
  error'`. Self-protect's friendly `/restart` redirect finally reaches
  the user.
- **Web UI Approval Policy card** properly surfaces server 5xx errors
  (previously the UI lied "已保存" even on failed writes).

### Breaking

- Removed env keys `CLAUDECODE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` /
  `OPENCODE_TIMEOUT_MS` (per-agent total-time cap). Replaced by
  `${NAME}_IDLE_TIMEOUT_MS` with idle semantics. No-op for users who
  never set the old keys.
- Rule keys in the auto-allow store now have a scheme prefix
  (`cmd:` / `dir:` / `host:` / …). In-memory only, wiped on restart; no
  migration needed.

## [1.1.0] - 2026-05-14

### Changed — debrand user-facing strings + docs to "agim"

CLI help text, IM messenger adapter error messages, web server log
lines, and command-palette titles now say `agim` instead of `im-hub`
or `im-hub-pro`. All non-historical docs (README, deployment,
session-model, im-workspaces-guide, etc.) were rewritten accordingly,
including default state-dir / workspace-dir path references
(`~/.agim/`, `~/.agim-workspaces/`).

### Breaking — Web UI theme key

The localStorage key for the Web UI dark/light theme preference changed
from `im-hub-pro-theme` to `agim-theme`. Users will see their theme reset
to system default once on first load after upgrade; re-select if desired.

### Kept for compatibility (intentionally not changed)

The following surfaces still use the legacy `im-hub` / `im-hub-pro`
identifier and will not change without a major-version bump:

- `im-hub-pro` npm bin alias (`/usr/local/bin/im-hub-pro` continues to
  resolve to the same CLI as `agim`).
- `im-hub.service` systemd unit name — installations from the 0.x line
  keep their existing unit file; v1.0+ fresh installs write
  `agim.service` and `cli-ui/service.ts` falls back to the legacy name.
- `X-IM-Hub-Token` HTTP header on the ACP server (`acp-server.ts`).
- WeChat `client_id: 'im-hub:…'` (IM-platform-side identifier).
- `~/.im-hub/` data dir + `~/.im-hub-workspaces/` workspace root are
  still detected by `core/agim-paths.ts` as legacy fallback paths; v1.0+
  fresh installs land at `~/.agim/` and `~/.agim-workspaces/`.
- `self-protect.ts` process-name regex still matches
  `(agim|im-hub-pro|im-hub|dist/cli.js)`.
- `npm uninstall -g agim-cli im-hub-pro im-hub` (in `cli-ui/cmd-handlers.ts`)
  continues to clean up all three historical package names.

## [1.0.14] - 2026-05-13

### Fixed — same-thread agent invocations now serialize (was: clobbering each other)

When a user sent two messages quickly on the same IM thread, both
`handleMessage` runs raced into the agent layer. Concrete failure modes
that bit us:

  - **claude-code**: same `--session-id` reused → second spawn fails with
    "session already exists".
  - **codex**: same conversation file written by two CLI processes.
  - **opencode (stdio)**: stdin pipe interleaved between two writers.
  - **opencode (HTTP)**: session-update PATCH dedup helped a bit, but
    prompt-level concurrency was still unhandled.
  - **all agents**: typing / "🤔 思考中…" placeholders from the two runs
    raced, then the two replies came back out-of-order.

`src/plugins/messengers/{wechat-ilink,telegram}` are the worst offenders —
both dispatch incoming messages with `.catch(...)` (no `await`), so a
single polling tick that pulls N messages fan-outs into N parallel
runs immediately. discord/dingtalk/feishu await inside one event
callback but offer no protection across callbacks. The
`agent-base.ts` contract explicitly says concurrent calls are safe
**across threadIds** — but does not guarantee same-thread safety.

New `core/thread-queue.ts`: per-thread FIFO promise chain keyed by
`${platform}:${channelId}:${threadId}`. `cli.ts:handleMessage` now
wraps the agent invocation + response delivery block in
`runOnThread()` when `willInvokeAgent === true`. Built-in commands
(/help, /status, /audit, …) and approval replies (`y` / `n` /
`批准` / ✅ / ❌ / …) bypass the queue — they need to stay parallel so
that a `y` reply can resolve an approval card even while an agent run
is in flight on the same thread.

When depth > 0, joiners receive `📥 已收到（前面还有 N 条在处理，
稍后给你结果）` so the user isn't left wondering whether their second
message landed. The chain swallows predecessor failures (so one
broken run doesn't poison every waiter behind it). Tests: 6 new cases
in `core/thread-queue.test.ts`; full suite stays at the 9-flaky
baseline.

### Fixed — restart ack reported "版本 unknown"

`src/core/restart-flow.ts:PKG_VERSION` used `require('node:fs')` to
fetch `readFileSync` lazily, which silently threw `ReferenceError:
require is not defined` on every call because the compiled output is
native ESM. The try/catch swallowed the error and returned "unknown",
leaving every IM restart ack reading "✅ 已重启完成（…, 版本
unknown）". The fix imports `readFileSync` at the top of the file like
every other fs use. Now restart acks correctly read "版本 1.0.14"
(and forward).

## [1.0.13] - 2026-05-13

### Fixed — WeChat completion ack after restart silently dropped

When a restart was initiated from a WeChat thread, the "✅ 已重启完成"
message was logged as

    component=restart-completion event=restart-completion.push_no_messenger
    platform=wechat msg="IM messenger not registered after restart;
                         completion push dropped"

and never reached the user. Root cause: the wechat-ilink adapter tags
inbound `MessageContext.platform = 'wechat'`, but registers in the
plugin registry under the name `wechat-ilink`. The completion path
in `core/restart-completion.ts:pushToInitiator` called
`registry.getMessenger('wechat')` directly, which returned undefined
and dropped the push silently.

`restart-completion.ts` now goes through a new `resolveMessenger()`
helper: exact-name match first (preserves telegram / feishu /
dingtalk / discord behavior, all of which have aligned names), then a
prefix fallback so `wechat` finds `wechat-ilink` — and a future
`wechat-padlocal` etc. would resolve transparently.

Only WeChat was affected. No state-file format change; users on 1.0.12
who don't restart from WeChat see no behavioral difference.

## [1.0.12] - 2026-05-13

### Removed — Safety card "Skip permissions" toggle

The web /settings Safety card no longer exposes a toggle for
`IMHUB_DANGEROUSLY_SKIP_PERMISSIONS`. The toggle was a footgun for the
typical systemd deployment: im-hub runs as root, but Claude CLI itself
hard-refuses `--dangerously-skip-permissions` for uid=0 with

    claude-code failed (exit 1):
      --dangerously-skip-permissions cannot be used with root/sudo
      privileges for security reasons

so flipping the toggle ON only succeeded in breaking every subsequent
Claude run. Removing the UI control means operators don't trip the
guard by accident.

The env variable itself is **still honored** by the Claude adapter
(`src/plugins/agents/claude-code/index.ts`). Non-root deployments that
genuinely want the bypass can edit `~/.agim/env` manually:

    IMHUB_DANGEROUSLY_SKIP_PERMISSIONS=1

The Safety card now contains only the Admin Allowlist editor.

## [1.0.11] - 2026-05-13

### Fixed - /restart races systemd own restart in systemd-managed installs

P0 bug from v1.0.9-v1.0.10: restart-flow always spawned a detached helper to
respawn, even when systemd was the supervisor. systemd would see its
managed PID exit and try its own restart; the helper had already bound :3000;
systemd entered auto-restart loop while a background daemon owned the port.

Fix in core/restart-flow.ts initiateRestart(): now branches on detected
service mode BEFORE writing the pending file:

  - systemd    -> run systemctl restart <unit> in a detached child.
                  systemd handles the lifecycle; no helper, no race.
  - foreground -> refuse with friendly error pointing back to the
                  owning shell.
  - background -> existing detached-helper path (only when no external
                  supervisor manages lifecycle).

### Cleanup for affected v1.0.9 / v1.0.10 installs

    pgrep -af dist/cli.js  # see surviving daemons
    pkill -9 -f dist/cli.js
    systemctl reset-failed im-hub
    systemctl restart im-hub

## [1.0.10] - 2026-05-13

### Added — first-run admin onboarding

The v1.0.9 denial message ("set IMHUB_ADMIN_USERS=… and restart") was
unfriendly to small / non-technical operators. v1.0.10 replaces it with
a guided self-onboarding flow:

1. **At startup**, if no admin is configured, Agim generates a one-time
   12-char base32 token (~60 bits of entropy), writes it to
   `~/.agim/admin-bootstrap-token` (chmod 600), and prints a prominent
   banner to stdout + structured log:

   ```
   ⚙️  No admin configured. To onboard yourself:
        · In IM, send:  /setup admin ABCD-EFGH-JKLM
        · Token also in: ~/.agim/admin-bootstrap-token
        · Token regenerates on every restart while no admin is set.
   ```

2. **Operator** sees this in `journalctl -u im-hub` (or `tail
   ~/.im-hub/im-hub.log`), opens their own IM, and sends
   `/setup admin <token>` to the bot.

3. **Bot** verifies the token, calls `promoteAdmin(platform, userId)`
   which:
   - Adds the entry to the in-memory allowlist (effective immediately,
     no restart required)
   - Persists `IMHUB_ADMIN_USERS` to `~/.agim/env` so the next restart
     keeps it
   - Unlinks the token file (single-use)
   - Replies "✅ 你 (platform:userId) 已设为管理员"

4. **All subsequent** /restart, /stop, "重启服务" etc. from that user
   pass the admin gate.

### Changed — smarter denial messages

The blanket message in v1.0.9 ("IMHUB_ADMIN_USERS=… 然后重启服务") leaked
internal env-var format to random visitors. v1.0.10 distinguishes:

- **No admin at all** → "这个 bot 还没配置管理员。如果你是部署者：…
  /setup admin <token>…"
- **Admins exist but caller isn't one** → "你没有权限执行此操作。"
  No env hint, no list of current admins.

### Added — web UI "Admin Allowlist" sub-section

The /settings Safety card now lists current admins and lets the
operator add / remove entries directly. New endpoints:

- `GET  /api/admin-allowlist` — list + bootstrapAvailable flag
- `POST /api/admin-allowlist` — add (gated on bindHost = localhost)
- `DELETE /api/admin-allowlist` — remove (gated on bindHost = localhost)

The add/remove endpoints are **refused when the web is bound to
0.0.0.0** — without auth, a LAN visitor could otherwise self-promote.
The frontend hides the editor and shows a warning in that case.

### New slash command

- `/setup admin <token>` — consume the bootstrap token

### Tests

51 new cases across admin-bootstrap (8) + extended admin-allowlist
denial-message + intent/self-protect coverage from v1.0.9. Full suite:
1291 pass / 10 pre-existing flakies (same baseline as v1.0.9).

### Migration

- Existing deployments with `IMHUB_ADMIN_USERS` already set: nothing
  changes. Token file is auto-cleaned at startup since admins exist.
- New deployments: the bootstrap banner is the entry point. No more
  manual env editing required for the typical operator onboarding.

## [1.0.8] - 2026-05-13

### Added — opt-in `--dangerously-skip-permissions` for Claude Code

A new opt-in lets the operator turn off every approval prompt for Claude
Code, by setting:

    IMHUB_DANGEROUSLY_SKIP_PERMISSIONS=1

When set, the Claude Code adapter launches with
`--dangerously-skip-permissions` and skips both the approval-bus pipeline
and the `dontAsk` fallback entirely. The flag name mirrors the Claude
CLI 1:1 so the safety tradeoff is obvious from `ps`/logs/CI search.

This is **strictly opt-in**. Default behavior is unchanged: IM-routed
calls still surface a y/n card to the originating thread via the
approval-bus, and non-IM calls still degrade to `dontAsk` (which
respects PreToolUse hooks).

#### Precedence

1. `opts.planMode` → `--permission-mode plan` (read-only wins over bypass —
   you explicitly asked for an exploratory pass).
2. `IMHUB_DANGEROUSLY_SKIP_PERMISSIONS=1` → `--dangerously-skip-permissions`.
3. `IMHUB_APPROVAL_DISABLED=1` or no IM context or bus down →
   `--permission-mode dontAsk` (unchanged).
4. Default IM-routed → `--permission-mode default --permission-prompt-tool …`
   (unchanged).

#### Web UI

A new **Safety** card in `/settings` exposes the toggle. ON crosses a
confirmation prompt that spells out the consequence ("every tool call
will run without confirmation"); Save & Restart writes the env value to
`~/.agim/env` and re-runs the service so the change takes effect.

#### Scope

This release only touches Claude Code. Codex and OpenCode keep their
existing approval models — flipping the Safety toggle won't change how
they ask. A follow-up will add per-agent toggles if needed.

#### Risk reminder

Skipping permissions means Bash / Edit / Write / WebFetch / every other
tool runs without any human in the loop. Prompt-injection in IM
messages becomes a code-execution path. **Only enable on private or
sandboxed deployments where every IM author is trusted.**

## [1.0.7] - 2026-05-12

### Fixed — WeChat QR modal blocked by CSP

The QR image in the `/settings` page WeChat modal failed to load with:

> Loading the image 'https://liteapp.weixin.qq.com/q/...' violates the
> following Content Security Policy directive: "img-src 'self' data:"

Root cause: iLink's `qrcode_img_content` API field returns a **WeChat
short URL**, not an image — that URL is meant to be **encoded into a QR
code** that the user scans with the WeChat app on their phone. The CLI
flow prints the URL as text and the user is expected to look at it; the
browser flow tried to use it directly as `<img src=…>`, which both
mis-renders (the URL serves an HTML landing page) and gets blocked by
the page's strict CSP.

Fix: the server now generates a PNG data URL from that text using the
`qrcode` npm package (newly added dep). The response shape gains a
`qrImage` field — `data:image/png;base64,…` — which the frontend slots
straight into `<img src>`. The original `qrUrl` is still returned for
debugging / future fallback. No CSP changes needed.

## [1.0.6] - 2026-05-12

### Fixed — Agent toggles in the web settings page actually do something

The agent toggle in `/settings` only flipped the `.active` CSS class — it
never updated `config.agents`, so toggling an agent on or off had zero
effect on the saved config. The "Save Agents" button next to it had no
click handler at all. The "Default Agent" `<select>` likewise ignored
user changes.

All three are now wired up the same way the messenger card already works:

- Clicking an agent toggle flips it in `config.agents` (in-memory) and
  re-renders so the Default Agent dropdown reflects the new eligible set.
- Toggling off the current default auto-promotes the next still-enabled
  agent (or clears if nothing left). Toggling on an agent when no default
  is set makes it the default.
- The Default Agent dropdown now only lists agents that are BOTH enabled
  AND installed — so the saved default isn't a missing binary or a
  disabled adapter that would break routing the first time someone sends
  a message.
- Changing the dropdown updates `config.defaultAgent` immediately; the
  Save Agents button PUTs everything to `/api/config`.

## [1.0.5] - 2026-05-12

### Added — full messenger configuration + service control in the web settings page

The web console's Settings page now does what previously required the terminal:

**Messengers UI**

- **WeChat (iLink)** — toggle on + click 「扫码登录」 → modal pops a live QR code,
  polls every 1s, transitions wait → scaned → confirmed → page closes and the
  channel is auto-added to `config.messengers`. Backed by two new endpoints:
  `POST /api/messengers/wechat/qr-start` and `GET /api/messengers/wechat/qr-status?token=…`.
- **DingTalk + Discord rows added.** They were missing entirely — only Telegram /
  Feishu were on the settings page. DingTalk asks for Client ID + Client Secret
  (Stream-mode app); Discord asks for Bot Token + channel + optional allowed
  guilds/channels CSVs.
- `GET /api/config` now masks and returns `dingtalk` / `discord`; `PUT /api/config`
  honors the masked-value-means-keep convention for the new credentials too.
- The 「保存通道」 button now actually saves — previously the button rendered but
  had no click handler (regression discovered while wiring DingTalk/Discord).

**Service control card** at the top of Settings:

- One-line status badge: `Running (systemd, pid 12345, up 5h 19m)` (or `Not running`).
- Three buttons: **Restart** (default-styled), **Stop**, **Start** — auto-enabled /
  disabled based on detected service mode.
- Restart shows a "Restarting…" overlay, polls `/api/service/status` every 700ms,
  flips back to "Service restarted" once the new daemon is up. ~3-4s end to end.
- systemd-managed services use `systemctl restart <unit>`; background daemons use
  a tiny detached `node -e` helper that waits for the dying parent to release the
  port, then re-spawns. Foreground services (`agim start` in a TTY) print a
  one-liner saying "go back to that terminal" — can't safely SIGTERM someone
  else's controlling tty.

New endpoints: `GET /api/service/status`, `POST /api/service/{start,stop,restart}`.

#### Why this matters

Before 1.0.5, the only path to configure WeChat was `agim config` in a terminal
plus the QR-image stream rendered in TTY. Headless setups (mac without iTerm
attached / Linux servers / corporate laptops where you SSH'd in via VS Code)
got stuck. Now the entire happy path is web-only: `agim start --bg` → open
http://host:3000/settings → click through.

## [1.0.4] - 2026-05-12

### Added — guided service-start prompt after the config wizard

After the interactive `agim config` wizard saves, the CLI now asks the user
what to do next instead of dropping them at a bare prompt. Behaviour depends
on the current service state:

- **Not running** → prompts `Start Agim in the background now? [Y/n]`. On
  yes, spawns the detached daemon, waits for it to bind, prints the pid +
  log path + `http://<bind>:<port>` URL for the web console.
- **Background daemon already running** → prompts `Restart now so the new
  config takes effect? [Y/n]`. On yes, stops + re-spawns + prints the same
  ready line. On no, prints `agim restart` hint.
- **systemd-managed** → prompts the same restart question; on yes runs
  `systemctl restart <unit>` (falls back to printing the command when the
  user lacks root).
- **Foreground `agim start` in another shell** → can't restart from here,
  prints a one-line hint telling the user to Ctrl-C in the owning shell.

First-time install path is now: `npm install -g agim-cli` → `agim` →
"Config" → pick agents → done — prompted to start — opens browser. No
hidden "now go read the README to find `agim start --bg`" step.

Ctrl-C at the start prompt exits cleanly without dumping a stack.

## [1.0.3] - 2026-05-12

### Fixed — service crashed on startup when only an agent was configured

The non-TTY branch of the messenger-onboarding flow used to print a hint and
`process.exit(1)` whenever no messenger was in `config.json`. That made the
service unusable in any deployment that wanted **web console only** (no IM
channel), which is a legitimate setup — e.g. running Agim purely as a local
agent gateway / chat UI for Claude Code / OpenCode / etc.

Now in non-TTY mode (systemd, launchctl, docker, bgjob) the absence of
messengers is a one-line info log and startup continues normally. Web server,
ACP server, scheduler, reminder engine, memo sweeper, approval bus, MCP all
come up the same way they do with messengers configured.

Also removed the misleading `wechat-ilink` fallback that kicked in when
`config.messengers` was empty — it used to try to start the WeChat adapter
with no credentials, throwing on first message. Empty `messengers` array now
just means "no IM channels," not "secretly start WeChat anyway."

#### Upgrade

- 0.x / 1.0.0-1.0.2 boxes that started fine: nothing changes.
- New / web-only deployments: run `agim start` (or systemd unit) without a
  messenger configured — service stays up; visit `http://<host>:3000/`.

## [1.0.2] - 2026-05-12

### Removed — Web 控制台内建鉴权（登录页 / token / session cookie）

Agim 的 web 控制台（端口 3000）不再有任何内建鉴权机制：

- 删除 `/login` 页面、`POST /api/auth/login` 端点、`imhub_session` cookie
- 删除 `~/.agim/web-token` 的自动创建（web 端不再读写此文件）
- 删除 `IMHUB_WEB_REQUIRE_AUTH` 环境变量
- 静态页面 / `/api/*` / `/events` / WebSocket 升级都不再做 token / cookie 校验
- 前端代码删除所有 `X-IM-Hub-Token` header 注入与 `window.IMHUB_TOKEN` 引用

**访问控制责任完全交给上游**——反向代理、防火墙、SSH 隧道、Tailscale /
WireGuard 等。把 web 控制台暴露到 `0.0.0.0` 时务必先在 nginx / Caddy 上加一层
Basic Auth 或 OAuth2 Proxy；不要直接 HTTP 暴露公网。

#### ACP 端口（9090）保持鉴权

ACP server 是给第三方 agent 程序化调用的接口，仍走 bearer-token：

- token 文件改为 `~/.agim/acp-token`（自动生成）
- 0.x 部署的 `~/.agim/web-token` / `~/.im-hub/web-token` 仍被识别为
  legacy 回退路径，已有 ACP 调用方不会断
- 删除 token 文件 + 重启服务即可轮换

#### 升级影响

- 0.x → 1.0.2 升级：旧 `web-token` 文件留在那里也没事（web 端忽略它，ACP
  仍读它做 legacy fallback）；可手动删除。
- 任何 `X-IM-Hub-Token` header 在 web 端会被静默忽略；脚本调用 `/api/*`
  现在直接成功，**前提是你已经在反代层加了访问控制**。

## [1.0.1] - 2026-05-12

### Changed — config / workspace dir auto-detect (~/.agim/ vs ~/.im-hub/)

Follow-up to the v1.0.0 rebrand: the on-disk root is now resolved at
startup rather than hard-coded to `~/.im-hub/`. New module
`src/core/agim-paths.ts` exports `AGIM_HOME` and `AGIM_WORKSPACES`,
computed once with this priority:

1. `$AGIM_HOME` / `$AGIM_WORKSPACES` env override (legacy `$IMHUB_HOME`
   spelling also honored).
2. `~/.agim/` (or `~/.agim-workspaces/`) if the directory exists — new
   canonical name in v1.0+.
3. `~/.im-hub/` (or `~/.im-hub-workspaces/`) if the directory exists —
   legacy 0.x layout. Picked up automatically so upgraded users keep
   their data in place with **zero migration**.
4. Default to `~/.agim/` (or `~/.agim-workspaces/`) for fresh installs.

That means:
- **Upgraded 0.x user** → `agim` finds the existing `~/.im-hub/`, uses
  it. memos.db / reminders.db / sessions/ / wechat-credentials.json all
  stay where they are; nothing is moved.
- **Fresh installer on a clean box** → `agim` creates `~/.agim/`.
- **User who manually moves data** to `~/.agim/` later → `agim` switches
  to it automatically on next start.

Every hard-coded `join(homedir(), '.im-hub', ...)` and
`'.im-hub-workspaces'` literal across the codebase (22 files,
~30 call sites) was replaced with the resolved root. Modules touched:
`cli.ts`, `web/server.ts`, `core/onboarding.ts`, `core/audit-log.ts`,
`core/job-board.ts`, `core/schedule.ts`, `core/session.ts`,
`core/memos.ts`, `core/reminders.ts`, `core/acp-server.ts`,
`core/agent-cwd.ts`, `cli-ui/{paths,env-file,service,i18n}.ts`,
every messenger plugin, `scripts/migrate-gcj02-to-wgs84.ts`.

User-facing wizard strings (uninstall confirm, SMTP subtitle, workspaces
kept) now interpolate the resolved paths so the prompt accurately
reflects the actual on-disk layout instead of hard-coding the legacy
literal.

## [1.0.0] - 2026-05-12

### Changed — Brand rename: `im-hub-pro` → **Agim · 阿吉姆**

Product upgrade to v1.0 ships under a new brand:

- **English name**: `Agim` (Agent + IM, with a hint of "agile")
- **Chinese name**: `阿吉姆`
- **CLI command**: `agim` (was `im-hub-pro`)
- **npm package**: `agim-cli` (was `im-hub-pro`). npm's anti-typosquat
  policy rejected the unscoped name `agim` (too similar to existing
  `ai`/`aegir`/`gm`), so we ship as `agim-cli` and the installed binary
  is still `agim` — the package name only affects the install command
  `npm install -g agim-cli`.

Cross-cutting policy:

| Surface                                              | New                | Status |
|------------------------------------------------------|--------------------|--------|
| npm package name                                     | `agim`             | renamed |
| CLI bin command                                      | `agim`             | renamed |
| Old CLI bin command                                  | `im-hub-pro`       | **kept as alias** in the same package — existing systemd units, shell aliases, scripts continue to work |
| Console banner / help text / wizard titles           | `Agim` / `阿吉姆`   | renamed |
| Config dir                                           | `~/.im-hub/`       | **unchanged** for backwards compat with all 0.x installs |
| Workspace dir                                        | `~/.im-hub-workspaces/` | **unchanged** |
| Env vars                                             | `IMHUB_*`          | **unchanged** |
| HTTP header                                          | `X-IM-Hub-Token`   | **unchanged** |
| systemd unit name                                    | `agim.service` preferred | **legacy `im-hub.service` is still recognised** by detection / restart / stop / uninstall code paths |

What this means for users:
- New install: `npm install -g agim` → use `agim …` commands.
- Existing 0.x install: stays working unchanged. Optional upgrade is just
  `npm uninstall -g im-hub-pro && npm install -g agim`; everything else
  (config, env, data) is untouched. The old `im-hub-pro` bin command
  continues to be installed by the new package, so your systemd unit
  `ExecStart=/usr/local/bin/im-hub-pro start` keeps running.

Files touched (non-exhaustive):
- `package.json` — name + bin (with `im-hub-pro` alias) + version 1.0.0 + description + keywords
- `src/cli.ts` — banner, program name, help text, comments
- `src/cli-ui/i18n.ts` — every wizard title / status / uninstall string in
  both EN and 中文
- `src/cli-ui/service.ts` — accepts either `agim.service` or
  `im-hub.service`; `pgrep` matches both bin names
- `src/cli-ui/cmd-handlers.ts` — restart / uninstall walk both unit paths
- `README.md` + `README.zh-CN.md` — full top-section rewrite, install
  commands, migration guide, version history
- imhub-site repo — separate brand rollout for the marketing site

## [0.6.3] - 2026-05-12

### Fixed — per-platform coordinate-system handling for native location messages

User-reported regression: GPS captured via WeChat's `/memo here` H5 link
landed ~500m–1km off in both Baidu Maps and Amap. Root cause: the old code
applied `gcj02ToWgs84` to every incoming lat/lng on the assumption that any
inside-China coord came from Apple Core Location or Google's China-region
GMS (both of which serve GCJ-02). Reality is messier: WeChat's X5 webview
and Android Chrome without GMS hand `navigator.geolocation` raw WGS-84, so
the inverse GCJ offset got applied to coords that were already WGS-84 and
the stored value was shifted ~500m in the wrong direction.

New module **`src/core/coord-systems.ts`** centralises every conversion +
the per-platform "what coord system did the payload arrive in?" policy:

| Source                                | Default                 | Override |
|---------------------------------------|-------------------------|----------|
| Telegram native location              | WGS-84 pass-through     | `IMHUB_TELEGRAM_COORDS_GCJ02=1` (iOS-zh-CN users) |
| Feishu native location                | GCJ-02 → WGS-84         | (server-mandated, no override) |
| DingTalk `link` msgtype, amap.com URL | GCJ-02 → WGS-84         | — |
| DingTalk `link` msgtype, qq.com URL   | GCJ-02 → WGS-84         | — |
| DingTalk `link` msgtype, baidu.com URL| **BD-09 → WGS-84** (new)| — |
| DingTalk `link` msgtype, unknown host | WGS-84 pass-through     | — |
| H5 `/memo here` browser geolocation   | WGS-84 pass-through     | `IMHUB_H5_COORDS_GCJ02=1` (iOS Safari users) |

Two **default flips** vs. the old behavior:
1. Telegram: was always GCJ→WGS, now pass-through. Telegram Desktop +
   Android-without-China-GMS + non-China users all stop getting a phantom
   inverse offset. Apple-zh-CN-in-China users opt back in via env flag.
2. H5: was always GCJ→WGS, now pass-through. Fixes the WeChat X5 case the
   user reported. iOS Safari users opt back in via env flag.

New: **BD-09 ↔ GCJ-02 ↔ WGS-84** support. DingTalk users sharing a Baidu
Maps link no longer get a 1km-off marker (chained GCJ + BD-09 offsets).

Refactor:
- `src/plugins/messengers/{telegram,feishu,dingtalk}/*.ts` — all coord
  normalization now routes through `normalizeIncomingCoords(source, ...)`
  rather than calling `gcj02ToWgs84` directly. Each call site logs
  `event: coord.normalized, source, raw_*, wgs_*, applied` for post-mortems.
- `src/web/server.ts` — H5 `/loc` handler likewise uses
  `normalizeIncomingCoords('h5-browser-geolocation', ...)`.
- `src/plugins/messengers/dingtalk/dingtalk-adapter.ts:tryExtractLatLng`
  now also returns `source` based on URL host (amap / qq / baidu / unknown);
  this is what lets the per-source policy fire correctly.

Tests:
- `src/core/coord-systems.test.ts` — 17 cases covering round-trip math
  (WGS↔GCJ, GCJ↔BD-09, BD-09↔WGS-84) + per-source policy + env-flag
  override + out-of-China bypass + NaN guard.
- `src/plugins/messengers/dingtalk/dingtalk-link-coords.test.ts` —
  6 cases over the host classifier.

## [0.6.0] - 2026-05-12

> **核心主题**：DingTalk 钉钉作为第六个 IM 适配器加入，图片 + 语音双向支持，
> 语音直接走钉钉服务端 ASR（零延迟、中文准确率好），图片通过
> `messageFiles/download` 端点拉到本地后让 claude-code 多模态 Read 工具看。

### Added — DingTalk Stream-mode adapter (text + media)

**Connection model** — WebSocket Stream via `dingtalk-stream` v2.1.5
(official SDK). No public webhook required: SDK opens a long-lived WS to
`api.dingtalk.com/v1.0/gateway/connections/open`, handles reconnect /
heartbeat / access-token rotation internally. Bot only receives when the
user @-mentions in groups or sends 1:1 (DingTalk hard limit, same as
Feishu).

**Outbound** — REST OpenAPI under the bot's auto-rotated access token:
- 1:1 → `POST /v1.0/robot/oToMessages/batchSend`
- group → `POST /v1.0/robot/groupMessages/send`

The per-message `sessionWebhook` is NOT used — its 30 s expiry doesn't
survive multi-minute agent runs. OpenAPI works for any send.

**Inbound msgtypes** — empirically confirmed via real payload dumps
(community docs were inconsistent):

| msgtype on wire | Payload location | Adapter behavior |
|---|---|---|
| `text` | `text.content` | Pass through to agent (no change) |
| `picture` | `content.downloadCode` | Download via `/v1.0/robot/messageFiles/download` (the `pictureDownloadCode` field looks tempting but returns 500 — reserved for a different endpoint we don't use). Save under `~/.im-hub/media/dingtalk/<thread>/<msgId>.<ext>`. Append `[图片附件：<path>]` to user text. claude-code's Read tool sees the JPG. |
| `audio` | `content.downloadCode` + `content.recognition` | **Prefer the server-side ASR transcript in `recognition`** (zero latency, better Mandarin accuracy than whisper.cpp base model). Still download the source AMR for archive/replay. Fall back to whisper.cpp only when `recognition` is missing. |
| `link` | `link.messageUrl` | Try `tryExtractLatLng()` on the URL (handles Amap, Tencent QMap, generic `?lat=&lng=`, `?location=lat,lng`). On hit → stash in `location-context`, next user text gets the GPS prefix injected. |
| `file` | `content.downloadCode` | Acknowledge only (PDF / Word handling is a separate effort) |
| anything else | full payload | WARN-level dump to journalctl so unknown shapes surface for the next iteration |

**Filename hygiene** — DingTalk msgIds are base64-shaped
(`msgAB2pLyIgOgo6bJXw9mWAtA==`) and contain `/+=`. `safeFilenameStem()`
sanitises every non-`[A-Za-z0-9_-]` char to `_` before write, so the
files land at `msgAB2pLyIgOgo6bJXw9mWAtA__.jpg` and the path-injection
guard in `saveDingTalkMedia()` doesn't reject them.

**Config** — `{ dingtalk: { clientId, clientSecret } }` in
`~/.im-hub/config.json`. `clientId` doubles as `robotCode` for
stream-mode internal apps; we also cache the most-recent `robotCode`
from inbound messages for robustness against multi-bot setups.

**Wizard** — full per-component flow under `Configure → Messengers →
DingTalk` (bilingual). Docs walkthrough (Stream-mode bot creation in
`open.dingtalk.com`), prefilled ClientID on re-config, masked "Enter =
keep existing" for ClientSecret.

**Known platform limitations**:
- DingTalk does NOT deliver native location messages to bots (verified
  empirically — zero inbound when the user shares a location).
  Workaround: `/memo here <what>` capture link, or type the address and
  let the agent geocode via Baidu.
- No typing indicator API for stream bots. The 1:1 client UI shows a
  native "正在输入" hint; groups get nothing until first chunk.

**Files**:
- `src/plugins/messengers/dingtalk/{types,dingtalk-client,dingtalk-adapter,media-store,index}.ts` (new)
- `src/core/registry.ts` — registered
- `src/core/onboarding.ts` — `Config.dingtalk` shape added
- `src/cli-ui/{config-wizard,i18n}.ts` — wizard + EN/中文 strings
- `package.json` — added `dingtalk-stream@^2.1.5`

## [0.5.2] - 2026-05-11

> 0.5.0 introduced the bilingual wizard but 0.5.1 hands-on showed it had
> regressed real functionality vs. the old `im-hub-pro config <component>`
> flows — checkbox-only selection couldn't issue WeChat QR codes, prompt
> for Telegram tokens, probe agent CLI installs, etc. 0.5.2 restores all
> of that work inside the new arrow-key UI, plus fixes a pile of paper-
> cuts surfaced from real TTY sessions.

### Changed — wizard restructured as list-of-per-component menus (matches legacy `config <component>`)

**IM 渠道** is no longer a checkbox. Each messenger gets its own sub-menu
with the real configuration work the legacy flow did:

- **WeChat (iLink)** — `Configure` scans QR via
  `ILinkWeChatAdapter.startQRLogin()` + `waitForQRLogin()`; on success the
  credentials persist to `~/.im-hub/wechat-credentials.json` (existing
  adapter path) and `wechat-ilink` is added to `cfg.messengers`. Re-running
  re-issues a fresh QR.
- **Telegram** — prompts for bot token (hidden) + channel id. On
  re-config the existing token is shown masked (`••••••XXXX`) and Enter
  keeps it; channel id prefills.
- **Feishu / Lark** — prompts for App ID + App Secret with the same
  "Enter = keep existing" behavior for the secret.
- **Discord** — prompts for token + channel + allowed guilds/channels
  (comma-separated). Existing values prefill except the token (masked).
- **Email** — pure toggle since SMTP credentials live one section down.
  Enabling prints a reminder to also configure SMTP.

Each per-component menu has its own `Configure / Re-configure / Remove /
← Back` choices; status row in the list above shows
`enabled / enabled (credentials missing) / not configured` per item.

**AI agents** is also per-component now, with live CLI install detection
(`<cmd> --version` probe, copilot uses the plugin's own multi-path
`isAvailable()`):

```
Claude Code         — enabled · CLI installed
OpenCode            — not enabled · CLI installed
Codex               — not enabled · CLI NOT installed
GitHub Copilot CLI  — not enabled · CLI NOT installed
```

Per-agent sub-menu offers `Add to enabled list / Set as default /
Remove / Show install instructions / Re-check CLI installation / ← Back`.
Install instructions and `auth login` hints are localized; the legacy
flow's bash-only install text is preserved. First agent enabled when no
default exists is auto-promoted to default.

### Added — env reads now find values wherever they actually live

The wizard previously only read `~/.im-hub/env` for SMTP / Baidu prefill,
so machines where those keys were set in the systemd unit's
`Environment=` lines (the common install pattern from before the wizard
existed) showed `(unset)` even though everything was working at runtime.
New `readEffectiveEnv()` falls back through three sources for read:

1. `~/.im-hub/env` (canonical, what the wizard writes)
2. `process.env` (shell-exported)
3. `/etc/systemd/system/im-hub.service` — parsed `Environment=` lines
   (file is world-readable on standard installs, so works for the user's
   shell-invoked `im-hub-pro config`)

Writes still go to the env file only. When `hasProcessEnvOverride(key)`
detects a wizard-managed key that's set somewhere outside the env file,
the SMTP / Baidu save path prints a one-line warning:

```
⚠️  IMHUB_BAIDU_MAP_AK is also set by the running environment (systemd
unit / shell export). Saving to ~/.im-hub/env alone will NOT change the
active value — update the unit file or `unset` the shell export first.
```

### Fixed — four paper-cuts from real TTY use

1. **Duplicate language prompt** when entering `config` from the entry
   menu. `runEntryMenu()` now returns `{ action, lang }`, and the
   dispatcher in `cli.ts` reuses the picked lang. (`src/cli-ui/entry-menu.ts`)
2. **No `← Back` inside sub-sections.** Every menu and sub-menu (and
   sub-sub-menu) now has an explicit Back row — non-technical users
   should never need to discover Ctrl-C.
3. **Existing values not prefilled.** SMTP host / port / user / from now
   prefer the stored value over preset defaults. The password prompt
   accepts empty input as "keep existing" with a new "Enter = keep
   existing" hint. Baidu AK uses the same effective-env read.
4. **Agent default-agent drift was invisible.** Configs with
   `agents: []` + `defaultAgent: "opencode"` now treat the union as the
   effective enabled set, so the working default shows correctly. When
   the user explicitly disables every agent, `defaultAgent` is also
   cleared.

### Notes
- No behavior change for first-time setup; everything new is in the
  re-entry / drift-state / prefill paths.
- Verified via `tsc --noEmit` + manual TTY round-trip on the SMTP /
  Baidu / per-messenger / per-agent flows.

## [0.5.1] - 2026-05-11

### Fixed — `require() is not defined` crash entering the wizard
0.5.0 shipped three `require()` calls inside ESM modules (`package.json` is
`"type": "module"`), so the wizard crashed the moment the user picked a
language:

```
ReferenceError: require is not defined
    at menu (file:///.../cli-ui/prompts.js:37:40)
```

Fixed all three:
- `src/cli-ui/prompts.ts` — `Separator` now statically imported from
  `@inquirer/prompts`
- `src/cli-ui/service.ts` — `openSync`/`closeSync` added to the existing
  `node:fs` import
- `src/cli.ts` — replaced `require('node:child_process')` with
  `await import('node:child_process')` in the entry-menu's foreground-start
  dispatch path

No other behavior changes. v0.5.0 was tagged but never npm-published, so
this is the actual first published 0.5.x release.

## [0.5.0] - 2026-05-11

> **核心主题**：`im-hub-pro` CLI 升级成"运维主入口"——双语 + 上下键交互向导 + 完整服务生命周期管理（status / start --bg / restart / stop / uninstall）。SMTP 和百度地图 AK 终于进入 `config` 一站式配置。

### Added — 双语交互式 `config` 向导
之前 `im-hub-pro config` 是 per-component 的命令行参数式配置（`config wechat` / `config telegram` / ...），界面是纯 `readline.question` 文本提示，新用户摸不着头脑。

新增基于 `@inquirer/prompts` 的交互向导：
- **语言选择**：首次进入弹出 EN / 中文 选择器，记忆到 `~/.im-hub/cli-lang`，下次进入回车即可
- **5 个分类**（每个分类内部支持 ← Back 回根菜单）：
  1. **IM 渠道** — 多选 checkbox：微信 / Telegram / 飞书 / Discord / 邮件
  2. **AI Agent** — 多选 + 选默认 agent（Claude Code / OpenCode / Codex / Copilot）
  3. **远程 ACP agent** — 列表 + 新增 / 编辑 / 删除，支持 Bearer token 认证（输入隐藏）
  4. **SMTP**（新增）— 4 个预设（Gmail / Outlook / QQ / 163）+ Custom + Skip；写到 `~/.im-hub/env`（chmod 600）
  5. **百度地图 AK**（新增）— 输入 / 清除，写到 `~/.im-hub/env`
- **Per-spawn 持久化**：SMTP 密码、Baidu AK 一输入就落盘，wizard 半途崩了不丢
- 旧的 `im-hub-pro config <component>` 路径保留兼容

### Added — bare `im-hub-pro` → 运维入口菜单
直接敲 `im-hub-pro`（无参）不再 dump help。改成弹出 8 项菜单：
- Configure
- Show status
- Start (foreground / background)
- Restart
- Stop
- Uninstall
- Quit

非 TTY 环境（pipe / cron）仍回退到 commander 的 `--help`。

### Added — 5 个服务管理命令

| Command | 行为 |
|---|---|
| `im-hub-pro status` | 探测 systemd / background daemon / foreground；显示 pid + uptime + Web URL |
| `im-hub-pro start --bg` | 后台启动（nohup + setsid + pid 文件 + 日志到 `~/.im-hub/im-hub.log`）；裸 `start` 仍前台 |
| `im-hub-pro restart` | 自动选 systemctl restart 或 bg daemon 重启 |
| `im-hub-pro stop` | 自动选 systemctl stop 或 SIGTERM bg pid + cleanup pid 文件 |
| `im-hub-pro uninstall` | 双重确认后：停服务 → 卸载 npm 包 → 删 config.json + env + pid + systemd 单元；**保留 `~/.im-hub-workspaces/`** |

**跨平台后台启动**：Linux / macOS / WSL2 都走 `nohup`+detach 路径。macOS 上想真正开机自启仍要自己写 launchd plist（CHANGELOG 后续版本可加）。

### Added — 新模块
- `src/cli-ui/i18n.ts` — 100+ 键的 `Record<Key, string>` × `{en, zh}`，TS 编译期保证两侧同步
- `src/cli-ui/prompts.ts` — `@inquirer/prompts` 的薄包装，统一 BACK 哨兵 + UserAbortError 处理
- `src/cli-ui/lang-picker.ts` — 语言选择 + 持久化
- `src/cli-ui/config-wizard.ts` — 5 个分类的向导主体
- `src/cli-ui/service.ts` — `detectService()` / `spawnBackground()` / `stopService()` / `formatUptime()`
- `src/cli-ui/env-file.ts` — 增量更新 `~/.im-hub/env`（merge-update + chmod 600）
- `src/cli-ui/cmd-handlers.ts` — status / start / stop / restart / uninstall 实现
- `src/cli-ui/entry-menu.ts` — bare invocation 用的入口菜单
- `src/cli-ui/paths.ts` — 共享路径常量

### Changed — Feishu adapter: 移除 "🤔 思考中…" placeholder
飞书原生有打字状态指示，bot 自己再发占位文本只会把对话框搞乱（飞书还不支持 bot 消息撤回）。注释保留为什么。

### Changed — 消息回复不再加 `[opencode]` / `[codex]` / `[claude-code]` 前缀
原本为了让用户看清哪个 agent 在答，但 sticky session 下 99% 的消息都是同一个 agent，每条都加一个 `[xxx]\n\n` 反而噪音。要看当前 agent 跑 `/status` 或 `/router status`。

### New dependency
- `@inquirer/prompts ^8.4.3` — modern interactive prompts (上下键 / Space / 输入隐藏)。~80KB 加到 dist。

### Migration notes
- 老用户升级：`npm install -g im-hub-pro@0.5.0`。已有 `~/.im-hub/config.json` 全部兼容，新增 SMTP / Baidu 配置可以走新向导补充
- 想跳过新向导：`im-hub-pro config wechat` / `config telegram` 等老路径仍然能用
- 后台启动取代了之前文档里推荐的 `nohup im-hub-pro start &` 写法

## [0.4.0] - 2026-05-11

> **核心主题（两条）**：
>
> 1. **codex 也接 imhub MCP**——/remind 4 工具 + /memo 5 工具，9 个全部对它开放。三大 agent（claude-code / opencode / codex）功能对等。
> 2. **位置消息架构统一化**——Telegram / 飞书的原生位置消息原本走「pending-reply + 启发式拆词」决策链，bug 频出。新版改成 agent-driven：adapter 只缓存坐标，cli.ts 注入结构化 annotation 到用户下一条文本，agent 用 LLM 决策。删除 ~400 行启发式代码，4 个 IM 渠道行为完全一致。

### Refactored — Telegram + 飞书位置消息走 agent-driven 决策（对齐 WeChat H5 流程）
**问题**：旧流程 adapter 拿到原生 pin → setPending → ask "回 y/n/名字" → cli.ts 跑 `memo-what-extract` 启发式（剥前缀 / cut at verb / `的`-split / LLM 兜底 / slice 兜底）→ save_memo。这条链跑出过的 bug 包括：
  - "记下，这是一个好吃的日料店" → what="记下"（前缀没剥）
  - "我车暂时停这里，晚点过来取" → what="车暂时"（state 词没识别）
  - "这是我公司地址，记录下" → what="这"（demonstrative 没剥）
  - "一个好吃的日料店" → what="一个好吃的日"（slice 截断在「的」前）

每修一个 case 又冒出新的，根因是决策者错位——adapter 用 deterministic 代码做语言理解。

**重构**：
- 新增 `src/core/location-context.ts`：~80 行纯 TTL 缓存（5min, single-shot consume）+ `formatLocationAnnotation()`
- 删除 `pending-memo-location.ts` + `memo-what-extract.ts`（共 ~400 行）+ 它们的 test 文件
- Telegram adapter：`message:location` / `message:venue` 改成 `setLocationContext` + 简短 ack（"📍 位置已收到 (lat, lng)。告诉我要做什么。"）
- 飞书 adapter：`message_type:'location'` 同上
- cli.ts：agent dispatch 前如果有缓存的位置，把 `[user just shared location: lat=…, lng=…, name="X", address="Y", accuracy_m=N]` 前缀拼到 `ctx.message.text`，单次 consume 后清除
- `save_memo` MCP tool description 新增 "📍 LOCATION ANNOTATION" 段，教 agent 识别这个 tag、直接用 lat/lng、不要再调 `request_location_capture`

**用户感知变化**：
- bot 不再问 "回 y/n"——直接看用户下一条说什么，agent 用 LLM + 整段上下文决策
- 任何长句、短词、混合表达都不再走启发式：「这是我公司」「记下日料店」「不用记了」「这是哪里」都自然处理
- 每个 pin 后续消息额外付出一次 agent 调用（旧版是 deterministic 直存）；用稳定性换费用

### Added — codex 也能用 imhub MCP 工具
（这一段已在 0.4.0-rc1 时落地，下面是 rc1 的内容）

之前 codex 是唯一一个 reminder/memo 工具完全无法触达的 agent，因为 codex CLI 没有 `--mcp-config` flag。验证发现 codex 0.130.0+ 支持通过 `-c mcp_servers.<name>.{command,args,env}=...` 的 TOML 内联 override 在调用层注册 MCP server——per-spawn、不污染全局 `~/.codex/config.toml`。

实现：

- **`src/plugins/agents/codex/build-mcp-cli-args.ts`**：纯函数，输入 `{sockPath, runId}`，输出 6 个 argv entries（3 对 `-c key=value`）。TOML 转义走 `JSON.stringify` 兼容 basic-string 语法。共享 claude-code 那个 `mcp-approval-server.js`（同一个二进制读 `IMHUB_APPROVAL_SOCK + IMHUB_RUN_ID`，已经 channel-agnostic）。
- **`codex/index.ts` 的 `prepareCommand`**：fallback 三道闸——`IMHUB_APPROVAL_DISABLED=1` / `approvalBus.getSocketPath()` 空 / 无 IM context 任一不满足就降级到无 MCP 模式，codex 仍能正常调用。命中时生成 UUID runId → `approvalBus.registerRun(runId, ...)` → MCP `-c` 参数前置到 argv 头部（codex 的 clap 要求全局参数在 `exec` 之前）→ `cleanup` 在 spawn 退出后 `unregisterRun`。
- **`codex exec resume` 不再接 `-s`**（codex 0.130 改的）：resume 路径继承原会话 sandbox，传 `-s` 直接 `unexpected argument` 报错。修复：sandbox flag 仅在 fresh `exec` 加。
- **`--dangerously-bypass-approvals-and-sandbox`**：codex 在 `exec --json` 非交互模式下默认会 auto-cancel 所有 MCP 工具调用（找不到 TUI 让用户点 approve）。这个 flag 是 codex 0.130 目前唯一让 MCP 工具在非交互模式下能实际运行的方式。代价是 codex 自己的 bash/edit 也失去 sandbox。提供 `IMHUB_CODEX_SAFE_MODE=1` opt-out（代价：MCP 工具不可用）。
- **AGENTS.md 写明命名差异**：claude-code/opencode 暴露 `mcp__imhub__save_memo`；codex 暴露 bare name `save_memo`。模型按错名调用会静默失败。

**版本下限**：codex CLI ≥ 0.130.0（`mcp` 子命令 + `-c mcp_servers.*` TOML override 同时存在的最早稳定版）。

**不在范围**：codex 自己的 Read/Edit/Bash 走 approval-bus——需要把 codex 跑成 `codex mcp-server` 让 im-hub 当 MCP client，是 v0.5.x 级别的大重构。

## [0.3.1] - 2026-05-11

### Added — codex 也能用 imhub MCP 工具
之前 codex 是唯一一个 reminder/memo 工具完全无法触达的 agent，因为 codex CLI 没有 `--mcp-config` flag。验证发现 codex 0.130.0+ 支持通过 `-c mcp_servers.<name>.{command,args,env}=...` 的 TOML 内联 override 在调用层注册 MCP server——per-spawn、不污染全局 `~/.codex/config.toml`。

实现：

- **`src/plugins/agents/codex/build-mcp-cli-args.ts`**：纯函数，输入 `{sockPath, runId}`，输出 6 个 argv entries（3 对 `-c key=value`）。TOML 转义走 `JSON.stringify` 兼容 basic-string 语法。共享 claude-code 那个 `mcp-approval-server.js`（同一个二进制读 `IMHUB_APPROVAL_SOCK + IMHUB_RUN_ID`，已经 channel-agnostic）。
- **`codex/index.ts` 的 `prepareCommand`**：fallback 三道闸——`IMHUB_APPROVAL_DISABLED=1` / `approvalBus.getSocketPath()` 空 / 无 IM context（threadId+platform+channelId）任一不满足就降级到无 MCP 模式，codex 仍能正常调用。命中时生成 UUID runId → `approvalBus.registerRun(runId, ...)` → MCP `-c` 参数前置到 argv 头部（codex 的 clap 要求全局参数在 `exec` 之前）→ `cleanup` 在 spawn 退出后 `unregisterRun`。
- **测试**：39 个新单测覆盖 builder（argv shape + TOML 双引号/反斜杠/UUID/空格路径 escaping）+ adapter（fallback 三道、happy path、runId 嵌入、cleanup、cwd+planMode+resume 与 MCP -c 共存、并发产生不同 runId）。

**仍然不做**：

- codex 自己的 Read/Edit/Bash 走 approval-bus——CLI 没 hook，需要换成 `codex mcp-server` mode + 我们当 MCP client，是 v0.5.x 级别的大改造
- 全局 `~/.codex/config.toml` 写入——这次坚决走 per-spawn -c 路径，不修改用户配置

**版本下限**：codex CLI ≥ 0.130.0（`mcp` 子命令 + `-c mcp_servers.*` TOML override 同时存在的最早稳定版）。adapter 不主动探测版本——老版本 codex 看到不认识的 `-c` key 会忽略，所以最坏情况是 reminder/memo 工具不可见但 codex 正常跑。

## [0.3.1] - 2026-05-11

> **核心主题**：把 `/memo` 的位置感知从「只有 H5 抓 GPS」一条路扩成「**Telegram / 飞书原生位置消息 + H5**」三条路。顺带把所有渠道的中国坐标系偏移问题彻底修了——iOS/Android Core Location 在境内吐 GCJ-02，再走 WGS→GCJ 的 amap 链接就成双重偏移，~500m-1km 翻车。

### Added — Telegram 原生 `message:location` + `message:venue` 消息支持
之前 telegram adapter 只接 text/photo/document/voice/audio/video/video_note/animation 八种事件，**完全忽略**用户点📎→Location 发的 pin。现在加上 grammy 的 `bot.on('message:location')` + `bot.on('message:venue')` 双 handler——

- 收到 pin → 通过新建的 `pending-memo-location.ts`（TTL 5min，threadKey-scoped，结构对齐 `pending-reminder.ts`）暂存 `{lat, lng, accuracy?, venueLabel?, venueAddress?}`
- adapter 立刻 reply 「📍 收到位置 (lat, lng)，要记一笔吗？回个名字 / `n` 跳过」
- 用户下条 text 消息走 cli.ts 新加的 `tryConsumePendingMemoLocationReply` 拦截（位置：在 reminder-confirm 之前、agent dispatch 之前），cancel 模式直接放弃，否则用回复文本当 `what` 调 `createMemo({where_lat, where_lng, where_label, what})`
- Venue 模式额外支持 `y` 确认（直接用 venue title 当 `what`，省去重打字），改名也支持
- 20 单测覆盖 store + reply-consumption 矩阵

### Added — 飞书原生 `message_type: 'location'` 消息支持
飞书 IM 协议本身有结构化位置消息，content 是 `{ name?, address?, latitude, longitude }`（注意 lat/lng 是字符串需要 parseFloat）。adapter 之前是纯文本，只解 `content.text`。现在 BEFORE 那一步加分支，命中 location 类型就走同一条 pending-memo-location 链路，跟 telegram 完全对齐。Venue 形态（带 name）支持 `y` 确认，无 name 时退到自由输入。

### Added — `memos.memo` 列：保存用户原话，不丢长信息
之前用户回 telegram pending prompt 时说一整句话（"我车暂时停这里，晚点过来取"），整句话就成了 `what`，搜索很难找。新增：

- **schema 加 `memo TEXT` 列**——idempotent ALTER TABLE 迁移（CREATE TABLE 里也加，新老 DB 都覆盖）
- **新模块 `memo-what-extract.ts`** 4 级提取策略（cheap → rich）：
  1. **short**——文本 ≤6 CJK / ≤16 ASCII + 无句号逗号 + 无主语前缀，原样当 `what`
  2. **heuristic**——剥 `我[的]?` / `本人`，找句中最早出现的状态词（暂时/今天/刚刚）或安置类动词（停/放/在/找）作为切点，前面那段当 `what`。能确定性 handle "我车暂时停这里" → "车"
  3. **llm**——`callHelperForJson` 调用户当前活跃 agent，给个 strict JSON-only prompt，6s 超时
  4. **fallback**——前 6 字符切片，保证 save 不会因为提取失败而阻塞
- **`search_memos` query 加上 memo 字段**：现在搜全文也能命中
- **`save_memo` / `update_memo` MCP 工具加可选 `memo` 参数**：agent 直接落库时也能用
- **`summarizeMemo` 返回带 memo 字段**——搜索结果让 agent 能引用原话
- 用户可见：保存回复多一行「记录原文：...」当提取出的 `what` 跟用户原话不一样时
- 17 单测覆盖 short/heuristic/fallback 各路径 + emoji / 中英混合 / 长句不卷死等 adversarial 输入

### Fixed — 中国境内坐标双重偏移（影响 Telegram + 飞书 + H5 三条路径）
**根因**：iOS Core Location（Apple，iOS 7+）和 Android Google Play Services 都会在中国境内**主动**把 WGS-84 偏移成 GCJ-02 才交给应用层（合规要求）。Telegram / 飞书 / 浏览器 `navigator.geolocation` 都吃这个偏移，传给 im-hub 时已经是 GCJ-02。我们当 WGS-84 存入库，构 amap URL 时再做一次 WGS→GCJ-02 = 双重偏移，~500m-1km。

**修复**：

- **新函数 `gcj02ToWgs84()`**：已有 `wgs84ToGcj02()` 的 Newton-iteration 逆运算，3 趟收敛到亚米级（< 1e-6 度 ≈ 0.1m）。境外（lng < 72 / > 137.83 OR lat < 0.83 / > 55.83）自动 no-op
- **Telegram adapter**：`message:location` + `message:venue` handler 都先 GCJ→WGS 再 setPending
- **飞书 adapter**：`message_type: 'location'` handler 同样转
- **`/api/loc` POST**（H5 抓 GPS 入口）：同样转
- **`src/scripts/migrate-gcj02-to-wgs84.ts`**：一次性回填脚本，dry-run + write 模式，幂等（境外行跳过）。本机部署时已对 DB 里 7 行历史 memo 跑过——所有坐标平均西南偏移 ~500m，回到真实物理位置
- 6 个新单测：6 城（北京/杭州/上海/广州/乌鲁木齐/兰州）round-trip < 1e-6 度，境外 no-op，方向校验（GCJ→WGS 应向西南偏移）

### Added — 部署脚本自动迁移坐标
没加。该迁移是 one-shot 性质，加在 startup 路径上反而每次重启重跑（虽然 outOfChina 已 no-op，但 1e-7 浮点抖动还是会触发"已变更"日志）。保持手动 `node dist/scripts/migrate-gcj02-to-wgs84.js [--dry-run]` 触发。

### Fixed — Venue title 在 where_label 中保留
之前 cli.ts pending consumer 写 `where_label` 时是 `venueAddress ?? venueLabel`——`??` 让 venueAddress 优先，title 就被丢了。Telegram venue 通常两者都有（"黄龙国际中心" + "学院路77号"），title 是用户最容易认出的那条。改成 `[venueLabel, venueAddress].filter(Boolean).join(' · ')`，两者都存，搜任一 token 都能命中。回复卡片同步加一行 `📍 <title> · <address>` 让用户看见保留。

### Site (separate repo: imhub-site)
不直接绑 npm 包，但同期 imhub-site 跑了一波 optimization pass：

- 一键安装命令分 Linux / macOS / Windows 三 tab（同一份 install.sh，uname 自检；Windows 走 WSL2）
- `curl ... | bash` 改 `bash -c "$(curl ...)"`：macOS bash 3.2 + /dev/tty 重连不稳的 pipe 形式换成 Homebrew 同款
- install.sh：macOS 友好的依赖缺失提示（`brew install node` / `xcode-select --install`）+ 纯 bash JSON encoder（新版 macOS 不再预装 python3）+ launchd 提示
- SEO：robots.txt + sitemap-index.xml + og.svg
- 404 页面 + 双语支持
- 代码 DRY：install 命令抽到 `src/data/install.ts` 单一真源；JS 初始化抽到 `src/lib/install-ui.ts`
- 可达性：`role="tablist"` / `aria-selected` / keyboard navigation 完整

## [0.3.0] - 2026-05-11

> **核心主题**：`/location` 升级为通用 `/memo`（5W1H 持久记忆库），地图服务从腾讯切到百度，opencode HTTP driver 修复 SSE-broken 回归。这是个有意义的里程碑——位置只是 5W1H 中的一个轴。

### Fixed — opencode HTTP driver: SSE 不发事件时从 POST body 拿文本
opencode 1.14.45+ 在新的 `node-http-server` runtime 下 `/event` SSE 只发首个 `server.connected` 然后再不广播任何 bus 事件（`message.part.updated` / `session.idle` 全丢），导致 im-hub 这边收 0 字节，用户在微信里看到「opencode无回复」。

直 curl 复现：POST `/session/:id/message` 这个 endpoint 现在改成阻塞直至 LLM 完成，把整条 assistant message 同步以 JSON 还回来。我们就拿这个：

- `OpenCodeHttpAdapter.postPrompt` 不再 `Promise<void>`，改回 `Promise<OpencodeMessageResponse>`，把 body 解析出来
- `inspectHttpEvent` 多返一个 `partId`，SSE 路径走过的 part 都进 `yieldedPartIds`，不会被 POST 兜底重复 yield
- 新增 `drainResponseBody(body, alreadyYielded, opts)`：从 POST body 抽完成态 text part（time.end 已设、文本非空、非 reasoning / step-* 类）+ 把 cost / tokens 喂回 `opts.onUsage`
- `promptPromise.finally` 内挂 500ms grace 计时器调 `sse.close()`：旧版 opencode SSE 正常时仍走原路径；新版 SSE 一直空时让 for-await 退出，然后排掉 POST body
- 命中走 fallback 路径会记一行 `opencode.http.drained_post_body` 日志，方便排查

新增 3 单测覆盖：drained-only / SSE+POST 同 part 的 dedupe / `drainResponseBody` 的过滤逻辑。35/35 adapter 测试全过。

### Added — 部署脚本自动重启 opencode
`/root/.claude/bgjobs/scripts/imhub-deploy.sh` 末尾加一段：im-hub 重启完成后如果检测到 `opencode serve --port 14199` 还在跑，调 `opencode-restart.sh` 把它弹一遍，让新 daemon 继承当前 shell 的 `IMHUB_APPROVAL_SOCK`（im-hub 每次重启会换 socket hash，旧 daemon 还指向旧 socket → MCP 工具调用会回「后台消息服务不可用」）。一行钩子，一劳永逸。

### Added — 给 place-like memo 主动追问坐标
agent 落库一条「老孙家」「公司新址」这种**明显是地点但用户没给坐标**的 memo 后，会反问一句「要不要顺带补个坐标？」给三个选项（现在抓 GPS / 告地址解析 / 不用）。`save_memo` tool description 里写死的 PROACTIVE FOLLOW-UP 段。同一段还硬塞一份 TOOL INVENTORY 列表（5 个 memo 工具），并明令「不准跟用户说工具下线了」——之前 agent 在 location→memo 重命名后偶尔会胡说「位置工具已下线」。

### Added — `update_memo` 接受 `address` 参数走 geocoding 路径
之前 update_memo 只能直接给 `where_lat/where_lng/where_label`。现在传 `address` 字符串会自动调百度地理编码补全坐标 + 把 formatted address 当 label。配合 augment-mode token 流（POST `/api/loc` 带 memoId），用户也能在 H5 上直接补充「我现在就在那」的当前 GPS 给已存的 memo。

### Fixed — memo 时区 + 永久 location 判断
两个用户反馈直接修：

1. **不应该按"有没有 location"判断 transient/permanent**。我朋友常去的茶馆、公司新址、家庭住址这些**有 location 但应该永久**记的，之前 prompt 里把"含位置类"暗示成 24h 临时，会丢数据。
   - `save_memo` tool description 重写 EXPIRY 段：判断条件改为**内容语义**（"刚刚 / 今天 / 暂时 / 临时" → 临时；"我朋友常去 / 老地方 / 我家 / 我公司 / 重要 / 永久" → 永久），不再以 has_location 作为信号
   - 给了双向 examples：transient 案例 vs permanent location 案例，让 agent 看清差异
   - 强化 "When ambiguous, ASK" 指引

2. **时间没有时区，agent 按 UTC 计算 "明天下午3点" 会偏 8 小时**。统一按 **Asia/Shanghai (UTC+8)** 存储，bare 本地格式 `YYYY-MM-DD HH:MM:SS`：
   - 新 helpers `nowSqliteLocal()` / `toSqliteLocal(ms)` / `normalizeWhenAt(s)`
   - `createMemo` / `updateMemo`：JS 显式设 `created_at` / `updated_at` (UTC+8)；agent 传的 `when_at` / `expires_at` 走 `normalizeWhenAt` 兜底（含 `Z` / `+00:00` / `+08:00` 都正确归一）
   - `searchMemos` 的 expiry 过滤 + `whenAfter` / `whenBefore` 都用 `datetime('now', '+8 hours')` 与存储 shape 对齐
   - `sweepExpired` 同理
   - `expiresAtFrom(hours)` 改用 `toSqliteLocal(now + ms)` 而不是 `.toISOString()`
   - schema 里 `created_at` / `updated_at` 默认值改为 `datetime('now', '+8 hours')`（兜底，正常路径 JS 会显式设）
   - tool description 里 `when_at` / `when_after` / `when_before` 都说明：**Asia/Shanghai (UTC+8)，"YYYY-MM-DD HH:MM:SS"，不要带 T 也不要 Z**
   - 11 新增单测覆盖：nowSqliteLocal 形状 / toSqliteLocal +8h shift / normalizeWhenAt 各路径（Z / +08:00 / 已 local / null / unparseable）/ created_at 实际写入 UTC+8 / sweep 用 UTC+8 比较
   - 时区可调：`IMHUB_TZ_OFFSET_HOURS` env，默认 8（其他时区部署只改这一个就行）

### Changed — opencode agent 系统提示也加上 memo 工具
opencode http adapter 的 `buildImContextInstruction` system prompt 之前只提了 reminder 那 4 个工具，现在加上 memo 那 5 个 (`save_memo` / `search_memos` / `update_memo` / `delete_memo` / `request_location_capture`) 一起列出，并补一段 timezone 说明。这样 opencode 通过 HTTP daemon mode 跑时也知道要带 `_im_context` + 用 UTC+8。


### Changed — `/location` 重命名为 `/memo` + 数据模型升级到 5W1H 持久记忆库
**这是个产品级别的概念升级**：从"位置备忘"扩展到通用的"持久记忆数据库"。位置只是其中一种类型——同一个工具也能记 "爸爸的生日是5月8日"、"明天下午3点开会"、"伞放前台了"、"苹果发了 AVP2"。

- **数据模型**：`location_memos` 表整体替换为 `memos` 表，每行携带 5W1H 可选字段 — `what` (必填，核心事项) / `who` / `when_at` / `when_text` / `where_lat` / `where_lng` / `where_label` / `how` / `why`，加 `expires_at` 生命周期列（NULL = 永久）+ `source` + `created_at` + `updated_at`
- **slash 命令**：`/location` 整体下线，改为 `/memo`（别名 `/记` `/note`）。`/memo list/show/delete/here/help` 子命令保留，新增 `/memo search <query>` 直接搜，无子命令的纯文本也走 search
- **MCP 工具组**（agent-driven）：4 个旧 location 工具替换为 5 个 memo 工具——
  - `save_memo({what, who?, when_at?, when_text?, where_*?, address?, how?, why?, expires_in_hours?})` — 通用落库；agent 从用户自然语言抽 5W1H
  - `request_location_capture({what?, memo_id?})` — 一次性 GPS 链接。可选 `memo_id` 触发 UPDATE 已有 memo 的 `where_*`（之前只能 CREATE）
  - `search_memos({query?, who?, what?, has_location?, when_after?, when_before?, include_expired?, limit?})` — 多字段 AND-combined 检索
  - `update_memo({id, ...fields})` — patch 模式，null 清空 / undefined 不动
  - `delete_memo({id})`
- **Tool description prompt 工程**：每个工具描述给 3-5 个具体例子（"我爸爸的生日是5月8日" → save_memo 拆出 what/who/when_text）；明确 `expires_in_hours` 的判断指引（含"暂时/临时/今天"等关键词→24h，"永久/记住/总是"等关键词→不传）；明确告诉 agent 用 markdown 链接 `[百度地图](url)` 格式回复
- **生命周期分层**：默认所有 memo 永久；agent 判定为临时性内容（停车、当天会议）才 set `expires_in_hours`。后台每 5 分钟跑一次 `sweepExpired()` DELETE `expires_at <= now` 的行
- **token meta 升级**：`note` → `what`，新增 `memoId` 字段。POST `/api/loc` 拿 token 时根据 memoId 决定 CREATE 新 memo 还是 UPDATE 已有 memo 的 `where_*`
- **H5 页**：根据 token 是 create 还是 augment 模式显示"正在记录: <what>"或"正在补充'<existing what>'的位置"
- **wire-protocol 升级**：approval-bus 上 `type: 'location'` / `'location.result'` → `type: 'memo'` / `'memo.result'`；ApprovalClient 的 `requestLocation` → `requestMemo`
- **数据迁移**：用户决定不迁移老 `location_memos` 表数据（从 0 重新开始）。老 `locations.db` 文件留在磁盘上但不再被打开
- 13 单测 `memos.test.ts` (含 SQLite-skipped CRUD 9 条) + 7 单测 `memo-rpc.test.ts` (含 9 个 SQLite-skipped agent-flow case)


### Added — H5 地图预览 + 拖拽微调
- `loc.html` 加载 Leaflet + OpenStreetMap 瓦片（无需密钥、免商业授权）。授权 GPS 后展示当前坐标的地图视图，初始 marker 放在浏览器返回的位置上，外圈叠一层蓝色 accuracy 圆圈让用户直观感受 ±N米的不确定性。
- **微调操作**：长按 marker 拖动、或点击地图任意位置 marker 跳过去；坐标框实时更新。
- 新两按钮：`✅ 确认提交这个位置`（POST 当前 marker 坐标）/ `🔄 重新获取定位`（清除 marker，回到第 1 步重抽 GPS——某些情况第二次精度更高）。
- **优雅降级**：CDN 屏蔽 / Leaflet 加载失败时（`typeof L === 'undefined'`），地图区隐藏 + 提示文案改成"网络限制？无法微调"，但同一个"确认"按钮仍可直接提交浏览器抓的原始坐标。
- 三步卡片视觉：`获取位置` → `地图微调` → `已发送`，布局清晰，每一步只露一个 primary action。

### Changed — Token 短链
- Token 从 32 hex char (16 bytes) 缩到 12 char base64url (9 bytes random，~10^16 keyspace；single-shot + 10min TTL 下绰绰有余）
- URL 路径从 `/loc?t=<32hex>` 改为 `/l/<12base64url>`，总长度 70+ char → ~38 char。微信里展开占 1 行而非 2 行
- `/loc?t=` 老路径同时保留——已发出去尚未消费的 token 不会断
- `loc.html` 同时识别两种 URL shape，自动降级

### Added — 三家地图任选（百度 / 高德 / Google）
- 用户在 IM 里收到的位置消息现在同时给出 **百度 / 高德 / Google** 三条地图链接，根据自己习惯任选——之前默认只挂百度
- 新增 `mapUrls(lat, lng, label?, addr?)` 工具：返回 `{ baidu, amap, google }`，三家分别对接：
  - 百度：`api.map.baidu.com/marker` + `coord_type=wgs84`（继承之前的实现）
  - 高德：`uri.amap.com/marker` —— **必须把 WGS-84 → GCJ-02 转换后再发送**（高德内部用 GCJ-02，参数 `coordinate=gaode` 提示）
  - Google：`google.com/maps?q=lat,lng`（WGS-84 原生，直接透传）
- 新增 `wgs84ToGcj02(lat, lng)`：标准的"中国加密偏移"转换公式（A=6378245.0, EE=0.00669342162296594323），中国大陆境内偏移 ~300-700m，境外（HK/MO/TW/海外）原样返回
- 调整三处用户可见输出：
  - `POST /api/loc` 推回的"✅ 已记录" 消息列出 3 条链接
  - `/location show <id>` 命令详情列出 3 条
  - `mcp__imhub__save_location` 和 `list_locations` 工具返回结构加 `mapUrls: { baidu, amap, google }` 字段；旧 `mapUrl`（百度）保留向后兼容
  - MCP 工具描述告诉 agent 优先把三条都展示给用户挑

### Changed — 地图服务从腾讯切到百度
- **地理编码**：`apis.map.qq.com/ws/geocoder/v1/` → `api.map.baidu.com/geocoding/v3/`，强制 `ret_coordtype=wgs84ll`（百度默认返 BD-09，必须显式拉 WGS-84 才和浏览器 `navigator.geolocation` 一致——否则存库坐标 vs 浏览器坐标 50–500m 飘移）
- **凭据 env**：`IMHUB_TENCENT_MAP_KEY` / `IMHUB_TENCENT_MAP_SK` → `IMHUB_BAIDU_MAP_AK`（默认 key 流程不需要 SN 签名；如以后开启 SN 校验，文档说明在 `src/core/locations.ts` 头注释里）
- **地图 URI scheme**：默认从 `apis.map.qq.com/uri/v1/marker?...` 改为 `api.map.baidu.com/marker?location=lat,lng&coord_type=wgs84&...`（注意 `coord_type=wgs84` 关键，否则百度按 BD-09 解读飘 50–500m）
- 错误码分类重写：百度状态码体系不同（200/201/202 = 签名 / Referer / IP；401-405 = 配额；1-4 = 找不到/参数错；5/210/211/220/240 = 各种权限 / 配额家族）
- **腾讯 SK 签名代码移除**：`signTencent` 函数 + 4 条相关单测删除。Baidu 默认 key 流程不需要签名；如以后开启 SN 校验，算法是 `MD5(URLencode(path?qs+sk))`（与腾讯的 `MD5(path?raw_qs+sk)` 不同 —— 多一步整体 URL 编码），实现可参考头注释
- 用户消息文案更新：错误提示里 `lbs.qq.com` → `lbsyun.baidu.com`
- **不影响**：已有的 `location_memos` 数据（坐标统一是 WGS-84，不需要迁移）；坐标输入路径（`/location 39.9,116.4`）；H5 浏览器 geolocation 流程

### Added — Location MCP 工具（agent-driven 自然语言交互）
- 新增 4 个 MCP 工具，agent（claude-code / opencode）按需调用——**不加 detector，不拦截消息流**。直接利用 agent 已有的语义理解：
  - `request_location_capture(note?)`：用户想记当前 GPS（"我把车停这"），返回一次性 H5 URL 给 agent 念给用户
  - `save_location({ lat, lng } | { address }, note?)`：agent 已有坐标或地址时直接落库（绕过 H5）；address 路径走腾讯地图地理编码
  - `list_locations(query?, limit?)`：用户问"我的车在哪"时调，模糊匹配 label + note，按时间倒序返回
  - `delete_location(id)`：用户说"删了车的记录"
- 数据流（NL 记录 + NL 查询）：
  ```
  用户 "帮我记下车停这了" → claude 看到 4 个工具
   → claude 调 request_location_capture({note:'车'})
   → bus → location-rpc → 发 token + 返 URL
   → claude 回用户 "好的，点开链接授权: <url>"
   → 用户点 → H5 显示 "正在记录: 车" → 授权 → POST → 写库
   → im-hub fire-and-forget 推回 "✅ 已记录'车' lat,lng [地图]"
  ```
  ```
  用户 "我的车在哪" → claude 调 list_locations({query:'车'})
   → bus → location-rpc → SQL LIKE → 返结果
   → claude 自然语言回 "🚗 你 5 小时前记录的车: ..."
  ```
- 实现：
  - 新建 `src/core/location-rpc.ts` — 4 op handlers，与 `reminder-rpc.ts` 结构对齐
  - `src/core/locations.ts` 加 `searchMemos(opts)`，SQL LIKE ESCAPE 处理 `%` `_` 字面量
  - `src/core/location-token.ts` 加 `note` 字段 + `peekToken()`（只读不消费）
  - `src/web/server.ts` 加 `GET /api/loc/info?t=…` 让 H5 拿 server-stored note 显示
  - `src/web/public/loc.html` 加 "正在记录: <note>" 蓝色信息条
  - `src/core/approval-bus.ts` 加 `type:'location'` dispatcher，复用 runId/`_im_context` 双路径
  - `src/plugins/agents/claude-code/mcp-approval-server.ts` 加 `requestLocation` client + 4 工具注册（claude-code 和 opencode 共享同一个 sidecar 二进制，自动可见）
  - 同时把 `POST /api/loc` 改为读 token 中的 server-side note 作为 memo label（防 URL 篡改）
- 18 单测 `location-rpc.test.ts`（含 9 个 SQLite-skipped CRUD case）+ 现有 `location-token.test.ts` 7 条全过。
- **架构权衡**：放弃了 `remind-intent.ts` 那种"消息流前置正则探测器"模式。reminder 的 detector 是历史遗留，每条消息都跑一次额外 LLM 调用（就是修过 80s→3s 那个性能问题的祸根）。location 直接让 agent 看工具描述自己判断，零额外 LLM 调用、零误触代价、对话上下文连续。

### Added — `/location here` 浏览器 GPS 捕获
- 新子命令 `/location here [备注]` 或 `/location 当前 [备注]`：bot 回一个一次性 HTTPS 链接，用户在 WeChat 内置浏览器点开，授权后 H5 页面调 `navigator.geolocation.getCurrentPosition` 把坐标 POST 回 im-hub，im-hub 写库 + 推回 IM 线程。
- 数据流：`/location here` → 内存 token store 发 32 hex token (10 min TTL，single-shot) → 用户点 URL → `GET /loc?t=...` 渲 H5 → 用户授权 → `POST /api/loc { t, lat, lng, accuracy }` → 验 token → 写 `location_memos`（source=`browser`）→ messenger.sendMessage 把"✅ 位置已收到 + 地图链接"回推到原线程。
- **默认 base URL**：`https://agent.iclaw.host`（公共托管入口）。自托管用户可设 `IMHUB_LOC_BASE_URL=https://your-host` 覆盖。OSS 用户没有 HTTPS endpoint 时可继续用坐标输入路径。
- 新建 `src/core/location-token.ts`：内存 Map，60s 一次的 sweep timer 清过期；test/diagnostic 钩子 `_pendingCount` `_clearAll` `_stopSweep`。
- 新建 `src/web/public/loc.html`：单页 H5（无构建依赖、纯内联 CSS+JS），蓝主题与 imhub-site 视觉一致。错误分支覆盖：缺 token / 浏览器不支持 / 用户拒绝授权 / 网络错误。
- 新增 `src/web/server.ts` 公开路由 `GET /loc` + `POST /api/loc`，放在 auth gate 之前（token 即凭证）。`POST /api/loc` 失败时分类回 410（链接过期 / 已使用）/ 400（参数错）；写库/dispatch 是 fail-soft，不阻塞 H5 端 200 响应。
- **agent.iclaw.host 部署**：路由复用现有 :3000，CDN 必须配路径白名单只放行 `/loc` 与 `/api/loc`，其他路径（`/tasks` `/reminders` `/api/*`）必须在 CDN 层 404，否则操作员控制台会被外网暴露。
- 7 单测 `location-token.test.ts`：issue/consume 圆环、单次消费、过期回收（Date.now stub）、多 token 独立、跨用户隔离。

### Added — `/location` 位置备忘（基础版）
- 新 slash 命令 `/location`（别名 `/loc` `/位置`）：记录"在 X 位置干了 Y 事"型备忘。
- **零依赖坐标输入**：`/location 39.908,116.397 [备注]` —— 支持 `,` `，` 或空格分隔，负数支持。
- **可选地址解析**：`/location 国贸三期 [备注]`，需配置 `IMHUB_TENCENT_MAP_KEY`（[lbs.qq.com](https://lbs.qq.com) 注册免费 key）。无 key 时给友好错误提示，引导用户用坐标路径。
- **腾讯地图 SK 签名支持**：开启了"WebServiceAPI 强制签名校验"的 key 配 `IMHUB_TENCENT_MAP_SK`，自动 MD5 签名。算法：参数按 key 字典序排序、用未 URL-encode 的原值拼 `k=v&...`、与 `path?qs+SK` 整体 MD5 → 32 位 lowercase hex。已对照官方 API 实测验证。
- **细分错误反馈**：地理编码失败按状态码分类（`signature`/`quota`/`not_found`/`http`/`unknown`），命令直接告诉用户是配额满了还是签名错了或地址不对。
- 子命令：`list [N]` / `show <id>` / `delete <id>` / `help`，全部 per-user owner-scoped（同 `/remind` `/cron` 模式）。
- **地图链接回显**：每条记录附 `https://apis.map.qq.com/uri/v1/marker?...` URI，WeChat 内置浏览器/地图 App 可直接唤起。
- 数据：`~/.im-hub/locations.db`（路径可通过 `IMHUB_LOCATIONS_DB` 覆盖），fail-soft via 现有 `sqlite-helper`。
- 18 单测：坐标解析（中文逗号 / 负数 / 范围校验）、地图 URL 构建、地理编码 env 探测、SK 签名（含 reference fixture）、CRUD 全流程 + owner scoping。
- **不包含**：浏览器 geolocation 链接（Phase 2，要求 HTTPS endpoint），LLM 自然语言识别（Phase 3）。

## [0.2.41] - 2026-05-10 — 移除 WeChat 思考中占位气泡

### Removed
- **WeChat `🤔 思考中…` 占位气泡**：原本在 cli.ts:591 调 `messenger.sendThinking` 给 wechat 发的 placeholder。理由：iLink 不支持 recall，气泡永久留在聊天里污染历史；原生 typing 指示器（`sendTyping`）已 1.5 个月稳定运行；remind-intent perf 修复后平均回复延迟 80s → 3s，"以为机器人挂了"的窗口几乎消失；CRLF 修复也让真实回复的视觉强度足够。改动：删 `wechat/ilink-adapter.ts:sendThinking`，cli.ts 已用 `if (messenger.sendThinking)` 自动 fallback。Feishu 保留（其 sendTyping 是 no-op，气泡是唯一信号）。

## [0.2.40] - 2026-05-10 — 只读工具自动放行 + WeChat 换行修复

### Added — 只读工具自动放行（默认开启）
- 新增 `READONLY_TOOLS` 短路：`Read` / `Grep` / `Glob` / `LS` / `NotebookRead` 这 5 个 Claude Code 原生只读工具的审批请求在 `approval-bus._registerPending` 入口被直接放行——不建 pending、不通知、不写 IM 卡片。零 IM 往返，给 LLM 自由探索代码而不打扰用户。
- 全局开关：`IMHUB_AUTOALLOW_READONLY=0`（默认 1）关闭。
- per-thread 开关：`/approval readonly off|on`（别名 `/approval ro`）。仅本会话内存生效，重启后回到全局默认。
- 审计：每次短路写一行 `approval.bus.readonly_auto_allow` info log，并在 metrics 新增 `totalReadonlyAutoAllowed` 计数。
- `/approval`（无参）和 `/approval readonly` 都会显示当前状态行 `🛡 只读自动放行：开启 ...`。
- 保守白名单：**不**包含 `Bash`（无法静态判断 `cat` vs `rm`）、`WebFetch`/`WebSearch`（出站 HTTP）、任何 `mcp__*`（第三方 MCP 工具语义未知）。这些走原审批流程不变。
- 测试：`approval-bus.readonly.test.ts` 11 条（每个 readonly 工具 + 5 条边界）+ `approval.test.ts` 4 条新 case。

### Fixed
- **WeChat 文本换行渲染**：`ILinkClient.sendMessage` 把 outbound 文本里的 `\n` 替换为 `\r\n`。iLink Bot API 要求 CRLF；只发 LF 时部分微信客户端会吞换行，多行消息渲染成单段。

## [0.2.39] - 2026-05-10 — WeChat 回复延迟修复 + `/help` alias 解析

### Fixed
- **WeChat 回复延迟（remind-intent 误触）**：v0.2.37 引入的 reminder 意图识别在 cli.ts 上每条非 slash 消息都跑一次预过滤。预过滤正则里有一组独立的"强意图动词"分支 `(提醒|通知|叫我|喊我|告诉我|记得|别忘了|提醒我)` —— **不要求带时间词**。日常会话里 `告诉我XXX`/`通知XXX`/`记得XXX` 都中招，触发一次 5–10s 的 helper-LLM 调用 `await` 在真正的 agent 回复之前，最终用户感知"每条消息都慢 5–10s"。修复：删掉这个动词分支。下游 LLM 没有时间词也产不出 `fire_at_iso`（remind-intent.ts:164 会拒），所以这一分支本来就是 100% 浪费。真正想设提醒的自然表达都带时间词（`明天9点提醒我开会`），仍能命中其他分支。新增 5+4 条测试覆盖。**实测**：WeChat 平均回复 ~80s/avg → 3s/avg。

### Changed
- **`/help <alias>` 自动解析**：`/help tasks` `/help check` `/help cancel` `/help switch` `/help collect` 都解析到 `/help job`；`/help auto` → `approval`；`/help models` → `model`；`/help ws` → `workspaces`；`/help reminder` → `remind`。alias 表 `TOPIC_ALIAS` 与 dict 解耦，避免维护重定向字符串。
- 同时清理 `EN_TOKENS` / `ZH_TOKENS` 里早期防御代码遗留的 `'english:'` `'cn:'` 噪音 token。

## [0.2.38] - 2026-05-10 — `/schedule` → `/cron` 命名空间清理 + `/help` 改造

### Changed — `/help` / `/start` i18n + 重写
- **默认中文**（与 `/remind` `/cron` `/audit` 等其它命令的中文文案保持一致），`/help en` / `/start en` 切英文。
- **补全所有遗漏命令**：原本只有 ~10 条，现在覆盖 `/cron` `/remind` `/job` `/tasks` `/check` `/cancel` `/switch` `/collect` `/model` `/models` `/think` `/plan` `/approval` `/auto` `/audit` `/stats` `/sessions` `/workspaces` `/router` 等。
- **按分类分区块**：会话 / 提醒 · 定时 / 任务 / Agent 控制 / 工具审批 / 运维 / Agent 子命令。
- **`/help <topic>` 子命令**：`/help remind`、`/help cron`、`/help job`、`/help approval`、`/help workspaces` 等都返回该命令的详细帮助；`/help remind` 直接复用 `/remind help`。
- **`/?` 别名 `/help`**。
- 实现：`ParsedMessage` 的 `command` 变种新增可选 `args`，router 把 `/help` `/start` 后面的内容当 args 透传。


### Changed
- **`/schedule` 重命名为 `/cron`**——避免和 Claude Code 内置 `/schedule` skill（Anthropic 云端 routines）撞名导致 LLM 误解。
  - 主名：`/cron list|create|delete|enable|disable|check`，语义和老 `/schedule` 完全相同。
  - 老 `/schedule` 仍能用，但首行返回 `⚠️ 已重命名为 /cron` 迁移提示。计划在 **v0.4.0** 移除 `/schedule` 别名。
  - 引擎模块名（`src/core/schedule.ts`）和 REST 端点（`/api/schedules`）保持不变——纯命令面 rename，不破坏历史数据 / 外部集成。
- 文件移动：`src/core/commands/schedule.ts` → `src/core/commands/cron.ts`；导出函数 `handleScheduleCommand` → `handleCronCommand`；`ParsedMessage` 联合类型 `{ type: 'schedule' }` → `{ type: 'cron'; legacy?: boolean }`。
- README / Web tasks 页文案同步更新。

### Migration
- 用户层：把 `/schedule …` 改成 `/cron …` 即可；脚本里如果硬编码 `/schedule` 也能继续工作直到 v0.4.0。
- 集成层：`/api/schedules` REST 接口、`schedules` SQLite 表、`schedules.db` 文件路径均不变。

### Fixed
- **schedules.db 自举顺序**：`idx_sched_creator` 索引从初始化 schema 字符串里挪到 `migrateOwnership()` 之后。原先在 0.2.0 之前建的库升级到 0.2.x 时，`db.exec(schema)` 会因为 `creator_id` 列不存在直接抛错，被 helper 标记为 broken，导致后续的 `ALTER TABLE` 迁移永远跑不到——`/cron` / `/schedule` 整个子系统于是默默失效。修了这次老库会自动补列再建索引。

## [0.2.37] - 2026-05-10 — Reminders + Email + Multi-agent MCP

> 设计文档：`docs/architecture/reminders.md`

### Added — `/remind` 子系统

**核心**
- `/remind` slash command（一次性 + 定期 + 邮件 + 字面/LLM 模式）
- 时间解析：中文 NL 时长 / 时点 / 循环表达式（每天 N 点 / 每周 X / 工作日 / 周末 / 每隔 N），英文 / HH:MM / ISO
- 5 秒 tick 调度器；崩溃恢复（`firing → pending`）；7 天 fireAt 上限；50 条 / 用户配额

**LLM 增强（默认开启）**
- **F1 LLM 意图识别**：非 slash 消息走 detector，时间词正则预过滤后调当前 thread 的 active agent 抽 JSON。置信度 ≥ 0.85 弹"要不要为这件事设个提醒？"卡片，y/n 确认。可 `/remind aiwatch off` 关
- **F2 LLM 投递润色**：fire 时把字面文本作为 prompt 喂给当前 agent 重写成自然投递语（系统约束："不献媚、不过度幽默、不夸大"，≤ 80 字）。20s 超时 fallback 字面。`/remind literal …` 强制字面投递。每 N 分钟（< 1h）+ LLM 模式被拒绝（防止高频 LLM 调用）
- **Agent context snippet**：每次 agent 调用前在 prompt 前注入 ≤ 5 条 pending 提醒摘要，agent 不用主动 list_reminders 就能看到现状

**Agent MCP 工具（提醒兜底创建）**
- 4 个工具：`create_reminder` / `list_reminders` / `cancel_reminder` / `snooze_reminder`
- claude-code：复用现有 `--mcp-config` per-spawn 注入
- opencode (stdio)：`prepareCommand` 注入 `IMHUB_RUN_ID` extraEnv，全局 `mcp.imhub` config 自动注册
- opencode (http)：常驻 daemon 共享 MCP server，agent-asserted `_im_context` 兜底（**单用户限定**——agent 可伪造身份）
- codex：未实施（`codex exec` 不支持外部 MCP）

**Web 管理**
- `/reminders` 页面（dark mode、状态筛选、取消、延后）
- 3 个 REST endpoint：`GET /api/reminders`、`POST /api/reminders/:id/cancel`、`POST /api/reminders/:id/snooze`

### Added — 邮件投递通道
- 注册为 `email` messenger（`threadId` 即邮箱地址）
- nodemailer + Gmail / QQ / 163 / 任意 SMTP（env：`IMHUB_SMTP_HOST/PORT/USER/PASS/FROM/SECURE`）
- `/remind email <addr> <time> <text>` 内联 / `/remind bindemail` 绑定默认 / `/remind email <time> <text>` 走默认
- 邮件 + 循环 + LLM 润色组合自由

### Added — WeChat context_token 持久化
- iLink Bot API 30 分钟 context_token TTL 之前只存内存，重启即丢，导致循环提醒在 wechat 端高概率失败
- 新 SQLite 表（`~/.im-hub/wechat-context.db`），收消息时写穿，启动时 warm 内存 Map，cleanup 同步清 DB

### Schema migrations
新建 / 扩展三张表（在 `reminders.db` 内）：
- `reminders` 主表：`recurrence` `last_fired_at` `prompt_mode` 三列追加（idempotent ALTER）
- `user_email_bindings`
- `user_aiwatch_settings`

新独立 SQLite：`wechat-context.db`

### Tests
新增 7 个测试文件，~50 个新 case：`agent-helper`、`pending-reminder`、`remind-intent`、`reminder-rpc`、`email-adapter`、`wechat-context-store`、扩展的 `reminders.test.ts`。bun test 1033 pass / 34 skip / 0 new fail。

### Dependencies
- `nodemailer ^8.0.7`

### Known limitations
- opencode http 多用户场景不安全（`_im_context` 可伪造）；多用户部署应选 stdio 或 claude-code
- `/api/reminders` 无 per-user owner-scoping（单运营者部署）
- codex 暂无 MCP reminder 工具（重写需 ~5h，下一轮专项）
- F1 detector 时区跟随 server `toLocaleString()`

---

## [0.2.35] - 2026-05-09

### Added — WeChat & Telegram rich media support

- **WeChat 图片 / 文件 / 语音 / 视频接收**：`handleIncomingMessage` 现在处理 iLink `item_list` 的全部 5 种类型（TEXT=1, IMAGE=2, VOICE=3, FILE=4, VIDEO=5），此前只处理 TEXT。
  - **图片**：通过 iLink CDN 下载到 `~/.im-hub/media/wechat/<userId>/`，转为 `[图片附件：/path]` 标记传递给 Agent
  - **语音**：优先使用微信自带转写（`voice_item.text`），无转写时下载音频后走 OpenAI Whisper 或 whisper.cpp（复用 `src/core/transcribe.ts`）
  - **文件**：下载并保留原始文件名，显示大小，转为 `[文件附件：/path (name, size)]`
  - **视频**：下载并显示时长和大小，转为 `[视频附件：/path (duration, size)]`
  - **混合消息**：同一条消息中的文本 + 媒体项按顺序拼接
- **Telegram 图片 / 语音增强**：Telegram 适配器的图片下载和语音转写能力在本轮中同步维护和 bugfix。
- **新文件**：`src/plugins/messengers/wechat/media-download.ts` — 媒体下载辅助，含路径安全检查（拒绝 `../` / `/`）和 20 MB 大小上限
- **新类型**：`ilink-types.ts` 新增 `ITEM_TYPE` 常量和 `DownloadMediaRequest`
- **新方法**：`ILinkClient.downloadMedia(cdnMedia)` — 通过 iLink CDN 端点下载二进制媒体

### Tests

- 53 个新测试：
  - 31 集成测试（`test/integration/wechat-media-integration.test.ts`）— 端到端验证 `handleIncomingMessage` 对所有媒体类型的处理，含成功 / 失败 / 边界情况
  - 15 单元测试（`test/unit/wechat-media-download.test.ts`）— 下载辅助函数、扩展名推断、CDN 提取、安全防护
  - 8 单元测试（`test/unit/wechat-media-handling.test.ts`）— 类型常量和消息结构验证
- 全量 950 pass / 0 fail

---

## [0.2.33] - 2026-05-09

### Fixed — audit-fixes-7950 follow-up

稳定 0.2.32（v0.2.32 的 10 项审计修复在合入时引入 37 个失败测试 + 一处运行时回归，0.2.33 把这些都修掉，建议直接从 0.2.31 升到 0.2.33）。

- **审批总线 composite key 测试同步**：P0 #4 把 `ApprovalBus` 的内部 keying 从裸 threadId 改成 `platform:channelId:threadId`，但单元测试仍然按裸 `'thread-A'` 调 `hasPendingFor` / `resolvePending`，导致 `bun test` 红 37 项。所有相关测试（approval-bus、synthetic、router、approval 命令、mcp-approval、opencode-http、discord）改用 `threadKey()` 显式构造 composite，注释中误导性的 "backward compat" 承诺一并删除。
- **Claude session 标记顺序回归**：P1 #5 把 `markClaudeSessionPrimed` 从 `routeMessage` 之前挪到了之后；如果 claude 已写出 jsonl 但 run 中途出错，下一轮就会用 `--session-id` 而不是 `--resume`，触发 "session already exists"。0.2.33 把 markPrimed 移回 `onAgentResolved` 内部、紧跟 `setClaudeSessionId`，恢复"先 mark 再调 adapter"的语义。
- **Cookie 加固**：`web.public_bind_warning` 改在 server 启动时打一次（之前每次登录都打）；`Set-Cookie` 在 public bind 或 `X-Forwarded-Proto: https` 时自动附加 `Secure`，纯 localhost dev 不加。
- **静态页测试改写**：原 `/tasks` 用例还在断言 `IMHUB_TOKEN` 注入到 HTML，改成走真实流程：未登录 302 到 `/login`，POST `/api/auth/login` 拿 cookie 后 200，断言 HTML 中不再含 token。
- **死代码清理**：`editCardOnThreadResolution` 的 thread-scan fallback 在 composite key 下永远 miss，删掉；签名从 `(threadId, info, decision, by)` 缩为 `(info, decision, by)`。
- **小项**：`web/server.ts` 删未使用的 `lstat` import；`settings.html` toast 调用末尾被误删的 `;` 补回。
- **测试 flake 修复**：`test/integration/acp-server.test.ts` 在全套并发下被 `intent.test.ts` 注册的空-yield 子代理污染（router intent fallback 到 opencode → 返回 ''）。ACP 测试在 `beforeAll` 重新注册 4 个 profile 名同名 stub 让其也产出内容。

### Result

- `bun test`：895 / 895 pass（之前 857 / 37）
- `tsc --noEmit` / `biome` 干净

---

## [0.2.31] - 2026-05-08

### Release

- 重新发布生产硬化修复到 npm，确保生产环境通过 `npm install -g im-hub-pro@0.2.31` 可以拿到 v0.2.30 严格代码审查后的全部修复。
- 包含子任务会话隔离、WebSocket 入站串行化、session 元数据写锁、安全默认值加固、release/CI 门禁收紧，以及 `im-hub-pro --version` 跟随 `package.json` 的修复。

---

## [0.2.30] - 2026-05-08

### Fixed — strict production code review follow-up

- **子任务会话隔离**：active subtask 下的普通消息与 `/test` / `/review` / `/diff` 等 agentCommand 现在都会写入 `${threadId}:sub:${jobId}` 子会话，不再把用户消息、assistant 回复、usage 和 adapter-native session id 混写到父会话。
- **native Agent session 隔离**：Claude Code / OpenCode / Codex 在子任务内使用子会话自己的 `claudeSessionId` / `opencodeSessionId` / `codexSessionId`；避免主会话与子任务在 CLI 原生会话层串线。
- **WebSocket 入站串行化**：Web Chat 同一浏览器连接上的多条消息按顺序逐条进入 `routeMessage`，降低快速连发时 Agent 子进程并行、历史乱序和流式回复交错风险。
- **Session 元数据写锁**：`patchSession`、usage roll-up、Claude/OpenCode/Codex session id setters、subtask counter/update、agent switch/reset 等读改写路径纳入 per-key lock；`nextSubtaskId` 并发调用保持唯一递增。
- **安全默认值**：
  - Web 控制台默认监听 `127.0.0.1`；需要对外暴露时显式设置 `IMHUB_WEB_BIND=0.0.0.0`，建议放在 HTTPS 反代后。
  - `~/.im-hub/config.json` 写入时强制 `0600`，目录创建使用 `0700`。
  - Telegram 媒体下载的 `curl` 保留 `--location` 但加 `--max-redirs 0`，拒绝跟随重定向到任意主机。
- **CLI 版本号**：`im-hub-pro --version` 改为读取包内 `package.json`，不再硬编码旧值（之前可能输出 `0.2.18`）。

### Build / release

- Release workflow 中 `npm test` 失败不再 `continue-on-error`，避免测试红仍发布 npm。
- CI 增加 `npm run lint`；补齐 `@biomejs/biome` devDependency。
- `lint` 当前只检查相对 `main` 的变更文件，避免仓库既有 Biome 基线问题一次性阻断所有 PR。

### Tests

- 新增/补齐回归覆盖：active subtask 默认消息与 agentCommand 路由、并发 `nextSubtaskId`、Telegram curl redirect 参数、`config.json` 权限、WebSocket serial queue。

---

## [0.2.26] - 2026-05-08

### Changed — Rebrand to `im-hub-pro`

- **npm 包名**：`im-hub` → `im-hub-pro`（产品化分支）。
- **CLI 命令**：`im-hub` → `im-hub-pro`（`bin` 字段同步更新）。
- **仓库 URL**：`package.json.repository.url` 从原作者 `ceociocto/im-hub` 切到当前仓库 `benking007/imhub`，新增 `homepage` / `bugs` / `publishConfig{access:public,provenance:true}` 字段。
- **Web 控制台品牌**：`/`、`/tasks`、`/settings` 三个静态页的浏览器标题、欢迎语、左上角 logo、Settings 卡里的 `im-hub config wechat` 提示文案，全部改为 `im-hub-pro`。
- **README + README.zh-CN**：`What's new` / 安装命令 / Quick Start / CLI 命令表 / Project Structure ASCII 树标签，全部改为新品牌；新增「Migrating from `im-hub`」回退指引。
- **LICENSE 文件**：补齐 MIT 全文（之前 `package.json` 声明 MIT 但根目录无 LICENSE 文件），版权归属保持 `Jerry`。
- **`THEME_KEY`**：localStorage 主题 key 从 `im-hub-theme` → `im-hub-pro-theme`（用户在升级后第一次访问会丢失主题偏好；其他 localStorage key `im-hub-lang` / `im-hub-history` 保留以保住语言与对话历史）。

### Unchanged — drop-in compat

为了让老用户 `npm uninstall -g im-hub && npm install -g im-hub-pro` 后零迁移成本运行：
- **配置目录**：`~/.im-hub/`、`~/.im-hub-workspaces/<agent>/` 路径不变
- **环境变量**：60+ 处 `IMHUB_*` 前缀不变
- **HTTP 头**：`X-IM-Hub-Token` / `x-im-hub-token` 不变
- **Window 全局**：`window.IMHUB_TOKEN` 不变
- **ACP 服务名**：`im-hub-gateway` 不变（线上 ACP 客户端通过这个名字 discover）
- **MCP 测试 fixture**：`mcpServers.imhub` 不变
- **内部 client ID**：`im-hub:${ts}` 格式不变

### Notes

- 发布走 npm OIDC trusted publishing（`release.yml` 不需要改），首次发布前需在 npmjs.com 上为 `im-hub-pro` 配置 trusted publisher 指向 `benking007/imhub` 仓库 + `release.yml` workflow。
- 老 `im-hub@0.2.25` 包在 npmjs.com 上保持不动，可继续安装。

---

## [0.2.23] - 2026-05-07

### Added — Web console PR-D
- **Agent workspace 文件浏览器**：`/tasks` 新增 **Files** tab，只读浏览 `~/.im-hub-workspaces/<agent>/`（CLAUDE.md / AGENTS.md / 临时笔记等）。左侧目录树 + 右侧文件预览，点目录进入、点文件预览，文件 1 MiB 上限 + 二进制（首 8 KB NUL 探测）走 base64。后端 `GET /api/workspace-files?agent=&path=` 双重防 traversal：agent 必须在 `registry.listAgents()` 白名单，路径必须等于或位于 `defaultAgentCwd(agent)` base 之下，否则 400。
- **Job 批量操作**：Jobs tab 加多选 checkbox + 全选表头 + 隐藏式批量工具栏（Run selected / Cancel selected）；选中态跨刷新保留——按可见行 reconcile，不会被 list mutation 抹掉。后端新 `POST /api/jobs/batch-cancel` / `batch-run` 接受 `{ ids: number[] }`（最多 100），per-id 结果不互相阻断。

### Changed
- **Settings 页布局**：header 用 `justify-content: space-between` + 4 个独立 flex 子项导致语言 `<select>` 被拉伸成满屏宽，标题/链接全部换行。重写为 `.brand`（左侧链接 + 标题）+ `.controls`（右侧 lang/theme，`margin-left: auto`）双分组，控件 `width: auto` + `white-space: nowrap`。容器 max-width 720→880，标题字号字距微调，卡片圆角 8→12 + 浅色态加 1px 阴影，header sticky。
- **修复主题污染**：toast `.success` / `.error` 和 `.btn-danger:hover` 之前用了硬编码深色背景（`#0a2a0a` / `#2a2a0a` / `#1a0a0a`），浅色主题下渲染成近黑色，已改为主题变量。

## [0.2.22] - 2026-05-07

### Added — Web console PR-C
- **SSE 实时事件流**：新建 `src/core/event-bus.ts`——进程内 publish/subscribe，4 类事件（`audit` / `approval` / `job` / `metrics`），200 条 ring buffer。新连接 replay 一次避免空白等待。
- **`GET /events` 端点**：token 走 `?token=...`（EventSource 不支持自定义 header），25s 心跳防 nginx idle close，listener 错误在 `publish()` 内吞掉避免拖坏起源动作。
- **Dashboard 实时刷新**：`tasks.html` 用 `EventSource('/events?token=...')`，事件触发 `refreshIfVisible(paneId, loader)` 只刷可见 tab；轮询保留作为 fallback。`approval requested` 事件让 Approvals tab 标签闪一下高亮（动态注入的 CSS keyframe）。
- **Workspace 完整 CRUD UI**：`settings.html` 新增 Workspaces 卡片，列表 + 新增 / 编辑 / 删除表单（id 锁定防误改、default 行不可删）。后端 `GET /api/workspaces?full=1` / `POST` upsert / `PATCH /:id` / `DELETE /:id`，每次 mutation persist 回 `~/.im-hub/config.json`。
- `WorkspaceRegistry.remove(id)` 拒绝 `'default'`，`listFull()` 返回完整 `WorkspaceConfig[]`（含 member ids）。

## [0.2.21] - 2026-05-07

### Added — Web console PR-B
- **Health tab**：`/tasks` 新增 Agent 健康面板，每个 agent 一行展示熔断器状态（closed / open / half-open）、限流余量、p50/p95/p99 延迟、调用次数 / 成功率 / 累计成本、半开冷却。最近 60 次轮询的 p95 延迟用内联 SVG sparkline 画出。
- **Approvals tab**：列出所有 pending HITL 审批（reqId / threadId / toolName / 等待时长 / 注册时间），支持网页端直接 Allow / Deny / Allow + Auto。后端新 3 路由：`GET /api/agent-health` / `GET /api/approvals` / `POST /api/approvals/:reqId/resolve`。
- `approval-bus.PendingApproval` 增 `input`（原始入参）+ `registeredAt`，`listPending()` 返回脱敏快照；register / cancel 时 emit `'approval'` 事件，给 SSE 用。

## [0.2.20] - 2026-05-07

### Added — Web console PR-A
- **三态主题**：light / dark / system 三档循环切换，按钮在 head 加载完前同步应用 `:root[data-theme]`，避免主题闪烁。`prefers-color-scheme: dark` 仅在 `data-theme` 缺失（system 模式）时生效。语言 + 主题偏好都落在 localStorage。
- **错误边界**：新建 `src/web/public/_app.js`——`window.imhub` 命名空间提供 `theme` / `i18n` / `api` / `showError`，自动安装 `window.onerror` + `unhandledrejection` 监听，让脚本错误以浮层形式可见，不再静默死掉。
- **In-chat 审批卡**：`/` 聊天界面收到工具审批请求时弹出 inline 卡片（Allow / Deny / Allow + Auto），点击通过 WS `approval-action` 走回 `approvalBus.resolvePending()`，跟 Telegram inline-button 同一条路径。
- `approval-router` 默认 `buttonCallbackPlatforms` 加 `'discord'` / `'web'`；新导出 `bindButtonHandlerForPlatform(platform)` 给延迟注册的 messenger（web 是其中之一）调用，避免 install-before-register 时序问题。

### Fixed
- `tasks.html` 第二段 `<script>` 顶层 `const T` 与第一段 IIFE 外的 `const T` 冲突（"Identifier 'T' has already been declared"）。把首段包进 IIFE 隔离作用域。
- WS `approval-action` 处理路径增日志（每次点击的 receipt + handler-bound 状态），handler 未绑定 / 处理失败时把"approval handler not bound" / "click failed"以聊天错误提示给用户；客户端用 soft-disable，避免服务端报错时按钮卡死。

## [0.2.19] - 2026-05-07

### Added
- **Codex sandbox-mode plan 支持**：codex 接入 `session.planMode`，默认 sandbox 从 `--full-auto` 改为显式的 `-s workspace-write`，关闭 auto-approval。
- **Dashboard agent 过滤 + Audit tab**：Jobs / Subtasks / Schedules 三个 tab 加 agent 下拉过滤（之前看得到但分不清归属），新增 Audit tab 把 SQLite 审计日志拉到 UI（之前只有 IM `/audit` 命令）。后端配套 `OwnerOpts.agent?` 字段下沉到 `listJobs` / `listSchedules` / `listAllSubtasks`，新 `GET /api/audit?agent=&days=&user=&intent=`。

### Docs
- README "What's new" + Roadmap 补到 v0.2.18。

---

## [0.2.18] - 2026-05-07

### Fixed
- **M9 — IM 重连退避**：`src/utils/backoff.ts` 新增 `Backoff` 助手（指数 + ±jitter，参数自钳位，RNG 可注入做确定性测试）。
  - **Telegram** `runPollingLoop`：两个 fixed `setTimeout(2000)` / `setTimeout(5000)` → `Backoff(2_000, 60_000, 0.5)`；新增 `HEALTHY_RUN_THRESHOLD_MS=30_000`，`bot.start()` 跑健康 ≥ 30s 后再失败会重置 backoff，避免长会话第一次错被推到累计尾端。日志带 `attempt` + `delayMs`。
  - **WeChat ilink** `pollLoop`：inline `1000 * Math.pow(2, n-1)` → `Backoff(2_000, 30_000, 0.5)`；保留首次失败"零等待"（`consecutiveFailures > 1` 才生效）；`getUpdates` 成功路径加 `backoff.reset()`。

### Notes
- Feishu (Lark SDK) / Discord (discord.js) 的 WebSocket 重连在 SDK 内部，没有 app 层注入点，本次未改。
- WeChat `tryRefreshSession` 的两次线性 `attempt*5000` 保留原状（套 Backoff 反而扭曲）。

### Tests
- `test/unit/backoff.test.ts` 新建 10 用例：指数调度 / cap / reset / pinned RNG 下 jitter 边界 / 200 随机样本落 `[exp*0.5, exp*1.5]` / 默认值 / `baseMs=0` 边界 / `capMs<baseMs` 自纠正。

---

## [0.2.17] - 2026-05-07

收尾 P2 + P3，配 `docs/code-review-2026-05-06-main.md` 的 punch list。

### Fixed — P2 web/HTTP hardening
- **M1** 静态页响应头：`X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` / Content-Type 加 `charset=utf-8` / CSP 锁第三方资源（`script-src` / `style-src` 暂留 `'unsafe-inline'`，nonce 化留 P3）。
- **M2** Prometheus 标签基数白名单：`KNOWN_INTENTS = {default,explicit,fallback,llm,topic,keyword,sticky}`、`KNOWN_PLATFORMS = {telegram,feishu,wechat,discord,web,acp,acp-server,rest,rest-msg}`，命中外的桶到 `'other'`。
- **M3** WS 连接上限：默认 100，env `IMHUB_MAX_WS_CLIENTS` 覆盖；超限时 `1013 Try Again Later`。
- **M4** `/api/health` 改为 token gate 之前公开（k8s liveness 友好）。
- **M11** ACP 测试入口的 `JSON.parse` 包 `try/catch` + endpoint 类型校验，错误 body 落 400 而非 500。

### Fixed — P2 observability
- **M7** audit 30 天修剪失败暴露 `im_hub_audit_prune_failed_total` counter。
- **M14** approval-bus 五个生命周期 counter（`pending` / `requests_total` / `resolved_total{result=allow|deny|timeout}`），lazy provider 注入避免循环依赖。
- **M15** intent-llm cache key：候选列表用 sha256 16-hex，prompt 截断到 256 字符，防 100KB prompt × 多 ACP 候选爆 LRU。
- **bug-fix**：approval result 三类桶做成互斥（timeout / deny / allow），原本 timeout-deny 双计可能让 Prom counter 倒退。

### Fixed — P2 IM 文本边界
- **M10** `splitMessage` 强制 `maxLength` 切分加 `safeSplitPoint`，避免切到 UTF-16 surrogate pair（emoji 半切渲染成 `□`，或破坏 Telegram HTML 解析）。
- **M12** Telegram `escapeHtml` 补 `'` / `"` —— approval card 模板里的 `<a href="...">` 属性场景必要。
- **M13** approval auto-allow 前缀指纹 5 → 10：原来 `git s` 同时匹配 `git status`/`git stash`/`git submodule`，太宽。

### Fixed — P3 low-priority (10 L items)
- **L1** WS chunk 循环检查 `bufferedAmount`（4 MiB highwater，50 ms poll，5 s 预算）。
- **L2** SIGINT 关停链接通 `helper.close()` / `closeAuditDb` / `closeJobBoardDb` / `closeScheduleDb`，WAL 清洁 checkpoint。
- **L5** `traceId` 12 hex (~2^48) → 16 hex (~2^64)。
- **L6** WeChat ilink-client 4 处遗漏的 `fetch` 加 `AbortSignal.timeout()`。
- **L7** Discord adapter `typingIntervals` 配 `AbortController`，`stop()` 先 abort 再 `clearInterval`，避免与 `client.destroy()` 竞速。
- **L10** approval-bus buffer 溢出改为写 `{v:1,type:"fatal"}` + `socket.end()`，不再静默 destroy。
- **L12** `classifyIntent` 失败日志带 `err.message` + stack。
- **L13** 新增 `im_hub_agent_cleanup_failed_total` counter，`plan.cleanup()` catch 计数。
- **L14** WeChat ilink `cleanupExpiredContextTokens` 搭 1/min 心跳 tick —— 静默用户不再留 30 min 残余。
- **L15** onboarding `perAgentCache` 注释对齐实际查询顺序。

### Build / infra
- `dist/cli.js` 编译后 `chmod +x`（534fb55）。
- `package-lock.json` 94 处 `resolved` URL 由 Tencent 内网镜像改回 `https://registry.npmjs.org/`（content-addressed integrity 一致），CI 解锁。
- `session.ts atomicWrite` 加 ENOENT defense（`mkdir` + 重试一次）；同步修了 `session-subtasks.test.ts` 在 fresh runner 上的 0 vs 2 翻车。

### Skipped from CR (理由记 PR body)
- L3 / L4 / L8 / L9 / L11：false positive 或纯 cosmetic 或过度侵入。

---

## [0.2.16] - 2026-05-06

P0 + P1 安全收口，配 `docs/code-review-2026-05-06-main.md`。

### Fixed — P0 hotfix
- **H1** Web REST/WS token 比较切到 `crypto.timingSafeEqual`，抽 `src/utils/safe-equal.ts` 与 `acp-server.ts` 共用。
- **H2** `serveIndexHtml` 用 `JSON.stringify(token)` 注入 `window.IMHUB_TOKEN`，防 token 含 `'` / `</script>` 破坏 JS 字面量。
- **H3** Schedule `notify_url` SSRF 防护：`validateWebhookUrl` 白名单 `http(s)`、黑名单 RFC1918 / loopback / link-local / CGNAT / IPv6 ULA / fe80::；`IMHUB_ALLOW_PRIVATE_WEBHOOKS=1` 显式 opt-in；fetch 加 10s `AbortSignal` + `redirect: 'manual'` + 64 KiB 响应上限；`createSchedule` 与 `fireSchedule` 双层校验。
- **H8** `settings.html` ACP 测试按钮：原代码 `const res` 重复声明 + 引用未定义 `endpoint`/`auth`，整页脚本 SyntaxError，功能必坏。改读 `agent.endpoint` / `agent.auth`。
- **H10** Telegram bot token 不再随错误日志泄露：`logger.ts` 加 `redact.paths`（`*.token` / `*.botToken` / `*.apiKey` / `headers.authorization` / `x-im-hub-token` 等）；图片 / 语音下载 catch 路径用本地 `scrub()` 把 token 字面量替换 `[REDACTED]`，覆盖 curl stderr 带回 URL 的场景。

### Fixed — P1 runtime hardening
- **H4** `RateLimiter` bucket 无界：`allow()` 内置 `maybeSweep`，每 30 min 机会式触发 cleanup（不引入 `setInterval` timer）；新增 `size()` 诊断访问器。
- **H6** Job result 大小：`resolveMaxResultBytes()` 默认 1 MiB，env `IMHUB_JOB_RESULT_MAX_BYTES` 覆盖；超过 cap 整 chunk 丢弃（边界落在 UTF-8/JSON 事件分隔上），尾部拼 truncation footer，落 warn `event: 'job.result.truncated'`。
- **H9** WeChat 凭证文件权限：`saveCredentials` 用 `mkdir(.., {mode:0o700})` + `writeFile(.., {mode:0o600})`；`loadCredentials` 读时 `stat`，松权落 warn 提示用户 `chmod 600`（不主动改老文件）。
- **H11** Approval socket 路径熵 + 权限：`defaultSocketPath` 改用 `randomBytes(16).toString('hex')`（128 位熵），listen 后 `chmod 0o600` + `stat` 验证；防同主机非特权用户预占 socket 的 TOCTOU。
- **H12** `Session.addMessage` 并发：`SessionManager` 加 `writeQueues<key, Promise>` + `withLock<T>(key, fn)`，per-key 串行化 RMW，跨 thread 仍并行。

### Fixed — P1 multi-tenant ACL
- **H5** `/job` `/schedule` `/audit` 命令补 owner 隔离：`jobs` / `schedules` 表加 `creator_id` / `workspace_id`（幂等 `ALTER TABLE`，老库无痛升级）；`createJob` / `createSchedule` 接 `{ creatorId, workspaceId }` 由 handler 注入；查询/取消/删/启停加 `OwnerOpts`，`creator_id = ? OR creator_id = ''`（老库 `''` 对所有 owner 可见，避免升级当天列表看似消失）；`/audit user=<other>` 强制 overwrite 到 `ctx.userId`，结果末尾追加忽略提示。
- **H7** Job 表 retention：`resolveRetentionDays()` 默认 30 天，env `IM_HUB_JOB_RETENTION_DAYS` 覆盖；`pruneOldJobs()` 删 `completed`/`failed`/`cancelled` 超期行，`pending`/`running` 永不修剪；启动跑一次 + 每 6h `setInterval(..unref())`；新增 `idx_jobs_created` / `idx_jobs_creator` / `idx_jobs_status_created` 索引。
- **M6** Workspace 白名单从路由层下沉到命令层：`/job create <agent>` 与 `/schedule create <agent>` 在 `createJob` / `createSchedule` 之前调 `workspaceRegistry.resolve(ctx.userId).hasAgent(agent.name)`。

### Tests
- `test/unit/schedule-webhook.test.ts` 新增 22 用例锁定 SSRF 防护行为。
- `test/unit/rate-limiter.test.ts` +4 用例：size 计数、强制清空、刚活跃 bucket spare、连续 allow 不误触发 sweep。
- `test/unit/session-real.test.ts` +1 用例：50 个并发 `addMessage` 同 key，JSONL 行数与 in-memory messages 严格 = N，content 集合无丢失。

### Notes
- 历史 `/job list`（无 `ctx.userId` 注入）仍能看全部，REST `/api/jobs` 同。
- 历史调用方（无 `OwnerOpts`）TS 仍可编译通过。
- M5（cron 时钟跳变）经复核当前 `dueSchedules → fireSchedule` 路径不会双触发，留到后续 UTC 重构一并处理。

---

## [0.2.15] - 2026-05-01

### Added
- **Discord messenger adapter** — full IM bridge for Discord (Gateway WebSocket via `discord.js`)
  - `im-hub config discord` interactive setup wizard
  - Typing indicator (10s TTL, 8s refresh)
  - Markdown → Discord-flavored format conversion
  - Guild / Channel whitelist filtering
  - Setup guide: [`docs/discord-setup.md`](docs/discord-setup.md)
- **Tasks dashboard upgrades** — `/tasks` page now surfaces background work
  - **Background tab**: lists `~/.claude/bgjobs` + `~/.config/opencode/bgjobs` jobs (override via `IMHUB_BGJOB_ROOTS`); per-root selector, 5s auto-refresh, detail modal with `cmd` / `workdir` / `log_tail`
  - **Subtasks tab**: flattens every subtask in every session file, with parent platform / threadId / agent attached
  - Bilingual labels (EN + ZH)
- **REST endpoints (read-only)**:
  - `GET /api/bgjobs[?root=ID]` / `GET /api/bgjobs/:id[?root=ID&tail=N]`
  - `GET /api/subtasks`

### Changed
- Web Chat / Tasks `index.html` served with `Cache-Control: no-cache, must-revalidate` so dashboard updates land without a hard refresh.
- **Feishu adapter** dedupes `message_id` in a 10-min TTL set — WebSocket long-poll was replaying the same event on reconnect and double-firing Claude runs.

### Tests
- 26 new tests: bgjob-reader (15), session subtasks (2), web server integration (9)
- Discord adapter: mock-client driven offline e2e (sendMessage, messageCreate, whitelist / bot filtering, message splitting)
- IM approval ↔ Discord end-to-end loop (sidecar → ApprovalBus → approval-router → Discord channel → reply → decision back)

---

## [0.2.14] - 2026-05-01

### Added
- **Human-in-the-loop tool approval** for IM-launched Claude runs.
  - Replaces the legacy `--permission-mode dontAsk + blanket-allow PreToolUse hook` shortcut with a real approval flow over IM.
  - Architecture:
    ```
    claude --permission-prompt-tool mcp__imhub__request --mcp-config <tmp>
       └─> MCP sidecar (mcp-approval-server.ts)  ── unix socket ──>  im-hub
                                                                       └─> approval-bus
                                                                             └─> approval-router → messenger.sendMessage
                                                                                   ↑
                                       user replies y / n / 批准 / 拒绝 in the same IM thread
    ```
  - cli intercepts approval replies *before* the agent router; unrecognized replies during a pending request auto-deny so the sidecar (and Claude) don't hang.
  - Per-spawn state lives in the `SpawnPlan` returned by `AgentBase.prepareCommand` (closure-local, not `this.*`) — fixes a singleton race where parallel IM threads running claude clobbered each other's `mcp-config` and the second run died with *MCP config file not found*.
  - Graceful fallbacks: `IMHUB_APPROVAL_DISABLED=1`, missing IM context, approval-bus not started, or `mkdtemp/writeFile` failure all degrade to the legacy `--permission-mode dontAsk` path.

### Notes
- Approvals are platform-agnostic — the same chain works for WeChat / Telegram / Feishu / Discord with no per-platform changes.

---

## [0.2.13] - 2026-04-30

A large multi-phase release: structured logging, observability, multi-tenant routing, persistent jobs, ACP server-mode, and a Web tasks panel. Versioned together because the wiring is interdependent.

### Phase 1 — Foundations (security, logging, schema, agent base)

#### Added
- **Structured logging** with `pino` and request-scoped `traceId` propagated through every layer (router → agent → audit). Pretty in TTY, JSON in production. ADR: [`docs/adr/0002-structured-logging-trace-id.md`](docs/adr/0002-structured-logging-trace-id.md).
- **Zod config schema validation** at startup and PUT `/api/config` — invalid configs reject with a useful error instead of crashing the bridge mid-run.
- **`AgentBase` abstraction** for CLI-based adapters (claude-code / codex / copilot / opencode) — shared spawn-stream, abort/timeout, line buffer, error formatting, healthCheck. ADR: [`docs/adr/0001-agent-base-abstraction.md`](docs/adr/0001-agent-base-abstraction.md).
- **Agent availability TTL cache** on top of `healthCheck` — avoids spawning a probe process on every `/<agent>` switch.
- **Audit log** with SQLite (`~/.im-hub/audit.db`, 30-day retention) + `/audit [n]` chat command.

#### Fixed
- P0 batch: WebSocket auth, nested config-mask leaks, timeout coercion, `/api/notify` token validation, agent-name prefix collisions, session path traversal (ADR [`0003`](docs/adr/0003-session-path-safety.md)).

### Phase 2 — Routing & resilience

#### Added
- **Intent classifier** (`src/core/intent.ts`) — topic regex (CJK + ASCII), per-agent keyword profile, sticky-session bias, optional LLM judge fallback with LRU cache. `/router status|policy|explain|reset` for inspection.
- **Circuit breaker** for agent invocations (3 failures → 5-minute cool-down).
- **Per-user token-bucket rate limiter**, applied before every agent dispatch.

#### Fixed
- Workspace whitelist now applies to both `/<agent>` *and* default routing.
- `workspace.rateLimit` actually enforced (was inert before).
- Intent classifier matches CJK keywords (was `\b` regex, all dead).
- Profile-less ACP custom agents participate via a `DEFAULT_WEIGHT` floor.

### Phase 3 — ACP server, workspaces, persistent jobs

#### Added
- **ACP server mode** — im-hub itself is now an ACP-compatible agent at `POST /tasks` (sync + SSE) with timing-safe auth and a 1 MiB body cap.
- **`/.well-known/acp` discovery** for ACP custom agents (A-1).
- **Multi-tenant workspace registry** (`src/core/workspace.ts`) with per-workspace agent whitelist + rate limits + member lists.
- **Persistent Job Board** with SQLite (`~/.im-hub/jobs.db`) and `/job` chat commands — survives restarts; ACP-server tasks become durable jobs.
- **Subtask sessions** + `/task` aliases for backward compatibility.
- **`AbortController` signal** plumbed through job board for real cancellation (Phase 3.5).
- **Cron scheduler** (`src/core/schedule.ts`) — 30-second tick, fires registered job specs.

### Phase 4 — Observability & Web (W-1)

#### Added
- **Web `/tasks` panel** for jobs, schedules, workspaces.
- **REST jobs API** (`/api/jobs`, `/api/schedules`, `/api/workspaces`).
- **Prometheus metrics** at `/api/metrics` (pure quickselect quantiles, no extra dep).
- Deployment guide: [`docs/deployment.md`](docs/deployment.md).

### Restored / overhauled commands
- `/model`, `/models`, `/think`, `/stats`, `/sessions` — all returned and overhauled. Session model selection now persists across restarts.

### Performance
- LRU cache for LLM intent judge.
- Shared SQLite helper (single `prepare`-cache, single PRAGMA bootstrap).
- LineBuffer indexOf walk (avoids quadratic scans on long stdout chunks).
- Metrics quickselect quantiles (no `.sort()` per scrape).
- Cron `nextOccurrence` field-level fast-forward (skip-ahead instead of minute-loop).

### Stability fixes (CR round)
- 11 follow-up findings from the code-review pass (see [`docs/code-review-2026-04-30-main.md`](docs/code-review-2026-04-30-main.md)).
- WeChat `getUpdates` now has a `FETCH_TIMEOUT` to prevent event-loop blocking.
- `AgentBase.sendPrompt` is true streaming with multi-byte UTF-8 safety.
- `session.addMessage` is append-only JSONL (was full rewrite per turn).

### Architecture docs
- [`docs/architecture/current.md`](docs/architecture/current.md) — system overview at v0.2.13.
- [`docs/architecture/target.md`](docs/architecture/target.md) — multi-tenant target.
- ADRs 0001 / 0002 / 0003.

---

## [0.2.7] - 2026-03-27

### Added
- **Conversation history support** — agents now remember context across messages
  - Session stores message history (`ChatMessage[]`)
  - History is passed to agents with each prompt for context awareness
  - `/new` command to start a fresh conversation (clears history)
- **ChatMessage type** — `{ role: 'user' | 'assistant', content: string, timestamp: Date }`
- **Session history management** in SessionManager:
  - `addMessage()` — add message to conversation history
  - `resetConversation()` — clear history, start new session
  - `getSessionWithHistory()` — retrieve session with messages

### Changed
- **AgentAdapter interface** — `sendPrompt()` now accepts optional `history?: ChatMessage[]`
- **All agent adapters** (claude-code, codex, copilot, opencode) now:
  - Accept conversation history
  - Build contextual prompts with previous messages
- **Router** — automatically saves user messages and agent responses to history
- **Help text** — updated to include `/new` command

### Fixed
- Context loss issue in channel-based conversations — agents now maintain conversation memory

## [0.2.2.0] - 2026-03-27

### Added
- **Onboarding module** (`src/core/onboarding.ts`) with friendly first-run experience
  - `checkMessengerConfig()` — detect if messengers are configured
  - `checkAgentAvailability()` — async check with session-level caching
  - `runMessengerOnboarding()` — interactive messenger setup wizard
  - `formatAgentInstallHint()` — friendly install messages for missing agents
  - `formatAgentNotAvailableError()` — chat-friendly runtime error messages
  - `formatMessengerStartError()` — actionable hints for startup failures

### Changed
- **CLI start command** now runs onboarding checks before starting messengers
  - Detects unconfigured messengers and launches interactive setup
  - Warns about missing agents with install instructions
  - Shows friendly error messages instead of stack traces
- **Router** now checks agent availability at runtime
  - Returns helpful chat message if requested agent isn't installed
  - Uses cached availability check to avoid repeated process spawns

### Fixed
- Critical bug where onboarding never triggered because `config.messengers` was auto-filled with default
- Ugly stack traces shown to users when messenger fails to start

## [0.0.1.0] - 2026-03-25

### Added
- Initial project scaffold with TypeScript + Bun
- Core types: `Message`, `ParsedMessage`, `Session`, `MessengerAdapter`, `AgentAdapter`
- Plugin registry for static imports
- Message router with command parsing (`/status`, `/help`, `/agents`, `/<agent>`)
- Session manager with file-based persistence
- WeChat adapter stub (wechaty-puppet-wechat)
- Claude Code adapter stub (stream-json mode)
- CLI commands: `start`, `config`, `agents`, `messengers`
