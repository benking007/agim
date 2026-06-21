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
  if (!m.includes('native')) return false
  return (
    m.includes('not configured')
    || m.includes('not available')
    || m.includes('no llm backend')
    || m.includes('llmroles.native-chat')
    || raw.includes('/settings/llm')
    || raw.includes('未配置')
    || raw.includes('大模型')
  )
}
