// Self-protection — block agent tool calls that would kill / restart the
// Agim service itself, redirecting them to the graceful /restart flow.
//
// This is Layer 2 of the defense outlined in PRs that introduced
// service-intent.ts. Layer 1 (intent detection) catches "重启服务" before
// it ever reaches an LLM. But if the user phrases it more creatively
// ("帮我把这个 bot 关掉再重开"), Layer 1 may miss, and the LLM happily
// proceeds to `Bash(systemctl restart agim)` or `Bash(kill <our_pid>)`.
// That bypasses pre-flight, the restart-pending state file, and the
// completion message — service goes dark mid-conversation.
//
// We intercept inside the approval-bus notifier (core/approval-router.ts).
// When a tool-use request matches a self-protect pattern, we throw a
// friendly error message; the bus translates the throw into a deny that
// Claude/Codex/OpenCode reports back to the user verbatim. No IM y/n
// card appears.
//
// LIMITATIONS:
// 1. When IMHUB_DANGEROUSLY_SKIP_PERMISSIONS=1 (Claude only), no approval
//    request is ever generated — Claude runs Bash directly. Layer 2
//    cannot intercept there. The user opted into "no approval", so the
//    trade-off is theirs to bear.
// 2. Codex has no per-tool approval hook — its `exec` mode runs Bash
//    under an OS sandbox without intermediate prompts. Layer 2 doesn't
//    fire for codex. Layer 1 (intent regex) is the primary defense for
//    codex; the long-tail of creative natural-language restart asks
//    will leak through.
// 3. OpenCode routes through approval-bus when its SSE bus mode is
//    active (default); Layer 2 covers it the same as Claude. Direct CLI
//    invocations of opencode skip the bus.
// Layer 1 (core/service-intent.ts) catches the common cases for ALL
// three agents; this layer is the belt to its suspenders, and only
// closes the loop fully for Claude (default-permission mode) and
// OpenCode (bus-mode).

const PROCESS_NAMES = '(agim|im-hub-pro|im-hub|dist/cli\\.js)'

/** Patterns that, when matched against a tool's input, force a deny.
 *  Tested against the Bash command string OR a stringified form of the
 *  tool input for non-Bash tools (Edit/Write that try to mutate
 *  systemd-unit files). Ordering doesn't matter — first match wins. */
const SELF_PROTECT_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: new RegExp(`\\b(systemctl|service)\\s+(restart|stop|kill|reload|disable)\\s+${PROCESS_NAMES}`),
    reason: 'systemctl restart/stop on the Agim service',
  },
  {
    regex: new RegExp(`\\b(pkill|killall)\\b[^|;&]*\\b${PROCESS_NAMES}`),
    reason: 'pkill / killall targeting the Agim service',
  },
  {
    // kill <pid> where pid happens to be our own — checked dynamically by the
    // caller; we also match the literal command-name pattern for the case
    // where the LLM does `kill $(pgrep agim)` etc.
    regex: new RegExp(`\\bkill\\b[^|;&]*\\$\\(\\s*pgrep[^)]*${PROCESS_NAMES}`),
    reason: 'kill $(pgrep agim)',
  },
  {
    regex: /\b(agim|im-hub-pro)\s+(restart|stop|start|uninstall)\b/,
    reason: 'recursive invocation of the agim CLI',
  },
  {
    regex: /\bnpm\s+(restart|stop)\b/,
    reason: 'npm restart/stop',
  },
  {
    // Process.kill JS call in Edit/Write tools — captures attempts to write
    // a script that signals our PID.
    regex: /process\.kill\s*\(\s*[^,)]+,\s*['"]SIG(TERM|KILL|INT|HUP)['"]?\s*\)/,
    reason: 'process.kill() targeting an Agim signal',
  },
]

/** Friendly user-facing message that's emitted back to the LLM (which
 *  passes it through to the user verbatim).  Keep short — Telegram and
 *  WeChat truncate long denial messages aggressively. */
const REDIRECT_TEMPLATE = (reason: string): string =>
  '🛑 检测到尝试通过工具调用重启/停止 Agim 服务（' + reason + '）。\n' +
  '   这会跳过 pre-flight 检查和接力消息，请改用以下方式之一：\n' +
  '   · 直接发"重启服务"或 /restart（推荐）\n' +
  '   · 浏览器打开 web 控制台 → Safety 卡片 → Restart\n' +
  '   · 终端运行 `agim restart`'

/** Examine a tool-use request from an agent (Claude/Codex/OpenCode MCP
 *  sidecar relays them all through approval-bus).  Returns a deny reason
 *  if it matches a self-protect pattern, otherwise null. */
export function checkToolUse(
  toolName: string,
  input: Record<string, unknown>,
): { deny: true; message: string } | null {
  // Reduce the tool input to a single string for pattern matching. Bash
  // tools usually carry `command`, Edit/Write carry file contents / paths.
  const haystacks: string[] = []
  if (typeof input.command === 'string') haystacks.push(input.command)
  if (typeof input.content === 'string') haystacks.push(input.content)
  if (typeof input.new_string === 'string') haystacks.push(input.new_string)
  if (typeof input.file_path === 'string') haystacks.push(input.file_path)
  // Stringify the whole input as a fallback so we still catch weird shapes.
  try { haystacks.push(JSON.stringify(input)) } catch { /* ignore */ }

  for (const hay of haystacks) {
    for (const { regex, reason } of SELF_PROTECT_PATTERNS) {
      if (regex.test(hay)) {
        return { deny: true, message: REDIRECT_TEMPLATE(reason) }
      }
    }
  }

  // Bonus: if input contains the literal current PID and looks like a kill
  // command, deny — covers `kill 3001362` or `kill -9 3001362`.
  const ourPid = String(process.pid)
  for (const hay of haystacks) {
    if (/\bkill\b/.test(hay) && hay.includes(ourPid)) {
      return { deny: true, message: REDIRECT_TEMPLATE(`kill ${ourPid} (our pid)`) }
    }
  }

  // Suppress unused-var lint for toolName — kept in signature for future
  // tool-type-aware decisions (Edit-of-/etc/systemd/system/agim.service etc.)
  void toolName
  return null
}
