/** Build the `/loop …` message sent when the aligning dock confirms. */
export function buildAlignPayload(objective: string, exit: string, body?: string): string {
  const o = objective.trim()
  const e = exit.trim()
  const b = (body || '').trim()
  let msg = `/loop ${o}；退出条件为${e}`
  if (b) msg += `；正文：${b}`
  return msg
}
