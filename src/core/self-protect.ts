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
// DESIGN — split by tool intent, not field name:
//
//   - Exec tools actually EXECUTE shell — `command` / `cmd` is an action.
//     Match against BASH_DANGER_PATTERNS (systemctl, pkill, agim restart, ...).
//     Canonical names: Bash (CLI), agim_exec (native; legacy native_exec).
//
//   - Write/Edit tools author CONTENT — their `new_string` / `content` is
//     text being written to a file, not a command being run.
//     Shell-literal patterns (`systemctl restart agim` as a string in a
//     doc, i18n string, comment, this very file) MUST NOT trip the guard;
//     blocking them would mean operators can't debrand / refactor /
//     document their own service. Match only CODE_DANGER_PATTERNS — JS
//     code that DYNAMICALLY signals our pid (process.kill).
//     Canonical names: Edit/Write/NotebookEdit (CLI), agim_write_file /
//     agim_edit_file (native).
//
//   - Other tools (Read, Grep, Glob, MCP tools) read or query — no shell
//     execution, no content authoring. Skip the scan entirely.
//
// Earlier versions stringified the whole input as a catch-all haystack;
// that scanned removal-side fields like Edit.old_string and made the
// guard block edits that *delete* the dangerous literal from a file —
// the very edits a debrand needs. The split below removes that footgun
// and the broader "shell literal in a doc trips the guard" class with it.
//
// LIMITATIONS:
// 1. When AGIM_DANGEROUSLY_SKIP_PERMISSIONS=1 (Claude only), no approval
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
// three agents; this layer is the belt to its suspenders. Native
// `agim_exec` also runs the same check in exec-dispatcher so Subagent
// HITL-skip cannot bypass Layer 2.
import { canonicalizeToolName } from './llm/tool-names.js'

const PROCESS_NAMES = '(agim|agim|agim|dist/cli\\.js)'

/** Patterns matched against Bash's `command` field. These describe *actions*
 *  the shell would actually take — they must NOT be applied to text being
 *  written into a file, because the exact same string can appear as a
 *  legitimate literal in docs / i18n / source code. */
const BASH_DANGER_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: new RegExp(`\\b(systemctl|service)\\s+(restart|stop|kill|reload|disable)\\s+${PROCESS_NAMES}`),
    reason: 'systemctl restart/stop on the Agim service',
  },
  {
    regex: new RegExp(`\\b(pkill|killall)\\b[^|;&]*\\b${PROCESS_NAMES}`),
    reason: 'pkill / killall targeting the Agim service',
  },
  {
    regex: new RegExp(`\\bkill\\b[^|;&]*\\$\\(\\s*pgrep[^)]*${PROCESS_NAMES}`),
    reason: 'kill $(pgrep agim)',
  },
  {
    regex: /\b(agim|agim)\s+(restart|stop|start|uninstall)\b/,
    reason: 'recursive invocation of the agim CLI',
  },
  {
    regex: /\bnpm\s+(restart|stop)\b/,
    reason: 'npm restart/stop',
  },
]

/** Patterns matched against Edit/Write content fields (`new_string`,
 *  `content`, `new_source`). These describe code that would dynamically
 *  signal a process — i.e. the script, once written and executed, would
 *  kill agim. Pure shell-literal patterns deliberately don't appear here:
 *  a `.md` file mentioning `systemctl restart agim` is documentation, not
 *  a weapon. */
const CODE_DANGER_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
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

function isExecToolName(toolName: string): boolean {
  const canon = canonicalizeToolName(toolName)
  return toolName === 'Bash' || canon === 'agim_exec'
}

function isWriteToolName(toolName: string): boolean {
  const canon = canonicalizeToolName(toolName)
  return toolName === 'Edit'
    || toolName === 'Write'
    || toolName === 'NotebookEdit'
    || canon === 'agim_write_file'
    || canon === 'agim_edit_file'
}

function execCommandFromInput(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string' && input.command.length > 0) return input.command
  if (typeof input.cmd === 'string' && input.cmd.length > 0) return input.cmd
  return null
}

function scanExecCommand(cmd: string): { deny: true; message: string } | null {
  for (const { regex, reason } of BASH_DANGER_PATTERNS) {
    if (regex.test(cmd)) return { deny: true, message: REDIRECT_TEMPLATE(reason) }
  }
  const ourPid = String(process.pid)
  if (/\bkill\b/.test(cmd) && cmd.includes(ourPid)) {
    return { deny: true, message: REDIRECT_TEMPLATE(`kill ${ourPid} (our pid)`) }
  }
  return null
}

function scanWriteContent(input: Record<string, unknown>): { deny: true; message: string } | null {
  const candidates: string[] = []
  if (typeof input.new_string === 'string') candidates.push(input.new_string)
  if (typeof input.content === 'string') candidates.push(input.content)
  if (typeof input.new_source === 'string') candidates.push(input.new_source)
  if (candidates.length === 0) return null

  const ourPid = String(process.pid)
  for (const hay of candidates) {
    for (const { regex, reason } of CODE_DANGER_PATTERNS) {
      if (regex.test(hay)) return { deny: true, message: REDIRECT_TEMPLATE(reason) }
    }
    if (/process\.kill/.test(hay) && hay.includes(ourPid)) {
      return { deny: true, message: REDIRECT_TEMPLATE(`process.kill(${ourPid}) (our pid)`) }
    }
  }
  return null
}

/** Examine a tool-use request from an agent (Claude/Codex/OpenCode MCP
 *  sidecar relays them all through approval-bus; native exec also calls
 *  this from the dispatcher). Returns a deny reason if it matches a
 *  self-protect pattern, otherwise null. Dispatch is by tool *intent*
 *  (exec vs write), including native `agim_*` names. */
export function checkToolUse(
  toolName: string,
  input: Record<string, unknown>,
): { deny: true; message: string } | null {
  if (isExecToolName(toolName)) {
    const cmd = execCommandFromInput(input)
    if (!cmd) return null
    return scanExecCommand(cmd)
  }

  if (isWriteToolName(toolName)) {
    return scanWriteContent(input)
  }

  // Read, Grep, Glob, LS, NotebookRead, WebFetch, WebSearch, all MCP tools:
  // no shell execution, no content authoring → nothing to defend against.
  return null
}
