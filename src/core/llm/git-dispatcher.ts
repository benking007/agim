// git-dispatcher — structured git tools for Agim Agent (coding workflow).
//
// Read tools are plan-safe / HITL-exempt. Mutations (add/commit) go through
// the same approval + todo-gate path as agim_write_file. Destructive git
// (push --force, reset --hard) stays on agim_exec intentionally.

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'
import { clampMs, runCmd, truncateText } from './run-cmd.js'

const GIT_READ = [
  'agim_git_status',
  'agim_git_diff',
  'agim_git_log',
] as const

const GIT_WRITE = [
  'agim_git_add',
  'agim_git_commit',
] as const

const GIT_TOOL_NAMES = [...GIT_READ, ...GIT_WRITE] as const

export const GIT_READ_SAFE = new Set<string>(GIT_READ)

export function isGitToolName(name: string): boolean {
  return (GIT_TOOL_NAMES as readonly string[]).includes(canonicalizeToolName(name))
}

export function getGitTools(): ToolDef[] {
  return [
    {
      name: 'agim_git_status',
      description:
        'Show git working-tree status (porcelain + branch). Prefer this over agim_exec git status.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional pathspec to narrow status.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agim_git_diff',
      description:
        'Show git diff. staged=true → --cached. Prefer this before commits for self-review.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional pathspec.' },
          staged: { type: 'boolean', description: 'If true, show staged diff (--cached).' },
          max_chars: { type: 'number', description: 'Truncate output (default 32000).' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agim_git_log',
      description: 'Show recent commits (oneline). Default 10.',
      parameters: {
        type: 'object',
        properties: {
          max: { type: 'number', description: 'Commit count (default 10, max 50).' },
          path: { type: 'string', description: 'Optional pathspec.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agim_git_add',
      description:
        'Stage paths (git add --). Approval-gated. Prefer explicit paths over `.` when possible.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths to stage (required, non-empty).',
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_git_commit',
      description:
        'Create a commit with the given message (git commit -m). Does not push. Approval-gated. '
        + 'Use conventional commits (fix/feat/chore/…). Run agim_git_diff first for self-review.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (required).' },
          all: {
            type: 'boolean',
            description: 'If true, also stage modified/deleted tracked files (-a). Default false.',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  ]
}

export interface GitContext {
  cwd: string
}

export function buildGitDispatcher(ctx: GitContext): ToolDispatcher {
  return async (call, signal): Promise<DispatcherResult> => {
    if (!isGitToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    const name = canonicalizeToolName(call.name)
    try {
      return await runGitTool(name, call.arguments ?? {}, ctx, signal)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { text: `${name} failed: ${msg}`, isError: true, source: 'git' }
    }
  }
}

async function runGitTool(
  name: string,
  args: Record<string, unknown>,
  ctx: GitContext,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const root = await resolveGitRoot(ctx.cwd)
  if (!root.ok) return { text: root.reason, isError: true, source: 'git' }

  switch (name) {
    case 'agim_git_status': {
      const path = str(args.path)
      const cmdArgs = ['status', '--porcelain=v1', '--branch']
      if (path) cmdArgs.push('--', path)
      return gitResult(root.abs, cmdArgs, signal)
    }
    case 'agim_git_diff': {
      const path = str(args.path)
      const staged = args.staged === true
      const maxChars = clampMs(args.max_chars, 32_000, 1_000, 200_000)
      const cmdArgs = ['diff', '--no-color']
      if (staged) cmdArgs.push('--cached')
      if (path) cmdArgs.push('--', path)
      const r = await runCmd('git', cmdArgs, { cwd: root.abs, signal, timeoutMs: 60_000 })
      return formatCmd(r, maxChars)
    }
    case 'agim_git_log': {
      const max = clampMs(args.max, 10, 1, 50)
      const path = str(args.path)
      const cmdArgs = ['log', `-${max}`, '--oneline', '--no-color']
      if (path) cmdArgs.push('--', path)
      return gitResult(root.abs, cmdArgs, signal)
    }
    case 'agim_git_add': {
      const paths = asStringArray(args.paths)
      if (paths.length === 0) {
        return { text: 'paths required (non-empty array)', isError: true, source: 'git' }
      }
      if (paths.some((p) => p === '-A' || p === '--all' || p.startsWith('-'))) {
        return { text: 'refusing flag-like path; pass real file paths only', isError: true, source: 'git' }
      }
      return gitResult(root.abs, ['add', '--', ...paths], signal)
    }
    case 'agim_git_commit': {
      const message = str(args.message).trim()
      if (!message) return { text: 'message required', isError: true, source: 'git' }
      if (message.includes('\0')) {
        return { text: 'message must not contain NUL', isError: true, source: 'git' }
      }
      const cmdArgs = ['commit', '-m', message]
      if (args.all === true) cmdArgs.splice(1, 0, '-a')
      return gitResult(root.abs, cmdArgs, signal)
    }
    default:
      return { text: `unknown git tool: ${name}`, isError: true, source: 'git' }
  }
}

async function gitResult(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const r = await runCmd('git', args, { cwd, signal, timeoutMs: 60_000 })
  return formatCmd(r, 32_000)
}

function formatCmd(r: Awaited<ReturnType<typeof runCmd>>, maxChars: number): DispatcherResult {
  if (r.timedOut) {
    return { text: 'git timed out', isError: true, source: 'git' }
  }
  const body = truncateText(
    [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n'),
    maxChars,
  )
  // git diff/status exit 0; commit may fail with 1
  const ok = r.exitCode === 0
  return {
    text: ok ? (body || '(empty)') : (body || `git exit ${r.exitCode}`),
    isError: !ok,
    source: 'git',
  }
}

async function resolveGitRoot(cwd: string): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  const abs = isAbsolute(cwd) ? cwd : resolvePath(cwd)
  if (!existsSync(abs)) return { ok: false, reason: `cwd does not exist: ${abs}` }
  const r = await runCmd('git', ['rev-parse', '--show-toplevel'], { cwd: abs, timeoutMs: 10_000 })
  if (r.exitCode !== 0) {
    return { ok: false, reason: `not a git repository: ${abs}` }
  }
  return { ok: true, abs: r.stdout.trim() || abs }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

/** Test helper: path join under cwd. */
export function _joinUnderCwdForTest(cwd: string, rel: string): string {
  return join(cwd, rel)
}
