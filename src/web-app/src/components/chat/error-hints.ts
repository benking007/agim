/**
 * Native-agent setup hint detection.
 *
 * WS errors are plain strings today; when switching to `native` without
 * an LLM backend the backend now emits guidance text. This helper keeps
 * route components from duplicating brittle string checks.
 */
export function isNativeSetupError(message: string): boolean {
  const raw = String(message || '')
  if (!raw) return false
  const m = raw.toLowerCase()
  const mentionsAgent = m.includes('native') || m.includes('agim')
  if (!mentionsAgent && !raw.includes('/settings/llm')) return false
  return (
    m.includes('not configured')
    || m.includes('not available')
    || m.includes('no llm backend')
    || m.includes('llmroles.native-chat')
    || m.includes('api key')
    || raw.includes('/settings/llm')
    || raw.includes('setup llm quick')
    || raw.includes('未配置')
    || raw.includes('大模型')
    || raw.includes('一键启用')
  )
}
