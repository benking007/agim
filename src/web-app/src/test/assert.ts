export function requireValue<T>(
  value: T | null | undefined,
  description = 'value',
): T {
  if (value == null) throw new Error(`Expected ${description}`)
  return value
}
