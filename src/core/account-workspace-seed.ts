// Seed a per-account agent workspace from packaged templates.
//
// Account trees live at `~/.agim-workspaces/users/<usr_*>/<agent>/`.
// We never copy the shared `~/.agim-workspaces/<agent>/` tree — that may
// hold another operator's customized persona (e.g. 「小马」).
//
// Idempotent: existing AGENTS.md / CLAUDE.md / MEMORY.md are never
// overwritten. Layout directories are mkdir -p.

import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import {
  agentCwdForAccount,
  ensureAgentMemoryLink,
  ensureAgentWorkspace,
  ensureAgimImOpsGuide,
  isAccountWorkspaceUserId,
  roleFileForAgent,
  toDisplayWorkspacePath,
} from './agent-cwd.js'
import {
  ACCOUNT_CLAUDE_MEMORY_STUB,
  ACCOUNT_MEMORY_STUB,
  ACCOUNT_PROJECTS_README,
  roleSeedForAgent,
} from './agent-workspace-seeds.js'

const log = rootLogger.child({ component: 'account-workspace-seed' })

function cwdEnvKey(agentName: string): string {
  return `AGIM_${agentName.replace(/-/g, '_').toUpperCase()}_CWD`
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
  }
  await writeFile(path, content, 'utf8')
  return true
}

/**
 * Create the required layout for one account + agent.
 * Returns the workspace directory, or null when skipped / failed.
 */
export async function seedAccountAgentWorkspace(
  userId: string,
  agentName = 'agim',
): Promise<string | null> {
  if (!isAccountWorkspaceUserId(userId)) return null
  const agent = agentName === 'native' ? 'agim' : agentName
  if (process.env[cwdEnvKey(agent)]?.trim()) return null

  try {
    const dir = agentCwdForAccount(agent, userId)
    const displayRoot = toDisplayWorkspacePath(dir)
    const filename = roleFileForAgent(agent)
    const seed = roleSeedForAgent(agent, {
      fileLocation: `${displayRoot}/${filename}`,
      workspaceRoot: displayRoot,
    })

    await ensureAgentWorkspace(agent, seed, { dir })
    await mkdir(join(dir, 'PROJECTS', 'loops'), { recursive: true })
    await mkdir(join(dir, 'SESSIONS'), { recursive: true })
    if (agent === 'claude-code') {
      await mkdir(join(dir, 'memory'), { recursive: true })
      await writeIfMissing(join(dir, 'memory', 'MEMORY.md'), ACCOUNT_CLAUDE_MEMORY_STUB)
    }
    await writeIfMissing(join(dir, 'MEMORY.md'), ACCOUNT_MEMORY_STUB)
    await writeIfMissing(join(dir, 'PROJECTS', 'README.md'), ACCOUNT_PROJECTS_README)
    await ensureAgentMemoryLink(agent, seed.filename, { dir })
    await ensureAgimImOpsGuide(agent, seed.filename, { dir, workspaceRoot: displayRoot })
    return dir
  } catch (err) {
    log.warn({
      event: 'account.workspace.seed_failed',
      userId,
      agent,
      err: err instanceof Error ? err.message : String(err),
    }, 'account workspace seed failed')
    return null
  }
}

/** Seed the default Agim workspace for a newly registered / logging-in member. */
export async function seedAccountWorkspaces(userId: string): Promise<string | null> {
  return seedAccountAgentWorkspace(userId, 'agim')
}
