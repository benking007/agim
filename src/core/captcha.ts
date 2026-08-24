// Self-hosted SVG captcha. No external service — Agim often runs offline.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TTL_MS = 5 * 60 * 1000
const ALPHABET = 'ABDEFGHKMNPRSTWXYZ23456789'

interface Challenge {
  answerHash: string
  expiresAt: number
}

const challenges = new Map<string, Challenge>()

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

function randomChars(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

function prune(): void {
  const now = Date.now()
  for (const [id, row] of challenges) {
    if (row.expiresAt <= now) challenges.delete(id)
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderSvg(answer: string): string {
  const glyphs = [...answer].map((ch, i) => {
    const x = 18 + i * 28
    const y = 32 + ((i % 2) === 0 ? -4 : 4)
    const rot = (i % 2 === 0 ? -12 : 10) + (i * 3)
    return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" fill="#1f2328" font-size="28" font-family="ui-monospace,monospace" font-weight="700">${escapeXml(ch)}</text>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48" role="img" aria-label="captcha">`
    + `<rect width="160" height="48" fill="#f4f6f8"/>`
    + `<line x1="8" y1="18" x2="152" y2="30" stroke="#d0d7de" stroke-width="2"/>`
    + `<line x1="12" y1="38" x2="148" y2="14" stroke="#d0d7de" stroke-width="1.5"/>`
    + glyphs
    + `</svg>`
}

export function issueCaptcha(): { id: string; svg: string; expiresAt: number } {
  prune()
  const answer = randomChars(4)
  const id = `cap_${randomBytes(8).toString('hex')}`
  const expiresAt = Date.now() + TTL_MS
  challenges.set(id, { answerHash: sha256Hex(answer.toLowerCase()), expiresAt })
  return { id, svg: renderSvg(answer), expiresAt }
}

export function consumeCaptcha(id: string, answer: string): boolean {
  prune()
  const row = challenges.get(id)
  if (!row) return false
  challenges.delete(id)
  if (row.expiresAt <= Date.now()) return false
  const got = sha256Hex((answer || '').trim().toLowerCase())
  try {
    const a = Buffer.from(got, 'hex')
    const b = Buffer.from(row.answerHash, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function _resetCaptchaForTests(): void {
  challenges.clear()
}

export function _issueCaptchaForTests(answer: string): { id: string; svg: string } {
  prune()
  const id = `cap_${randomBytes(8).toString('hex')}`
  const expiresAt = Date.now() + TTL_MS
  challenges.set(id, { answerHash: sha256Hex(answer.toLowerCase()), expiresAt })
  return { id, svg: renderSvg(answer) }
}

/** Test-only: peek the stored answer hash for a challenge. */
export function _challengeCountForTests(): number {
  prune()
  return challenges.size
}
