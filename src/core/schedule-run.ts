// Helpers for a scheduled Job Board turn: unwrap the prompt prefix,
// resolve the account cwd, mkdir the artifacts dir (never chdir into it).

import { mkdirSync } from 'node:fs'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import type { AgentSendOpts } from './types.js'
import { agentCwdForAccount, defaultAgentCwd } from './agent-cwd.js'
import {
  artifactsInstruction,
  parseSchedulePrompt,
  sanitizeArtifactsRel,
} from './schedule-prompt.js'

export interface PreparedScheduledTurn {
  userPrompt: string
  model?: string
  workspacePath: string
  userId?: string
  artifactsRel?: string
  artifactsAbs?: string
  sendOpts: AgentSendOpts
}

function ensureDir(path: string): void {
  try { mkdirSync(path, { recursive: true }) } catch { /* spawn still gets the path */ }
}

function resolveUnderBase(base: string, rel: string): string | null {
  const target = resolvePath(base, rel)
  if (target !== base && !target.startsWith(base + pathSep)) return null
  return target
}

export function prepareScheduledTurn(input: {
  agent: string
  prompt: string
  creatorId?: string
}): PreparedScheduledTurn {
  const userId = input.creatorId?.trim() || undefined
  const { meta, body } = parseSchedulePrompt(input.prompt)
  const workspacePath = userId
    ? agentCwdForAccount(input.agent, userId)
    : defaultAgentCwd(input.agent)
  ensureDir(workspacePath)

  let artifactsRel: string | undefined
  let artifactsAbs: string | undefined
  const safeRel = meta.artifacts ? sanitizeArtifactsRel(meta.artifacts) : null
  if (safeRel) {
    const abs = resolveUnderBase(workspacePath, safeRel)
    if (abs) {
      ensureDir(abs)
      artifactsRel = safeRel
      artifactsAbs = abs
    }
  }

  let userPrompt = body
  if (artifactsRel) userPrompt += artifactsInstruction(artifactsRel, artifactsAbs)

  const isAgim = input.agent === 'agim' || input.agent === 'native'
  const model = isAgim && meta.model ? meta.model : undefined
  const sendOpts: AgentSendOpts = {
    workspacePath,
    ...(userId ? { userId } : {}),
    ...(model ? { model } : {}),
  }
  return { userPrompt, model, workspacePath, userId, artifactsRel, artifactsAbs, sendOpts }
}
