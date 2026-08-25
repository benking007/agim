/** Compact remaining/used label for the composer chip. */
export function formatPointsCompact(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(Math.round(n))
  const sign = n < 0 ? '-' : ''
  if (abs < 10_000) return `${sign}${abs}`
  if (abs < 1_000_000) {
    const k = abs / 1000
    const body = Number.isInteger(k) ? String(k) : k.toFixed(1)
    return `${sign}${body}k`
  }
  return `${sign}${(abs / 1_000_000).toFixed(1)}M`
}

export function monthDayLabel(day: string): string {
  const parts = day.split('-')
  if (parts.length !== 3) return day
  const month = Number(parts[1])
  const date = Number(parts[2])
  if (!Number.isFinite(month) || !Number.isFinite(date)) return day
  return `${month}/${date}`
}

export interface SparklineLayout {
  line: string
  area: string
  max: number
}

/** SVG path for a daily spend polyline inside a viewBox. */
export function sparklineLayout(
  values: number[],
  width = 280,
  height = 72,
  padX = 4,
  padY = 6,
): SparklineLayout {
  const max = Math.max(1, ...values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)))
  const innerW = Math.max(1, width - padX * 2)
  const innerH = Math.max(1, height - padY * 2)
  if (values.length === 0) {
    return { line: '', area: '', max }
  }
  const step = values.length === 1 ? 0 : innerW / (values.length - 1)
  const points = values.map((raw, i) => {
    const v = Number.isFinite(raw) && raw > 0 ? raw : 0
    const x = padX + i * step
    const y = padY + innerH - (v / max) * innerH
    return { x, y }
  })
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  const first = points[0]
  if (!last || !first) {
    return { line: '', area: '', max }
  }
  const area = `${line} L${last.x.toFixed(1)} ${(padY + innerH).toFixed(1)} L${first.x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`
  return { line, area, max }
}
