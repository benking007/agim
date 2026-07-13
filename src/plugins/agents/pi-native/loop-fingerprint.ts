/** Deterministic JSON identity for tool arguments. Object key insertion order
 * must not let a model evade the repeated-failure guard. */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'function') return '"[function]"'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value)) return '"[circular]"'
  seen.add(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(',')}}`
}

/** Normalize volatile request ids/timestamps while preserving meaningful
 * classes such as HTTP 404 vs 503. */
export function normalizeErrorFingerprint(text: string): string {
  const first = text.split('\n').find((line) => line.trim())?.trim().toLowerCase() ?? ''
  return first
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.+-]+z?\b/gi, '<timestamp>')
    .replace(/\b(request(?:[_ -]?id)?|req(?:uest)?[_ -]?id|trace[_ -]?id)\s*[:=#]?\s*[a-z0-9-]{6,}\b/gi, '$1 <id>')
    .replace(/\s+/g, ' ')
    .slice(0, 512)
}

export function failureSignature(toolName: string, input: unknown, resultPreview: string): string {
  return `${toolName}|${stableStringify(input)}|${normalizeErrorFingerprint(resultPreview)}`
}
