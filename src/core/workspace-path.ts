/**
 * Resolve a Portal workspace path the agent can actually open.
 *
 * Portal folders are host directories under this agent's default cwd
 * (`~/.agim-workspaces/<agent>/`, or `AGIM_WORKSPACES_ROOT`). The
 * workspace root itself is the default "Cloud" workspace — only a
 * strict subdirectory may be bound as a named folder. Paths outside
 * that tree (local laptop folders, `/etc`, another agent's tree) are
 * rejected so a remote browser cannot point the agent at arbitrary
 * host paths.
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { agentCwdForAccount, defaultAgentCwd, isAccountWorkspaceUserId } from './agent-cwd.js'
import { isSensitivePath } from './sensitive-paths.js'

export function resolvePortalWorkspacePath(
  raw: string | undefined | null,
  agentName: string,
  accountUserId?: string,
): string | undefined {
  const trimmed = (raw ?? '').trim()
  const agent = (agentName ?? '').trim()
  if (!trimmed || !agent || trimmed.includes('\0')) return undefined
  if (trimmed.split(/[\\/]/).includes('..')) return undefined

  const uid = typeof accountUserId === 'string' ? accountUserId.trim() : ''
  const rootDir = isAccountWorkspaceUserId(uid) ? agentCwdForAccount(agent, uid) : defaultAgentCwd(agent)

  let root: string
  try {
    mkdirSync(rootDir, { recursive: true })
    root = realpathSync(rootDir)
  } catch {
    return undefined
  }

  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
  if (!isStrictSubdir(root, candidate)) return undefined

  try {
    const st = statSync(candidate)
    if (!st.isDirectory()) return undefined
    const real = realpathSync(candidate)
    if (!isStrictSubdir(root, real)) return undefined
    if (isSensitivePath(real).sensitive) return undefined
    return real
  } catch {
    return undefined
  }
}

function isStrictSubdir(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}
