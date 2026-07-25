#!/usr/bin/env node
/**
 * Offline simulation of Loop dispatch / verify / exit gates (no browser).
 * Uses compiled dist modules + temp AGIM_LOOPS_DIR.
 *
 * Exit 0 when all cases pass; prints JSON report to stdout and
 * /opt/cursor/artifacts/loop-gates-sim-report.json
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'loop-gates-sim-'))
process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
mkdirSync(process.env.AGIM_LOOPS_DIR, { recursive: true, mode: 0o700 })

const loopRun = await import(pathToFileURL(join(process.cwd(), 'dist/core/loop-run.js')).href)
const dispatchGate = await import(pathToFileURL(join(process.cwd(), 'dist/core/loop-dispatch-gate.js')).href)
const verifyGate = await import(pathToFileURL(join(process.cwd(), 'dist/core/loop-verify-gate.js')).href)

const {
  startLoop,
  noteLoopDispatch,
  getActiveLoop,
  getLoopRun,
  maybeEnforceLoopExit,
  forceLoopExitSkippedVerify,
  toLoopStatusDto,
  _touchLoopCreatedAtForTests,
} = loopRun
const { evaluateLoopDispatchGate } = dispatchGate
const { loopNeedsVerdict } = verifyGate

const cases = []
function record(name, ok, detail) {
  cases.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const platform = 'web'
const channelId = 'sim'

// --- Case 1: dispatch gate blocks web_fetch before first spawn ---
{
  const threadId = 'dispatch-gate'
  const started = startLoop({
    platform, channelId, threadId, userId: 'sim',
    text: '修好登录；退出条件为验收通过或最多3轮',
  })
  if (!started.ok) {
    record('dispatch-gate.start', false, started.error)
  } else {
    const blocked = evaluateLoopDispatchGate(platform, channelId, threadId, 'agim_web_fetch')
    const allowed = evaluateLoopDispatchGate(platform, channelId, threadId, 'mcp__agim__call_agents')
    record(
      'dispatch-gate.blocks-self-research',
      blocked.ok === false && allowed.ok === true,
      `web_fetch ok=${blocked.ok}; call_agents ok=${allowed.ok}`,
    )
    noteLoopDispatch(platform, channelId, threadId, {
      tasks: [{ id: '1', brief: 'spawn', agentHint: 'agim/cheap' }],
    })
    const after = evaluateLoopDispatchGate(platform, channelId, threadId, 'agim_web_fetch')
    record('dispatch-gate.allows-after-dispatch', after.ok === true, `ok=${after.ok}`)
  }
}

// --- Case 2: after dispatch, verify needed ---
{
  const threadId = 'verify-needed'
  const started = startLoop({
    platform, channelId, threadId, userId: 'sim',
    text: '分析箱体；退出条件为找到箱体或最多3轮',
  })
  if (!started.ok) {
    record('verify-needed.start', false, started.error)
  } else {
    record('verify-needed.before-dispatch', loopNeedsVerdict(platform, channelId, threadId) === false, '')
    noteLoopDispatch(platform, channelId, threadId, {
      count: 3,
      tasks: [{ id: '1', brief: 'a' }, { id: '2', brief: 'b' }, { id: '3', brief: 'c' }],
    })
    const needs = loopNeedsVerdict(platform, channelId, threadId)
    const dto = toLoopStatusDto(getActiveLoop(platform, channelId, threadId))
    record(
      'verify-needed.after-dispatch',
      needs === true && dto.bucket === 'verify' && dto.dispatchesThisRound === 3,
      `needs=${needs} bucket=${dto.bucket} dispatches=${dto.dispatchesThisRound}`,
    )
  }
}

// --- Case 3: skip verify → force verify_skipped ---
{
  const threadId = 'verify-skipped'
  const started = startLoop({
    platform, channelId, threadId, userId: 'sim',
    text: '任务；退出条件为验收通过或最多3轮',
  })
  noteLoopDispatch(platform, channelId, threadId, { count: 2 })
  const forced = forceLoopExitSkippedVerify(platform, channelId, threadId)
  const active = getActiveLoop(platform, channelId, threadId)
  const stored = getLoopRun(platform, channelId, threadId)
  record(
    'exit.verify-skipped',
    forced.ended === true
      && forced.reason === 'verify_skipped'
      && active === null
      && stored?.status === 'ended'
      && stored?.endReason === 'verify_skipped',
    `reason=${forced.reason} status=${stored?.status}`,
  )
}

// --- Case 4: wall clock enforce without verdict ---
{
  const threadId = 'wall-exit'
  const started = startLoop({
    platform, channelId, threadId, userId: 'sim',
    text: '任务；退出条件为验收通过或超过1小时',
  })
  if (!started.ok) {
    record('exit.wall.start', false, started.error)
  } else {
    // Backdate createdAt beyond maxWallMs (1h from parse)
    if (typeof _touchLoopCreatedAtForTests === 'function') {
      _touchLoopCreatedAtForTests(platform, channelId, threadId, Date.now() - 2 * 3_600_000)
    } else {
      // Fallback: rewrite json
      const run = getLoopRun(platform, channelId, threadId)
      run.createdAt = Date.now() - 2 * 3_600_000
      run.mission.exit.maxWallMs = 3_600_000
      writeFileSync(
        join(process.env.AGIM_LOOPS_DIR, `${platform}__${channelId}__${threadId}.json`),
        JSON.stringify(run, null, 2),
      )
    }
    const enforced = maybeEnforceLoopExit(platform, channelId, threadId)
    const stored = getLoopRun(platform, channelId, threadId)
    record(
      'exit.wall-without-verdict',
      enforced.ended === true
        && enforced.reason === 'wall_limit'
        && stored?.endReason === 'wall_limit',
      `reason=${enforced.reason}`,
    )
  }
}

// --- Case 5: maxRounds parse 重复3轮 ---
{
  const p = loopRun.parseExitConstraints('找到合理箱体或重复3轮结束')
  record(
    'parse.重复3轮',
    p.maxRounds === 6 && p.minRounds === 3,
    `maxRounds=${p.maxRounds} minRounds=${p.minRounds}`,
  )
  const minP = loopRun.parseExitConstraints('验收通过或至少 3 轮')
  record(
    'parse.至少3轮',
    minP.minRounds === 3 && minP.maxRounds === undefined,
    `minRounds=${minP.minRounds} maxRounds=${minP.maxRounds}`,
  )
}

const passed = cases.filter((c) => c.ok).length
const failed = cases.filter((c) => !c.ok).length
const report = {
  at: new Date().toISOString(),
  passed,
  failed,
  cases,
}
const outPath = '/opt/cursor/artifacts/loop-gates-sim-report.json'
try {
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))
} catch (err) {
  console.error('write report failed', err)
}
console.log(`\n${passed} passed, ${failed} failed → ${outPath}`)

try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(failed > 0 ? 1 : 0)
