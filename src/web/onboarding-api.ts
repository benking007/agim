// First-run onboarding REST surface.
//
//   GET  /api/onboarding/status  → first-run flag + reason (admin)
//   POST /api/onboarding/skip    → persist setupSkipped and return status

import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadOnboardingStatus, markSetupSkipped } from '../core/onboarding-status.js'
import { sendJson, sendError } from './http-utils.js'
import { requireAdmin } from './auth.js'

export async function handleOnboardingApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = (req.method ?? 'GET').toUpperCase()

  if (p === '/api/onboarding/status' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    try {
      sendJson(res, 200, await loadOnboardingStatus())
    } catch (err) {
      sendError(res, 500, 'ONBOARDING_STATUS_FAILED', {
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  if (p === '/api/onboarding/skip' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    try {
      sendJson(res, 200, await markSetupSkipped())
    } catch (err) {
      sendError(res, 500, 'ONBOARDING_SKIP_FAILED', {
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  return false
}
