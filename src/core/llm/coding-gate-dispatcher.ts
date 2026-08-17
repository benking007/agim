// coding-gate-dispatcher — diagnostics, structured tests, quality gate.
//
// Diagnostics use Biome JSON when available (fast, path-scoped). Full
// typecheck/test remain explicit tools so the model can choose cost.

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createRequire } from 'node:module'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'
import { clampMs, runCmd, truncateText } from './run-cmd.js'

const READ_TOOLS = ['agim_diagnostics'] as const
const RUN_TOOLS = ['agim_test_run', 'agim_quality_gate'] as const
const ALL = [...READ_TOOLS, ...RUN_TOOLS] as const

export const CODING_READ_SAFE = new Set<string>(READ_TOOLS)

export function isCodingGateToolName(name: string): boolean {
  return (ALL as readonly string[]).includes(canonicalizeToolName(name))
}

export function getCodingGateTools(): ToolDef[] {
  return [
    {
      name: 'agim_diagnostics',
      description:
        'Return structured lint/format diagnostics for a path (Biome JSON when available). '
        + 'Prefer this after edits instead of raw agim_exec lint. For full project typecheck '
        + 'use agim_quality_gate({ checks: ["typecheck"] }).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File or directory relative to cwd (default: .).',
          },
          max_findings: {
            type: 'number',
            description: 'Max diagnostics returned (default 50, max 200).',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agim_test_run',
      description:
        'Run the project test suite in a structured way. suite=unit → npm test (Bun); '
        + 'web → web-app vitest; node → npm run test:node. Optional filter narrows paths. '
        + 'Approval-gated. Prefer this over ad-hoc agim_exec for verification.',
      parameters: {
        type: 'object',
        properties: {
          suite: {
            type: 'string',
            enum: ['unit', 'web', 'node', 'sqlite'],
            description: 'Which suite to run (default unit).',
          },
          filter: {
            type: 'string',
            description: 'Optional path/name filter passed to the test runner.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Hard timeout (default 300000, max 600000).',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'agim_quality_gate',
      description:
        'Run the coding quality gate and return per-step pass/fail. Default checks: '
        + 'lint + typecheck + test. checks=["full"] runs npm run verify:release when present. '
        + 'Call before claiming a change is done. Approval-gated.',
      parameters: {
        type: 'object',
        properties: {
          checks: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['lint', 'typecheck', 'test', 'full'],
            },
            description: 'Subset of checks (default lint,typecheck,test).',
          },
          timeout_ms: {
            type: 'number',
            description: 'Per-step timeout (default 300000, max 600000).',
          },
        },
        additionalProperties: false,
      },
    },
  ]
}

export interface CodingGateContext {
  cwd: string
}

export function buildCodingGateDispatcher(ctx: CodingGateContext): ToolDispatcher {
  return async (call, signal): Promise<DispatcherResult> => {
    if (!isCodingGateToolName(call.name)) {
      return { text: `not handled: ${call.name}`, isError: true, source: 'unknown' }
    }
    const name = canonicalizeToolName(call.name)
    try {
      switch (name) {
        case 'agim_diagnostics':
          return await runDiagnostics(call.arguments ?? {}, ctx, signal)
        case 'agim_test_run':
          return await runTests(call.arguments ?? {}, ctx, signal)
        case 'agim_quality_gate':
          return await runQualityGate(call.arguments ?? {}, ctx, signal)
        default:
          return { text: `unknown coding tool: ${name}`, isError: true, source: 'coding' }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { text: `${name} failed: ${msg}`, isError: true, source: 'coding' }
    }
  }
}

async function runDiagnostics(
  args: Record<string, unknown>,
  ctx: CodingGateContext,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const cwd = resolveCwd(ctx.cwd)
  const target = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.'
  const maxFindings = clampMs(args.max_findings, 50, 1, 200)
  const biome = resolveBiomeBin(cwd)
  if (!biome) {
    return {
      text: JSON.stringify({
        ok: false,
        engine: 'none',
        reason: 'biome not found (install @biomejs/biome or run from a repo that vendors it)',
        findings: [],
      }, null, 2),
      isError: true,
      source: 'coding',
    }
  }
  const r = await runCmd(biome, ['check', target, '--reporter=json'], {
    cwd,
    signal,
    timeoutMs: 120_000,
  })
  const findings = parseBiomeFindings(r.stdout || r.stderr, maxFindings)
  const payload = {
    ok: r.exitCode === 0 && !r.timedOut,
    engine: 'biome',
    target,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    total: findings.total,
    returned: findings.items.length,
    truncated: findings.total > findings.items.length,
    findings: findings.items,
  }
  return {
    text: truncateText(JSON.stringify(payload, null, 2), 48_000),
    isError: !payload.ok,
    source: 'coding',
  }
}

async function runTests(
  args: Record<string, unknown>,
  ctx: CodingGateContext,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const cwd = resolveCwd(ctx.cwd)
  const suite = args.suite === 'web' || args.suite === 'node' || args.suite === 'sqlite'
    ? args.suite
    : 'unit'
  const filter = typeof args.filter === 'string' ? args.filter.trim() : ''
  const timeoutMs = clampMs(args.timeout_ms, 300_000, 5_000, 600_000)

  let cmd: string
  let cmdArgs: string[]
  if (suite === 'web') {
    cmd = 'npm'
    cmdArgs = ['--prefix', 'src/web-app', 'test', '--', '--run']
    if (filter) cmdArgs.push(filter)
  } else if (suite === 'node') {
    cmd = 'npm'
    cmdArgs = ['run', 'test:node']
  } else if (suite === 'sqlite') {
    cmd = 'npm'
    cmdArgs = ['run', 'test:sqlite']
  } else {
    cmd = 'npm'
    cmdArgs = ['test']
    if (filter) cmdArgs.push('--', filter)
  }

  const started = Date.now()
  const r = await runCmd(cmd, cmdArgs, { cwd, signal, timeoutMs })
  const out = truncateText(
    [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n'),
    40_000,
  )
  const payload = {
    ok: r.exitCode === 0 && !r.timedOut,
    suite,
    filter: filter || null,
    command: [cmd, ...cmdArgs].join(' '),
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: Date.now() - started,
    output: out,
  }
  return {
    text: JSON.stringify(payload, null, 2),
    isError: !payload.ok,
    source: 'coding',
  }
}

async function runQualityGate(
  args: Record<string, unknown>,
  ctx: CodingGateContext,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const cwd = resolveCwd(ctx.cwd)
  const timeoutMs = clampMs(args.timeout_ms, 300_000, 5_000, 600_000)
  const rawChecks = Array.isArray(args.checks)
    ? args.checks.filter((c): c is string => typeof c === 'string')
    : []
  const wantsFull = rawChecks.includes('full')
  const checks = wantsFull
    ? (['full'] as const)
    : (rawChecks.length > 0
      ? rawChecks.filter((c): c is 'lint' | 'typecheck' | 'test' =>
        c === 'lint' || c === 'typecheck' || c === 'test')
      : (['lint', 'typecheck', 'test'] as const))

  const steps: Array<{
    name: string
    ok: boolean
    exitCode: number
    timedOut: boolean
    durationMs: number
    summary: string
  }> = []

  for (const check of checks) {
    const started = Date.now()
    const script = check === 'full' ? 'verify:release' : check
    // Prefer npm run <script> when package.json defines it.
    const hasScript = packageHasScript(cwd, script)
    let r: Awaited<ReturnType<typeof runCmd>>
    if (hasScript) {
      r = await runCmd('npm', ['run', script], { cwd, signal, timeoutMs })
    } else if (check === 'lint') {
      const biome = resolveBiomeBin(cwd)
      if (!biome) {
        steps.push({
          name: 'lint',
          ok: false,
          exitCode: -1,
          timedOut: false,
          durationMs: 0,
          summary: 'no npm run lint and biome binary missing',
        })
        continue
      }
      r = await runCmd(biome, ['check', '.'], { cwd, signal, timeoutMs })
    } else if (check === 'typecheck') {
      r = await runCmd('npx', ['tsc', '--noEmit'], { cwd, signal, timeoutMs })
    } else if (check === 'test') {
      r = await runCmd('npm', ['test'], { cwd, signal, timeoutMs })
    } else {
      steps.push({
        name: check,
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: 0,
        summary: `no npm run ${script} script in package.json`,
      })
      continue
    }
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n')
    steps.push({
      name: check,
      ok: r.exitCode === 0 && !r.timedOut,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      summary: summarizeOutput(combined),
    })
  }

  const ok = steps.every((s) => s.ok)
  const payload = { ok, cwd, steps }
  return {
    text: JSON.stringify(payload, null, 2),
    isError: !ok,
    source: 'coding',
  }
}

function resolveCwd(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolvePath(cwd)
}

function resolveBiomeBin(cwd: string): string | null {
  const local = join(cwd, 'node_modules', '.bin', 'biome')
  if (existsSync(local)) return local
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const pkg = req.resolve('@biomejs/biome/package.json')
    const bin = join(pkg, '..', 'bin', 'biome')
    if (existsSync(bin)) return bin
  } catch { /* ignore */ }
  return null
}

function packageHasScript(cwd: string, name: string): boolean {
  try {
    const pkgPath = join(cwd, 'package.json')
    if (!existsSync(pkgPath)) return false
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    return typeof pkg.scripts?.[name] === 'string'
  } catch {
    return false
  }
}

interface Finding {
  severity: string
  message: string
  category?: string
  path?: string
  line?: number
  column?: number
}

function parseBiomeFindings(raw: string, max: number): { total: number; items: Finding[] } {
  const text = raw.trim()
  if (!text) return { total: 0, items: [] }
  // Biome may emit non-JSON warnings before/after; find first `{`.
  const start = text.indexOf('{')
  if (start < 0) return { total: 0, items: [] }
  try {
    const parsed = JSON.parse(text.slice(start)) as {
      diagnostics?: Array<{
        severity?: string
        message?: string
        category?: string
        location?: { path?: string; start?: { line?: number; column?: number } }
      }>
      summary?: { errors?: number; warnings?: number }
    }
    const diags = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []
    const items: Finding[] = []
    for (const d of diags) {
      if (items.length >= max) break
      items.push({
        severity: d.severity ?? 'unknown',
        message: d.message ?? '',
        category: d.category,
        path: d.location?.path,
        line: d.location?.start?.line,
        column: d.location?.start?.column,
      })
    }
    return { total: diags.length, items }
  } catch {
    return {
      total: 0,
      items: [{ severity: 'error', message: 'failed to parse biome JSON reporter output' }],
    }
  }
}

function summarizeOutput(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  if (lines.length === 0) return '(no output)'
  const tail = lines.slice(-12).join('\n')
  return truncateText(tail, 1_500)
}
