// /router compare — Stage 5 A/B evaluator slash command.
//
// Usage:
//
//   /router compare <a> <b> <prompt…>
//   /router compare agent:claude-code llm:cheap "explain this regex …"
//   /router compare llm:native-chat backend:deepseek-v4-pro "draft a tweet about …"
//
// The two backend specs follow `kind:name`:
//
//   agent:<adapter-name>     CLI / native AgentAdapter (claude-code, codex,
//                            opencode, native, …)
//   llm:<role>               native LLM role (cheap, evaluator, native-chat)
//   backend:<backend-name>   native LLM backend name from config llmBackends
//
// When AGIM_ROUTER_COMPARE_JUDGE_ROLE is set, the configured role
// also gets called as an impartial judge — pick a / b / tie. Cost is
// reported as a separate line so per-side numbers stay honest.

import type { RouteContext } from '../router.js'
import { parseBackendRef, runRouterCompare, formatCompareResult } from '../router-compare.js'

const HELP = [
  '🆚 **/router compare** \u2014 A/B evaluator (Stage 5)',
  '',
  '\u7528\u6cd5\uff1a',
  '  `/router compare <a> <b> <prompt>`',
  '  `/router compare help`',
  '',
  '\u540e\u7aef\u8bf4\u660e\u7b26 (kind:name)\uff1a',
  '  `agent:<adapter-name>`     CLI / native AgentAdapter (claude-code, codex, opencode, native, ...)',
  '  `llm:<role>`               native LLM role (cheap, evaluator, native-chat)',
  '  `backend:<backend-name>`   native LLM backend name (from `llmBackends`)',
  '',
  '\u73af\u5883\uff1a',
  '  `AGIM_ROUTER_COMPARE_JUDGE_ROLE` \u2014 \u8bbe\u4e3a\u67d0\u4e2a native LLM role (\u4f8b\u5982 `evaluator`)',
  '   \u540e\uff0c\u6bcf\u6b21 compare \u90fd\u4f1a\u4e09\u8005\u9009\u4e00\u5224\u5b9a a/b/tie\uff0c\u6210\u672c\u5355\u72ec\u62a5\u51fa\u3002',
  '',
  '\u4f8b\u5b50\uff1a',
  '  `/router compare agent:claude-code llm:cheap "\u89e3\u91ca\u8fd9\u4e2a\u6b63\u5219"`',
  '  `/router compare llm:native-chat backend:deepseek-v4-pro "\u8d77\u8349\u4e00\u4e2a\u53d1\u5e03\u8bf4\u660e"`',
].join('\n')

export async function handleRouterCompareCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  if (!trimmed) return HELP
  const lower = trimmed.toLowerCase()
  if (lower === 'help' || lower === '?') return HELP

  // Pull out the two backend specs (first two whitespace-delimited
  // tokens), the rest becomes the prompt.
  const m = trimmed.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/)
  if (!m) {
    return [
      '❌ \u7528\u6cd5\uff1a`/router compare <a> <b> <prompt>`',
      '\u4f8b\uff1a`/router compare agent:claude-code llm:cheap "\u89e3\u91ca\u6b63\u5219"`',
      '\u8be6\u60c5\uff1a`/router compare help`',
    ].join('\n')
  }
  const aRef = parseBackendRef(m[1])
  const bRef = parseBackendRef(m[2])
  if (!aRef) return `❌ \u65e0\u6cd5\u89e3\u6790 a \u540e\u7aef\uff1a\`${m[1]}\`\uff0c\u671f\u671b kind:name (\u4f8b agent:claude-code / llm:cheap / backend:deepseek)`
  if (!bRef) return `❌ \u65e0\u6cd5\u89e3\u6790 b \u540e\u7aef\uff1a\`${m[2]}\`\uff0c\u671f\u671b kind:name (\u4f8b agent:claude-code / llm:cheap / backend:deepseek)`
  if (aRef.kind === bRef.kind && aRef.name === bRef.name) {
    return '❌ a \u4e0e b \u4e0d\u80fd\u662f\u540c\u4e00\u540e\u7aef\u3002'
  }

  const prompt = m[3].trim()
  if (!prompt) return '❌ prompt \u4e0d\u80fd\u4e3a\u7a7a\u3002'

  const judgeRole = process.env.AGIM_ROUTER_COMPARE_JUDGE_ROLE?.trim() || undefined

  const result = await runRouterCompare({
    prompt,
    a: aRef,
    b: bRef,
    judgeRole,
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
  })
  return formatCompareResult(result)
}
