import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { getGoalsDatabaseForLedger, type GoalStatus, type ProgressNote } from './goals.js'

export type GoalEvidenceKind = 'control' | 'observation' | 'mutation' | 'mutation_verification'

export interface GoalEvidenceContext {
  goalId: number
  goalVersion: number
  traceId?: string
}

export interface GoalToolOperation {
  ledgerId: number
  goalId: number
  goalVersion: number
  epoch: number
  kind: Exclude<GoalEvidenceKind, 'control'>
}

export interface IssuedEvidence {
  id: string
  kind: 'observation' | 'verification'
  epoch: number
}

const KEY_FILE = join(AGIM_HOME, 'goal-evidence.key')
let cachedKey: Buffer | null = null
const PROCESS_OWNER_ID = `${process.pid}:${Date.now()}:${randomUUID()}`
let reconciledOwners = false

function secretKey(): Buffer {
  if (cachedKey) return cachedKey
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
  if (!existsSync(KEY_FILE)) {
    try {
      writeFileSync(KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  if (process.platform !== 'win32') chmodSync(KEY_FILE, 0o600)
  cachedKey = readFileSync(KEY_FILE)
  if (cachedKey.byteLength < 32) throw new Error('goal evidence key is invalid')
  return cachedKey
}

function hmac(value: string): string {
  return createHmac('sha256', secretKey()).update(value).digest('hex')
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function traceRoot(traceId?: string): string {
  return (traceId ?? '').split('/a2a-')[0] ?? ''
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Reconcile mutation intents owned by processes that are no longer alive.
 * Live foreign owners remain blocking, so concurrent agents cannot mistake
 * each other's in-flight writes for crash debris. */
export function reconcileInterruptedGoalOperations(): number {
  if (reconciledOwners) return 0
  const d = getGoalsDatabaseForLedger()
  if (!d) return 0
  const owners = d.prepare(`
    SELECT DISTINCT owner_id, owner_pid FROM goal_ledger
    WHERE kind IN ('mutation', 'mutation_verification') AND state = 'started'
  `).all() as Array<{ owner_id: string; owner_pid: number }>
  const stale = owners.filter((owner) =>
    owner.owner_id !== PROCESS_OWNER_ID && !isPidAlive(owner.owner_pid))
  if (stale.length === 0) {
    reconciledOwners = true
    return 0
  }
  const tx = d.transaction(() => {
    d.prepare(`
      UPDATE goals SET mutation_epoch = mutation_epoch + 1, updated_at = datetime('now')
      WHERE status = 'active'
    `).run()
    const update = d.prepare(`
      UPDATE goal_ledger SET state = 'unknown', finished_at = datetime('now')
      WHERE owner_id = ? AND owner_pid = ?
        AND kind IN ('mutation', 'mutation_verification') AND state = 'started'
    `)
    let changed = 0
    for (const owner of stale) changed += update.run(owner.owner_id, owner.owner_pid).changes
    return changed
  })
  const changed = tx.immediate()
  reconciledOwners = true
  return changed
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

const CONTROL_TOOLS = new Set([
  'native_echo',
  'native_now',
  'native_sleep_ms',
  'native_random_uuid',
  'native_todo_write',
  'native_exit_plan_mode',
  'mcp__agim__long_task',
  'mcp__agim__complete_goal',
])

const OBSERVATION_TOOLS = new Set([
  'native_read_file',
  'native_list_dir',
  'native_glob',
  'native_grep',
  'native_web_fetch',
  'native_web_search',
  'mcp__agim__read_skill',
  'mcp__agim__list_skills',
  'mcp__agim__search_memos',
  'mcp__agim__memory_list',
  'mcp__agim__memory_query',
  'mcp__agim__list_reminders',
])

function isVerificationCommand(input: unknown): boolean {
  const command = typeof (input as { command?: unknown })?.command === 'string'
    ? (input as { command: string }).command.trim()
    : ''
  if (!command || /[\r\n;&|><`$()]/.test(command)) return false
  return /^(?:npm\s+(?:test|run\s+(?:test(?::[\w-]+)?|lint|typecheck|build))(?:\s+--?[\w./:=@-]+)*|bun\s+test(?:\s+[\w./:=@*-]+)*|npx\s+tsc\s+--noEmit(?:\s+-p\s+[\w./-]+)?|cargo\s+test(?:\s+[\w:=@-]+)*|go\s+test(?:\s+[\w./-]+)*|pytest(?:\s+[\w./:=@*-]+)*|git\s+diff\s+--check(?:\s+[\w./-]+)?)$/i.test(command)
}

export function classifyGoalEvidence(
  toolName: string,
  input: unknown,
  _parallelSafe: boolean,
): GoalEvidenceKind {
  if (CONTROL_TOOLS.has(toolName)) return 'control'
  if (toolName === 'native_exec' && isVerificationCommand(input)) return 'mutation_verification'
  if (OBSERVATION_TOOLS.has(toolName)) return 'observation'
  return 'mutation'
}

export function beginGoalToolOperation(input: {
  context: GoalEvidenceContext
  toolCallId: string
  toolName: string
  args: unknown
  kind: GoalEvidenceKind
}): GoalToolOperation | null {
  if (input.kind === 'control') return null
  const d = getGoalsDatabaseForLedger()
  if (!d) return null
  reconcileInterruptedGoalOperations()
  const opHash = hmac([
    input.context.goalId,
    input.context.goalVersion,
    traceRoot(input.context.traceId),
    input.toolCallId,
    input.toolName,
  ].join('|'))
  const traceHash = hmac(traceRoot(input.context.traceId))
  const toolCallHash = hmac(input.toolCallId)
  const inputHash = hmac(stableJson(input.args))
  const tx = d.transaction((): GoalToolOperation | null => {
    const goal = d.prepare(`
      SELECT id, version, mutation_epoch FROM goals
      WHERE id = ? AND version = ? AND status = 'active'
    `).get(input.context.goalId, input.context.goalVersion) as
      | { id: number; version: number; mutation_epoch: number }
      | undefined
    if (!goal) return null
    const existing = d.prepare(`
      SELECT id, goal_id, goal_version, epoch, kind, state FROM goal_ledger
      WHERE op_hash = ? AND kind = ?
    `).get(opHash, input.kind) as
      | {
          id: number
          goal_id: number
          goal_version: number
          epoch: number
          kind: GoalToolOperation['kind']
          state: string
        }
      | undefined
    if (existing) {
      throw new Error(`duplicate goal tool operation (${existing.state})`)
    }
    const info = d.prepare(`
      INSERT INTO goal_ledger (
        op_hash, goal_id, goal_version, epoch, kind, state,
        trace_hash, tool_call_hash, tool_name, input_hash, owner_id, owner_pid
      ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?)
    `).run(
      opHash,
      goal.id,
      goal.version,
      goal.mutation_epoch,
      input.kind,
      traceHash,
      toolCallHash,
      input.toolName,
      inputHash,
      PROCESS_OWNER_ID,
      process.pid,
    )
    return {
      ledgerId: Number(info.lastInsertRowid),
      goalId: goal.id,
      goalVersion: goal.version,
      epoch: goal.mutation_epoch,
      kind: input.kind as GoalToolOperation['kind'],
    }
  })
  return tx.immediate()
}

export function finishGoalToolOperation(
  operation: GoalToolOperation | null,
  result: {
    ok: boolean
    output: string
    /** True when cancellation/timeout cannot prove whether a mutation landed. */
    uncertain?: boolean
    metadata?: Record<string, unknown>
  },
): IssuedEvidence | null {
  if (!operation) return null
  const d = getGoalsDatabaseForLedger()
  if (!d) return null
  const outputHash = hmac(result.output)
  const metadata = JSON.stringify({
    outputChars: result.output.length,
    ...(result.metadata ?? {}),
  })
  const tx = d.transaction((): IssuedEvidence | null => {
    const row = d.prepare('SELECT state FROM goal_ledger WHERE id = ?').get(operation.ledgerId) as
      | { state: string }
      | undefined
    if (row?.state !== 'started') return null
    const isMutation = operation.kind === 'mutation' || operation.kind === 'mutation_verification'
    if (!result.ok) {
      if (result.uncertain && isMutation) {
        // Scope is conservatively global until per-workspace mutation scopes
        // land: a late/unknown write must invalidate every active goal that
        // could observe the same filesystem.
        d.prepare(`
          UPDATE goals SET mutation_epoch = mutation_epoch + 1, updated_at = datetime('now')
          WHERE status = 'active'
        `).run()
      }
      d.prepare(`
        UPDATE goal_ledger SET state = ?, output_hash = ?,
          metadata_json = ?, finished_at = datetime('now') WHERE id = ?
      `).run(result.uncertain ? 'unknown' : 'failed', outputHash, metadata, operation.ledgerId)
      return null
    }
    if (isMutation) {
      d.prepare(`
        UPDATE goals SET mutation_epoch = mutation_epoch + 1, updated_at = datetime('now')
        WHERE status = 'active'
      `).run()
    }
    const goal = d.prepare(`
      SELECT version, mutation_epoch, status FROM goals WHERE id = ?
    `).get(operation.goalId) as
      | { version: number; mutation_epoch: number; status: string }
      | undefined
    if (goal?.status !== 'active' || goal.version !== operation.goalVersion) {
      d.prepare(`
        UPDATE goal_ledger SET state = 'unknown', output_hash = ?,
          metadata_json = ?, finished_at = datetime('now') WHERE id = ?
      `).run(outputHash, metadata, operation.ledgerId)
      return null
    }
    const epoch = goal.mutation_epoch
    if (!isMutation) {
      const inflight = d.prepare(`
        SELECT 1 FROM goal_ledger
        WHERE kind IN ('mutation', 'mutation_verification') AND state = 'started'
        LIMIT 1
      `).get()
      if (inflight || epoch !== operation.epoch) {
        d.prepare(`
          UPDATE goal_ledger SET state = 'unknown', output_hash = ?,
            metadata_json = ?, finished_at = datetime('now') WHERE id = ?
        `).run(outputHash, metadata, operation.ledgerId)
        return null
      }
    }
    const canIssue = operation.kind === 'observation' || operation.kind === 'mutation_verification'
    const token = canIssue ? `ev1_${randomBytes(32).toString('base64url')}` : null
    d.prepare(`
      UPDATE goal_ledger SET state = 'succeeded', epoch = ?, evidence_hash = ?,
        output_hash = ?, metadata_json = ?, finished_at = datetime('now')
      WHERE id = ?
    `).run(epoch, token ? tokenHash(token) : null, outputHash, metadata, operation.ledgerId)
    if (!token) return null
    return {
      id: token,
      kind: operation.kind === 'observation' ? 'observation' : 'verification',
      epoch,
    }
  })
  return tx.immediate()
}

export interface CompleteGoalCasInput {
  platform: string
  channelId: string
  threadId: string
  goalId: number
  goalVersion: number
  evidenceIds: string[]
  recap: string
  status: Extract<GoalStatus, 'completed' | 'cancelled'>
  traceId?: string
}

export type CompleteGoalCasResult =
  | { ok: true; alreadyCompleted: boolean; title: string; version: number; mutationEpoch: number }
  | { ok: false; error: string }

export function completeGoalCas(input: CompleteGoalCasInput): CompleteGoalCasResult {
  const d = getGoalsDatabaseForLedger()
  if (!d) return { ok: false, error: 'goal evidence database unavailable' }
  reconcileInterruptedGoalOperations()
  const tx = d.transaction((): CompleteGoalCasResult => {
    const goal = d.prepare(`
      SELECT id, title, status, version, mutation_epoch, evidence_required, progress_log
      FROM goals WHERE id = ? AND platform = ? AND channel_id = ? AND thread_id = ?
    `).get(input.goalId, input.platform, input.channelId, input.threadId) as
      | {
          id: number
          title: string
          status: string
          version: number
          mutation_epoch: number
          evidence_required: number
          progress_log: string
        }
      | undefined
    if (!goal) return { ok: false, error: 'STALE_GOAL: goal token is not valid for this thread' }
    const completionOpHash = hmac(`completion|${goal.id}|${input.goalVersion}`)
    const completionRequestHash = hmac(stableJson({
      status: input.status,
      recap: input.recap,
      evidence: input.evidenceIds.map(tokenHash).sort(),
    }))
    if (
      goal.status === input.status
      && goal.version === input.goalVersion + 1
    ) {
      const prior = d.prepare(`
        SELECT 1 FROM goal_ledger
        WHERE op_hash = ? AND kind = 'completion' AND state = 'succeeded' AND input_hash = ?
      `).get(completionOpHash, completionRequestHash)
      if (!prior) {
        return { ok: false, error: 'STALE_GOAL: completion payload differs from the committed request' }
      }
      return {
        ok: true,
        alreadyCompleted: true,
        title: goal.title,
        version: goal.version,
        mutationEpoch: goal.mutation_epoch,
      }
    }
    if (goal.status !== 'active' || goal.version !== input.goalVersion) {
      return { ok: false, error: 'STALE_GOAL: goal version is no longer current; nothing changed' }
    }
    const inflight = d.prepare(`
      SELECT 1 FROM goal_ledger
      WHERE kind IN ('mutation', 'mutation_verification') AND state = 'started'
      LIMIT 1
    `).get()
    if (inflight) return { ok: false, error: 'GOAL_BUSY: a mutating operation is still in flight' }

    if (input.status === 'completed' && goal.evidence_required === 1) {
      if (input.evidenceIds.length === 0) {
        return { ok: false, error: 'EVIDENCE_REQUIRED: provide current server-issued evidenceIds' }
      }
      const expectedTrace = hmac(traceRoot(input.traceId))
      let hasVerification = false
      const observationTools = new Set<string>()
      for (const token of input.evidenceIds) {
        if (!/^ev1_[A-Za-z0-9_-]{40,}$/.test(token)) {
          return { ok: false, error: 'INVALID_EVIDENCE: malformed evidence capability' }
        }
        const evidence = d.prepare(`
          SELECT kind, state, trace_hash, tool_name FROM goal_ledger
          WHERE evidence_hash = ? AND goal_id = ? AND goal_version = ? AND epoch = ?
        `).get(tokenHash(token), goal.id, goal.version, goal.mutation_epoch) as
          | { kind: string; state: string; trace_hash: string; tool_name: string }
          | undefined
        if (
          evidence?.state !== 'succeeded'
          || (evidence.kind !== 'observation' && evidence.kind !== 'mutation_verification')
          || evidence.trace_hash !== expectedTrace
        ) {
          return { ok: false, error: 'INVALID_EVIDENCE: stale, foreign, or untrusted evidence' }
        }
        if (evidence.kind === 'mutation_verification') hasVerification = true
        else observationTools.add(evidence.tool_name)
      }
      if (goal.mutation_epoch > 0 && !hasVerification) {
        return { ok: false, error: 'VERIFICATION_REQUIRED: current mutation epoch needs verifier evidence' }
      }
      if (goal.mutation_epoch === 0 && !hasVerification && observationTools.size < 2) {
        return { ok: false, error: 'EVIDENCE_INSUFFICIENT: provide two distinct observations or one verification' }
      }
    }

    let progress: ProgressNote[] = []
    try {
      const parsed = JSON.parse(goal.progress_log || '[]') as unknown
      if (Array.isArray(parsed)) progress = parsed as ProgressNote[]
    } catch { /* keep empty */ }
    progress.push({
      ts: new Date().toISOString(),
      by: 'agent',
      text: `[${input.status}] ${input.recap}`,
    })
    const updated = d.prepare(`
      UPDATE goals SET status = ?, version = version + 1, progress_log = ?,
        updated_at = datetime('now'), closed_at = datetime('now')
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(input.status, JSON.stringify(progress), goal.id, goal.version)
    if (updated.changes !== 1) {
      return { ok: false, error: 'STALE_GOAL: completion CAS lost; nothing changed' }
    }
    d.prepare(`
      INSERT INTO goal_ledger (
        op_hash, goal_id, goal_version, epoch, kind, state,
        trace_hash, tool_name, input_hash, output_hash, metadata_json, finished_at
      ) VALUES (?, ?, ?, ?, 'completion', 'succeeded', ?, 'complete_goal', ?, ?, '{}', datetime('now'))
    `).run(
      completionOpHash,
      goal.id,
      goal.version,
      goal.mutation_epoch,
      hmac(traceRoot(input.traceId)),
      completionRequestHash,
      hmac(input.recap),
    )
    return {
      ok: true,
      alreadyCompleted: false,
      title: goal.title,
      version: goal.version + 1,
      mutationEpoch: goal.mutation_epoch,
    }
  })
  return tx.immediate()
}

export function __resetGoalEvidenceKeyForTesting(): void {
  cachedKey = null
  reconciledOwners = false
}
