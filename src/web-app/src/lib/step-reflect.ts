/** Client-side Step Reflect helpers (carousel + activity merge). */

export type StepReflectStance = 'keep' | 'adjust' | 'stop'

export interface StepReflectRecord {
  stance: StepReflectStance
  next: string
  at: number
}

const STANCES = new Set<StepReflectStance>(['keep', 'adjust', 'stop'])

export function isAgimFamilyLabel(label: string): boolean {
  const head = (label || '').split(/[/:]/)[0].trim().toLowerCase()
  return head === 'agim' || head === 'native'
}

export function mergeStepReflects(
  prev: readonly StepReflectRecord[] | undefined,
  incoming: readonly StepReflectRecord[] | undefined,
): StepReflectRecord[] | undefined {
  if (!incoming?.length) return prev ? [...prev] : undefined
  const out = prev ? [...prev] : []
  for (const rec of incoming) {
    if (!rec || !STANCES.has(rec.stance) || !rec.next) continue
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : Date.now()
    if (out.some((x) => x.at === at && x.next === rec.next && x.stance === rec.stance)) continue
    out.push({ stance: rec.stance, next: rec.next.trim(), at })
  }
  return out.length > 0 ? out.slice(-3) : undefined
}
