// Natural-language service-control intent detection.
//
// Sits in front of the agent routing layer. Users routinely say "重启服务"
// or "restart agim" rather than typing `/restart`; without this, the LLM
// would interpret those messages and shell out to `kill <pid>` or
// `systemctl restart`, bypassing the entire pre-flight + completion-push
// pipeline (and, when --dangerously-skip-permissions is on, doing real
// damage).
//
// Layer 1 strategy: cheap regex on common phrasings. Aims to cover ~80% of
// short forms. The long tail ("帮我把这个 bot 关掉再重开") is intentionally
// left for the agent layer's self-protect hook (core/self-protect.ts),
// which intercepts the dangerous Bash commands LLMs DO produce when this
// regex misses.
//
// Future Layer 3 (env-gated, not implemented): plug in a cheap LLM
// classifier for ambiguous medium-length messages. Out of scope for v1.

/** Detected service-control intent. */
export type ServiceIntent = 'restart' | 'stop' | 'status'

export interface DetectionResult {
  intent: ServiceIntent
  confidence: number
  matchedPattern: string
}

/** Restart phrasings. Anchored to ^/$ where possible so plain prompts
 *  like "看看 PR-3 的 restart 流程怎么写的" don't accidentally trigger. */
const RESTART_PATTERNS: RegExp[] = [
  // /restart slash command (with optional args)
  /^\s*\/restart(\s|$)/i,
  // Bare "重启" / "重启服务" / "重启 bot" / "重启 agim" / "重启一下"
  /^\s*重启(\s*(服务|bot|agim|你|一下|下|系统))*[\s。.!?]*$/i,
  /^\s*重新启动(\s*(服务|bot|agim|你))*[\s。.!?]*$/i,
  // "请重启一下" / "帮我重启" / "麻烦重启"
  /^\s*(请|麻烦|帮我|帮忙|来)\s*(把|让)?\s*(服务|agim|bot|这个|你)?\s*重启/,
  // English variants
  /^\s*restart(\s+(the\s+)?(service|bot|agim|server))?\s*[!.?]*$/i,
  /^\s*reboot(\s+(the\s+)?(service|bot|agim|server))?\s*[!.?]*$/i,
  /^\s*(please|could you)?\s*restart\s+(the\s+)?(service|bot|agim)/i,
]

/** Stop phrasings. */
const STOP_PATTERNS: RegExp[] = [
  /^\s*\/stop(\s|$)/i,
  /^\s*(停止|关闭|停掉|关掉)(\s*(服务|bot|agim|你|一下|下))*[\s。.!?]*$/i,
  /^\s*(请|麻烦|帮我|帮忙)?\s*(把|让)?\s*(服务|agim|bot|这个|你)?\s*(停止|关闭|停掉)/,
  /^\s*stop(\s+(the\s+)?(service|bot|agim|server))?\s*[!.?]*$/i,
  /^\s*shutdown(\s+(the\s+)?(service|bot|agim|server))?\s*[!.?]*$/i,
]

/** Status phrasings. Status is read-only so we tolerate more variants. */
const STATUS_PATTERNS: RegExp[] = [
  /^\s*\/status(\s|$)/i,
  /^\s*(状态|运行状态|健康|健康检查)[\s。.?？]*$/i,
  /^\s*(服务|agim|bot)\s*(状态|怎么样|还好吗|还活着吗)[\s。.?？]*$/i,
  /^\s*(服务|agim|bot)?\s*还活着吗?[\s。.?？]*$/i,
  /^\s*(怎么样|怎样)\s*(了)?[\s。.?？]*$/i,
  /^\s*status[\s.?!]*$/i,
  /^\s*are\s+you\s+(alive|up|ok)\s*\??$/i,
  /^\s*alive\??[\s.!]*$/i,
]

/** Maximum input length to attempt detection. Beyond this we assume the
 *  user is genuinely asking the agent to write code about restart logic
 *  rather than asking to restart. */
const MAX_INPUT_LEN = 80

/**
 * Detect service-control intent from a user message.
 *
 * Returns `null` when no pattern matched (caller should route to agent
 * normally). Matches are anchored to short messages — long-form prompts
 * deliberately fall through to avoid false-positives like "我需要写个
 * 重启服务的脚本".
 */
export function detectServiceIntent(text: string): DetectionResult | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_INPUT_LEN) return null

  for (const p of RESTART_PATTERNS) {
    if (p.test(trimmed)) {
      return { intent: 'restart', confidence: 0.95, matchedPattern: p.source }
    }
  }
  for (const p of STOP_PATTERNS) {
    if (p.test(trimmed)) {
      return { intent: 'stop', confidence: 0.95, matchedPattern: p.source }
    }
  }
  for (const p of STATUS_PATTERNS) {
    if (p.test(trimmed)) {
      return { intent: 'status', confidence: 0.9, matchedPattern: p.source }
    }
  }
  return null
}
