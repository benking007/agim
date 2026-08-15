import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFocus, getFocusOn } from './focus.js'
import { _truncateForTests } from './goals.js'
import {
  createInlineJob,
  getJob,
  jobThreadKey,
  markJobCompleted,
  markJobRunning,
} from './job-board.js'
import {
  applyLoopVerdict,
  buildLoopSnippet,
  cancelLoopForFocusOff,
  confirmLoopMission,
  countRoundLiveSubagents,
  forceLoopExitSkippedVerify,
  formatLoopStatus,
  getActiveLoop,
  getLoopRun,
  getLoopRunById,
  getMissionView,
  isLoopWallExceeded,
  listLoopRuns,
  noteLoopDispatch,
  noteLoopRoundJob,
  notifyLoopJobTerminal,
  countLoopChildJobs,
  parseExitConstraints,
  parseLoopStartText,
  maybeResolveLoopConfirmTimeout,
  resolveLoopMetConfirm,
  setLoopAcceptance,
  setLoopBody,
  setLoopExit,
  setLoopObjective,
  startLoop,
  stopLoop,
  discoverLoopReportPaths,
  noteLoopReportPath,
  onLoopRunWritten,
  readLoopReportMarkdown,
  resolveLoopReportsDir,
  toLoopStatusDto,
  _historyPathForTests,
  _touchLoopCreatedAtForTests,
} from './loop-run.js'

const TMP = mkdtempSync(join(tmpdir(), 'agim-loop-'))
process.env.AGIM_LOOPS_DIR = join(TMP, 'loops')

const base = { platform: 'wechat', channelId: 'rest', userId: 'u1' }

function reset(): void {
  try { _truncateForTests() } catch { /* ignore */ }
}

function hasSqliteRow<T>(row: T | null): row is T {
  if (row !== null) return true
  if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') {
    throw new Error('SQLite is required by the Node persistence suite')
  }
  return false
}

describe('parseLoopStartText', () => {
  it('splits objective and exit', () => {
    const p = parseLoopStartText('修好登录超时；退出：验收通过或最多5轮')
    expect(p.objective).toBe('修好登录超时')
    expect(p.exitDescription).toContain('验收通过')
    expect(p.maxRounds).toBe(5)
  })

  it('accepts 退出条件为 / 退出条件是 (natural language)', () => {
    const a = parseLoopStartText('修好登录超时；退出条件为验收通过或最多5轮')
    expect(a.objective).toBe('修好登录超时')
    expect(a.exitDescription).toBe('验收通过或最多5轮')
    expect(a.maxRounds).toBe(5)

    const b = parseLoopStartText('发版前压掉 flaky，退出条件是主分支绿')
    expect(b.objective).toBe('发版前压掉 flaky')
    expect(b.exitDescription).toBe('主分支绿')

    const c = parseLoopStartText('修好登录 退出条件为验收通过')
    expect(c.objective).toBe('修好登录')
    expect(c.exitDescription).toBe('验收通过')
  })

  it('strips labels', () => {
    const p = parseLoopStartText('目标：发版；退出：CI 绿')
    expect(p.objective).toBe('发版')
    expect(p.exitDescription).toBe('CI 绿')
  })

  it('parses optional body after exit', () => {
    const p = parseLoopStartText(
      '修好登录超时；退出条件为验收通过或最多3轮；正文：优先查超时日志，不要改鉴权',
    )
    expect(p.objective).toBe('修好登录超时')
    expect(p.exitDescription).toContain('验收通过')
    expect(p.body).toBe('优先查超时日志，不要改鉴权')
  })

  it('parses body with body: label', () => {
    const p = parseLoopStartText('Fix auth; exit: PR green; body: check nginx first')
    expect(p.objective).toMatch(/Fix auth/i)
    expect(p.body).toMatch(/nginx/i)
  })

  it('parses acceptance + wall clock from NL', () => {
    const p = parseLoopStartText('修好登录；验收：补回归；退出条件为验收通过或最多3轮或超过2小时')
    expect(p.objective).toBe('修好登录')
    expect(p.acceptance).toBe('补回归')
    expect(p.exitDescription).toContain('验收通过')
    expect(p.maxRounds).toBe(3)
    expect(p.maxWallMs).toBe(2 * 3_600_000)
  })

  it('parseExitConstraints minutes', () => {
    const c = parseExitConstraints('卡住就停，超过 45 分钟')
    expect(c.maxWallMs).toBe(45 * 60_000)
  })

  it('parseExitConstraints accepts 重复N轮 / N轮结束', () => {
    const repeat = parseExitConstraints('找到合理箱体或重复3轮结束')
    expect(repeat.minRounds).toBe(3)
    expect(repeat.maxRounds).toBe(6) // min=N, max=N*2
    expect(parseExitConstraints('验收通过或 5 轮结束').maxRounds).toBe(5)
    expect(parseExitConstraints('验收通过或 5 轮结束').minRounds).toBeUndefined()
    const ceiling = parseExitConstraints('分析 100 轮结束')
    expect(ceiling.minRounds).toBeUndefined()
    expect(ceiling.maxRounds).toBe(100)
    expect(parseExitConstraints('100轮结束').minRounds).toBeUndefined()
    expect(parseExitConstraints('100轮结束').maxRounds).toBe(100)
  })

  it('parseExitConstraints accepts 至少/最少/不少于 N 轮 as minRounds', () => {
    expect(parseExitConstraints('验收通过或至少 3 轮').minRounds).toBe(3)
    expect(parseExitConstraints('验收通过或至少 3 轮').maxRounds).toBeUndefined()
    expect(parseExitConstraints('最少5轮或超过2小时').minRounds).toBe(5)
    expect(parseExitConstraints('不少于 2 轮，最多 6 轮').minRounds).toBe(2)
    expect(parseExitConstraints('不少于 2 轮，最多 6 轮').maxRounds).toBe(6)
    expect(parseExitConstraints('做满 4 轮').minRounds).toBe(4)
    expect(parseExitConstraints('做满 4 轮').maxRounds).toBe(4)
  })
})

describe('loop-run R2 Mission persist', () => {
  it('partial mission while aligning survives disk reload; status shows both hard fields', () => {
    reset()
    const threadId = 'loop-r2-partial'
    const focus = setFocus({ ...base, threadId, title: 'Ship v2' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.run.status).toBe('aligning')
    expect(started.run.sessionKey).toContain('loop-r2-partial')
    // Focus seeds body (labeled), not objective.
    expect(started.run.mission?.objective || '').toBe('')
    expect(started.run.mission?.body).toContain('当前 Agent 聚焦内容')
    expect(started.run.mission?.body).toContain('Ship v2')

    setLoopObjective(base.platform, base.channelId, threadId, 'Ship v2 release')
    setLoopExit(base.platform, base.channelId, threadId, 'CI 绿，最多 4 轮')
    const reloaded = getLoopRun(base.platform, base.channelId, threadId)
    expect(reloaded).toBeTruthy()
    if (!reloaded) return
    const view = getMissionView(reloaded)
    expect(view.objective).toContain('Ship v2 release')
    expect(view.body).toContain('Ship v2')
    expect(view.exitDescription).toContain('CI 绿')
    expect(view.maxRounds).toBe(4)
    expect(view.confirmed).toBe(false)

    const status = formatLoopStatus(reloaded)
    expect(status).toContain('Ship v2 release')
    expect(status).toContain('CI 绿')
    expect(status).toContain('**目标**')
    expect(status).toContain('**退出条件**')
    expect(status).toContain('**正文**')
  })

  it('confirmed mission + body round-trips into status/snippet', () => {
    reset()
    const threadId = 'loop-r2-body'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好超时；退出条件为最多3轮；正文：优先查 nginx 超时日志',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.aligned).toBe(true)
    expect(started.run.mission?.body).toContain('nginx')
    const reloaded = getLoopRun(base.platform, base.channelId, threadId)
    expect(reloaded?.mission?.body).toContain('nginx')
    expect(formatLoopStatus(reloaded!)).toContain('nginx')
    expect(buildLoopSnippet(base.platform, base.channelId, threadId)).toContain('nginx')
  })

  it('confirmed mission + acceptance round-trips; status readable after reload', () => {
    reset()
    const threadId = 'loop-r2-confirm'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好超时；验收：有单测；退出条件为验收通过或最多3轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.aligned).toBe(true)
    expect(started.run.mission?.acceptance).toBe('有单测')
    expect(started.run.mission?.exit.maxRounds).toBe(3)

    setLoopAcceptance(base.platform, base.channelId, threadId, '单测 + 手工点一次登录')
    const reloaded = getLoopRun(base.platform, base.channelId, threadId)
    expect(reloaded?.status).toBe('planning')
    const status = formatLoopStatus(reloaded!)
    expect(status).toContain('修好超时')
    expect(status).toContain('验收通过')
    expect(status).toContain('单测 + 手工点一次登录')
    expect(getMissionView(reloaded!).confirmed).toBe(true)
  })
})

describe('loop-run R1 ALIGNING', () => {
  it('path A without exit stays aligning', () => {
    reset()
    const threadId = 'loop-a-align'
    const focus = setFocus({ ...base, threadId, title: 'Keep me', body: 'detail line' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId, text: 'note' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.path).toBe('A')
    expect(started.aligned).toBe(false)
    expect(started.run.status).toBe('aligning')
    // Focus must not fill objective; it lands in labeled body.
    // Bare start text DOES prefill objective (Aligning dock) as start note.
    expect(started.run.draftObjective || '').toBe('note')
    expect(started.run.mission?.objective || '').toBe('note')
    expect(started.run.mission?.body).toContain('当前 Agent 聚焦内容')
    expect(started.run.mission?.body).toContain('Keep me')
    expect(started.run.mission?.body).toContain('detail line')
    expect(started.run.startNote).toBe('note')
    const snippet = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snippet).toContain('ALIGNING')
    expect(snippet).toContain('do NOT call')
    expect(snippet).toContain('Objective: note')
    // Aligning snippet lists objective/exit only; Focus brief stays on mission.body
    // for the Portal dock / status (not duplicated into the hard-gate snippet).

    // verdict blocked while aligning
    const blocked = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'nope',
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toBe('aligning')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Keep me')
  })

  it('path A with explicit objective keeps Focus in body only', () => {
    reset()
    const threadId = 'loop-a-focus-body'
    const focus = setFocus({ ...base, threadId, title: 'Old focus title' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({
      ...base,
      threadId,
      text: '新目标：修好超时；退出条件为最多3轮；正文：优先查日志',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.path).toBe('A')
    expect(started.aligned).toBe(true)
    expect(started.run.mission?.objective).toContain('修好超时')
    expect(started.run.mission?.objective).not.toContain('Old focus')
    expect(started.run.mission?.body).toContain('优先查日志')
    expect(started.run.mission?.body).toContain('当前 Agent 聚焦内容')
    expect(started.run.mission?.body).toContain('Old focus title')
  })

  it('path B without exit stays aligning; end focus off', () => {
    reset()
    const threadId = 'loop-b-align'
    const started = startLoop({ ...base, threadId, text: 'Build loop' })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.path).toBe('B')
    expect(started.aligned).toBe(false)
    expect(started.run.status).toBe('aligning')
    expect(getFocusOn(base.platform, base.channelId, threadId)?.title).toBe('Build loop')

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getFocusOn(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('both hard inputs → planning (skip aligning)', () => {
    reset()
    const threadId = 'loop-aligned'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好超时；退出：验收通过或最多3轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.aligned).toBe(true)
    expect(started.run.status).toBe('planning')
    expect(started.run.mission?.objective).toContain('修好超时')
    expect(started.run.mission?.exit.description).toContain('验收通过')
    expect(started.run.maxRounds).toBe(3)
    const snip = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snip).not.toContain('ALIGNING')
    expect(snip).toContain('MUST decompose')
    expect(snip).toContain('call_agents')
    expect(snip).toContain('HARD GATE')

    const withWorker = buildLoopSnippet(base.platform, base.channelId, threadId, {
      preferredWorkerAgent: 'codex',
    })
    expect(withWorker).toContain('Preferred worker agent: "codex"')
    expect(withWorker).toContain('agent:"codex"')
  })

  it('objective + exit + confirm leaves aligning', () => {
    reset()
    const threadId = 'loop-confirm'
    const focus = setFocus({ ...base, threadId, title: 'Ship it' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.run.status).toBe('aligning')

    const o = setLoopObjective(base.platform, base.channelId, threadId, 'Ship v2')
    expect(o.ok).toBe(true)
    const e = setLoopExit(base.platform, base.channelId, threadId, 'CI 绿，最多 4 轮')
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.run.maxRounds).toBe(4)

    const incomplete = confirmLoopMission(base.platform, base.channelId, threadId)
    // both drafts set → should confirm
    expect(incomplete.ok).toBe(true)
    if (!incomplete.ok) return
    expect(incomplete.run.status).toBe('planning')
    expect(incomplete.run.mission?.objective).toBe('Ship v2')
    expect(incomplete.run.round).toBe(1)

    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'done',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('stop_verdict')
  })

  it('path B without text refuses', () => {
    reset()
    const r = startLoop({ ...base, threadId: 'loop-need-text', text: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('need_text')
  })

  it('focus off cancels active loop (even aligning)', () => {
    reset()
    const threadId = 'loop-focus-off'
    const focus = setFocus({ ...base, threadId, title: 'X' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({ ...base, threadId })
    expect(started.ok).toBe(true)
    cancelLoopForFocusOff(base.platform, base.channelId, threadId)
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()
  })

  it('focus off cancels in-flight Subagent jobs (like /loop stop)', () => {
    reset()
    const threadId = 'loop-focus-off-jobs'
    const focus = setFocus({ ...base, threadId, title: 'X' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出：验收通过或最多3轮',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const tk = jobThreadKey(base.platform, base.channelId, threadId)
    const jobId = createInlineJob({
      agent: 'agim',
      prompt: 'child work',
      threadKey: tk,
      callDepth: 1,
    })
    if (jobId <= 0) return
    noteLoopRoundJob(base.platform, base.channelId, threadId, jobId)
    expect(getJob(jobId)?.status).toMatch(/pending|running/)
    cancelLoopForFocusOff(base.platform, base.channelId, threadId)
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()
    expect(getJob(jobId)?.status).toBe('cancelled')
  })

  it('countRoundLiveSubagents is 0 when round ids empty and no dispatch', () => {
    reset()
    const threadId = 'loop-live-empty-round'
    const focus = setFocus({ ...base, threadId, title: '上下文' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出：验收通过或最多3轮',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    // Unrelated live children on the thread must not block a fresh round.
    const tk = jobThreadKey(base.platform, base.channelId, threadId)
    const stray = createInlineJob({
      agent: 'agim',
      prompt: 'stray',
      threadKey: tk,
      callDepth: 1,
    })
    expect(countRoundLiveSubagents(started.run)).toBe(0)
    void stray
  })

  it('countRoundLiveSubagents stays 0 when dispatched but round ids empty (no stray fallback)', () => {
    reset()
    const threadId = 'loop-live-dispatch-no-ids'
    const focus = setFocus({ ...base, threadId, title: '上下文' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出：验收通过或最多3轮',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 1,
      tasks: [{ id: '1', brief: 'stray-not-round', agentHint: 'agim' }],
    })
    const liveRun = getActiveLoop(base.platform, base.channelId, threadId)
    expect(liveRun).toBeTruthy()
    if (!liveRun) return
    expect(liveRun.dispatchesThisRound).toBeGreaterThanOrEqual(1)
    expect(liveRun.roundJobIds ?? []).toEqual([])
    const tk = jobThreadKey(base.platform, base.channelId, threadId)
    const stray = createInlineJob({
      agent: 'agim',
      prompt: 'unrelated leftover',
      threadKey: tk,
      callDepth: 1,
    })
    expect(countRoundLiveSubagents(liveRun)).toBe(0)
    expect(toLoopStatusDto(liveRun).canVerify).toBe(true)
    void stray
  })

  it('notifyLoopJobTerminal writeRuns so docks leave 待派工 after Codex finishes', () => {
    reset()
    const threadId = 'loop-job-terminal-resync'
    const focus = setFocus({ ...base, threadId, title: '上下文' })
    if (!hasSqliteRow(focus)) return
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出：验收通过或最多3轮',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 1,
      tasks: [{ id: '1', brief: 'fix login', agentHint: 'codex' }],
    })
    const tk = jobThreadKey(base.platform, base.channelId, threadId)
    const jobId = createInlineJob({
      agent: 'codex',
      prompt: 'fix login',
      threadKey: tk,
      callDepth: 1,
    })
    if (jobId <= 0) return
    noteLoopRoundJob(base.platform, base.channelId, threadId, jobId)
    expect(markJobRunning(jobId)).toBe(true)
    const liveRun = getActiveLoop(base.platform, base.channelId, threadId)
    expect(liveRun).toBeTruthy()
    if (!liveRun) return
    expect(countRoundLiveSubagents(liveRun)).toBe(1)
    expect(toLoopStatusDto(liveRun).canVerify).toBe(false)

    let writes = 0
    const off = onLoopRunWritten((run) => {
      if (run.threadId === threadId) writes += 1
    })
    markJobCompleted(jobId, 'login fixed')
    notifyLoopJobTerminal(base.platform, base.channelId, threadId, jobId, {
      outcome: 'completed',
      agent: 'codex',
    })
    off()

    expect(writes).toBeGreaterThan(0)
    const after = getActiveLoop(base.platform, base.channelId, threadId)
    expect(after).toBeTruthy()
    if (!after) return
    expect(countRoundLiveSubagents(after)).toBe(0)
    const dto = toLoopStatusDto(after)
    expect(dto.bucket).toBe('verify')
    expect(dto.canVerify).toBe(true)
    expect(dto.liveSubagents).toBe(0)
    expect(after.timeline.some((t) => t.kind === 'subagent_terminal')).toBe(true)
  })

  it('loop_verdict stop ends confirmed loop (path B focus off)', () => {
    reset()
    const threadId = 'loop-verdict'
    const started = startLoop({
      ...base,
      threadId,
      text: 'Mission；退出：验收通过',
    })
    if (!started.ok) return
    expect(started.run.status).toBe('planning')
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'good enough',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('stop_verdict')
    expect(getFocusOn(base.platform, base.channelId, threadId)).toBeNull()
  })
})

describe('loop-run R3 PLAN+DISPATCH', () => {
  it('continue/revise without dispatch is refused; stop still works', () => {
    reset()
    const threadId = 'loop-r3-gate'
    const started = startLoop({
      ...base,
      threadId,
      text: '拆解任务；退出条件为验收通过或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.status).toBe('planning')
    expect(started.run.dispatchesThisRound).toBe(0)

    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'skip dispatch',
    })
    expect(cont.ok).toBe(false)
    if (!cont.ok) expect(cont.error).toBe('no_dispatch')
    expect(getActiveLoop(base.platform, base.channelId, threadId)?.round).toBe(1)

    const rev = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'revise',
      summary: 'still no dispatch',
    })
    expect(rev.ok).toBe(false)

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'abandon',
    })
    expect(stop.ok).toBe(true)
  })

  it('dispatch then continue advances round and resets counter', () => {
    reset()
    const threadId = 'loop-r3-advance'
    const started = startLoop({
      ...base,
      threadId,
      text: '并行调研；退出条件为有结论或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }

    const noted = noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 2,
      tasks: [
        { id: '1', brief: '查日志', agentHint: 'agim/cheap' },
        { id: '2', brief: '写复现', agentHint: 'claude-code' },
      ],
    })
    expect(noted?.status).toBe('dispatching')
    expect(noted?.dispatchesThisRound).toBe(2)
    expect(noted?.lastPlan?.tasks.length).toBe(2)

    const status = formatLoopStatus(noted!)
    expect(status).toContain('本轮派工：2')
    expect(status).toContain('查日志')

    const snip = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snip).toContain('VERIFY (R4)')
    expect(snip).toContain('parent verifier')
    expect(snip).toContain('确认结束')
    expect(snip).toContain('HARD GATE')
    expect(snip).not.toContain('MUST decompose')

    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'need another pass',
      met: false,
      gaps: ['flaky still red'],
      nextDirection: 'focus on flaky test',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.round).toBe(2)
    expect(cont.run.dispatchesThisRound).toBe(0)
    expect(cont.run.status).toBe('planning')
    expect(cont.run.lastVerification?.met).toBe(false)
    expect(cont.run.lastVerification?.nextDirection).toContain('flaky')
  })

  it('loopJobIds accumulate across rounds (for detail report scope)', () => {
    reset()
    const threadId = `t-loop-jobs-${Date.now()}`
    const started = startLoop({
      ...base,
      threadId,
      text: '累计子代理；退出条件为有结论或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 2 })
    noteLoopRoundJob(base.platform, base.channelId, threadId, 101)
    noteLoopRoundJob(base.platform, base.channelId, threadId, 102)
    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'next round',
      met: false,
      nextDirection: 'more research',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.roundJobIds).toEqual([])
    expect(cont.run.loopJobIds).toEqual([101, 102])
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    noteLoopRoundJob(base.platform, base.channelId, threadId, 103)
    const again = getLoopRun(base.platform, base.channelId, threadId)
    expect(again?.roundJobIds).toEqual([103])
    expect(again?.loopJobIds).toEqual([101, 102, 103])
    expect(countLoopChildJobs(base.platform, base.channelId, threadId)).toBe(3)
  })
})

describe('loop-run R4 VERIFY+REFLECT', () => {
  it('continue without met/nextDirection is refused', () => {
    reset()
    const threadId = 'loop-r4-need-verify'
    const started = startLoop({
      ...base,
      threadId,
      text: '验收闭环；退出条件为达标或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })

    const noMet = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'tried',
    })
    expect(noMet.ok).toBe(false)
    if (!noMet.ok) expect(noMet.error).toBe('need_verification')

    const noDir = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'still gaps',
      met: false,
    })
    expect(noDir.ok).toBe(false)
    if (!noDir.ok) expect(noDir.error).toBe('need_next_direction')

    const metContinue = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'looks done',
      met: true,
    })
    expect(metContinue.ok).toBe(false)
    if (!metContinue.ok) expect(metContinue.error).toBe('met_use_stop')
  })

  it('stop with met=true waits for user confirm; end/continue resolve', () => {
    reset()
    const threadId = 'loop-r4-met'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出条件为验收通过或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, {
      count: 1,
      tasks: [{ id: '1', brief: 'fix timeout', agentHint: 'agim' }],
    })

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'regression green; login ok',
      met: true,
    })
    expect(stop.ok).toBe(true)
    if (!stop.ok) return
    expect(stop.run.status).toBe('pending_user_confirm')
    expect(stop.run.lastVerification?.met).toBe(true)
    expect(formatLoopStatus(stop.run)).toContain('待用户确认结案')

    const snippet = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snippet).toMatch(/PENDING_USER_CONFIRM|NOT ended/i)
    expect(snippet).toMatch(/do NOT dump the full conclusion|核心结论/i)

    const ended = resolveLoopMetConfirm(base.platform, base.channelId, threadId, {
      action: 'end',
      supplement: '同意结案',
    })
    expect(ended.ok).toBe(true)
    if (!ended.ok) return
    expect(ended.run.status).toBe('ended')
    expect(ended.run.endReason).toBe('objective_met')
    expect(formatLoopStatus(ended.run)).toContain('达标结束')
  })

  it('user confirm continue advances to next planning round', () => {
    reset()
    const threadId = 'loop-r4-met-continue'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出条件为验收通过或最多5轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'looks done',
      met: true,
    })
    expect(stop.ok).toBe(true)
    if (!stop.ok) return
    expect(stop.run.status).toBe('pending_user_confirm')

    const cont = resolveLoopMetConfirm(base.platform, base.channelId, threadId, {
      action: 'continue',
      supplement: '再补一轮回归',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.status).toBe('planning')
    expect(cont.run.round).toBe(2)
    expect(cont.run.dispatchesThisRound).toBe(0)
    expect(cont.run.lastVerification?.nextDirection).toContain('再补一轮回归')
  })

  it('minRounds hard floor refuses met=true stop before floor', () => {
    reset()
    const threadId = 'loop-min-rounds'
    const started = startLoop({
      ...base,
      threadId,
      text: '深度研究；退出条件为验收通过或至少 3 轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.mission?.exit.minRounds).toBe(3)
    expect(started.run.round).toBe(1)
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })

    const early = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'already looks good',
      met: true,
    })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.error).toBe('need_more_rounds')
    expect(getActiveLoop(base.platform, base.channelId, threadId)).not.toBeNull()

    // Abandon stop (met=false) still allowed before floor.
    const abandon = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'user cancelled direction',
      met: false,
    })
    expect(abandon.ok).toBe(true)
    if (!abandon.ok) return
    expect(abandon.run.endReason).toBe('stop_verdict')
  })

  it('round-1 met=true opens the confirm dock regardless of maxRounds ceiling', () => {
    reset()
    const threadId = 'loop-ceiling-confirm-dock'
    const started = startLoop({
      ...base,
      threadId,
      text: '分析黄金；退出条件为验收通过或最多100轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.mission?.exit.minRounds).toBeUndefined()
    expect(started.run.mission?.exit.maxRounds).toBe(100)
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: '第一轮已形成可交付结论，建议结束并落报告',
      met: true,
    })
    expect(stop.ok).toBe(true)
    if (!stop.ok) return
    expect(stop.run.status).toBe('pending_user_confirm')
    expect(getActiveLoop(base.platform, base.channelId, threadId)?.status).toBe('pending_user_confirm')
    const snip = buildLoopSnippet(base.platform, base.channelId, threadId)
    expect(snip).toContain('PENDING_USER_CONFIRM')
    expect(snip).toContain('确认结束')
  })

  it('revives a premature verify_skipped reap so loop_verdict can continue', () => {
    reset()
    const threadId = 'loop-revive-verify-skip'
    const started = startLoop({
      ...base,
      threadId,
      text: '分析黄金；退出条件为验收通过或最多100轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.mission?.exit.maxRounds).toBe(100)
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const forced = forceLoopExitSkippedVerify(base.platform, base.channelId, threadId, {
      ignoreRemainingRounds: true,
    })
    expect(forced.ended).toBe(true)
    expect(getActiveLoop(base.platform, base.channelId, threadId)).toBeNull()

    const cont = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: '第一轮已汇总，继续第二轮',
      met: false,
      nextDirection: '补齐缺口后再验收',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.status).toBe('planning')
    expect(cont.run.round).toBe(2)
    expect(getActiveLoop(base.platform, base.channelId, threadId)?.round).toBe(2)
  })

  it('getActiveLoop / loop_verdict resolve web channel aliases (web / default / empty)', () => {
    reset()
    const threadId = 'loop-channel-alias'
    const started = startLoop({
      platform: 'web',
      channelId: 'web',
      userId: 'u1',
      threadId,
      text: '分析黄金；退出条件为验收通过或最多100轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(getActiveLoop('web', 'web', threadId)?.id).toBe(started.run.id)
    expect(getActiveLoop('web', 'default', threadId)?.id).toBe(started.run.id)
    expect(getActiveLoop('web', '', threadId)?.id).toBe(started.run.id)
    expect(buildLoopSnippet('web', 'default', threadId)).toContain('loop ACTIVE')

    noteLoopDispatch('web', 'default', threadId, { count: 1 })
    const cont = applyLoopVerdict('web', 'default', threadId, {
      decision: 'continue',
      summary: '第一轮已汇总，继续第二轮',
      met: false,
      nextDirection: '补齐缺口后再验收',
    })
    expect(cont.ok).toBe(true)
    if (!cont.ok) return
    expect(cont.run.round).toBe(2)
    expect(getActiveLoop('web', 'web', threadId)?.round).toBe(2)
  })

  it('headless loop (mission text 无人值守) auto-ends on met=true without user confirm', () => {
    reset()
    const threadId = 'loop-headless-text'
    const started = startLoop({
      ...base,
      threadId,
      text: '修好登录；退出条件为验收通过或无人值守',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })

    const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'stop',
      summary: 'regression green; login ok',
      met: true,
    })
    expect(stop.ok).toBe(true)
    if (!stop.ok) return
    expect(stop.run.status).toBe('ended')
    expect(stop.run.endReason).toBe('objective_met')
    // The user-confirm dock must NOT be shown for headless runs.
    expect(stop.run.status).not.toBe('pending_user_confirm')
  })

  it('AGIM_LOOP_HEADLESS=1 does not skip HITL on interactive (user) Loops', () => {
    reset()
    const saved = process.env.AGIM_LOOP_HEADLESS
    try {
      process.env.AGIM_LOOP_HEADLESS = '1'
      const threadId = 'loop-headless-env-user'
      const started = startLoop({
        ...base,
        threadId,
        text: '修好登录；退出条件为验收通过或最多5轮',
      })
      if (!started.ok) {
        if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
        return
      }
      noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
      const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
        decision: 'stop',
        summary: 'looks done',
        met: true,
      })
      expect(stop.ok).toBe(true)
      if (!stop.ok) return
      expect(stop.run.status).toBe('pending_user_confirm')
    } finally {
      if (saved === undefined) delete process.env.AGIM_LOOP_HEADLESS
      else process.env.AGIM_LOOP_HEADLESS = saved
    }
  })

  it('AGIM_LOOP_HEADLESS=1 auto-ends scheduled Loops; keyword in objective also counts', () => {
    reset()
    const saved = process.env.AGIM_LOOP_HEADLESS
    try {
      process.env.AGIM_LOOP_HEADLESS = '1'
      const threadId = 'loop-headless-env-sched'
      const started = startLoop({
        ...base,
        threadId,
        text: '修好登录；退出条件为验收通过或最多5轮',
        source: 'scheduled',
      })
      if (!started.ok) {
        if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
        return
      }
      noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
      const stop = applyLoopVerdict(base.platform, base.channelId, threadId, {
        decision: 'stop',
        summary: 'looks done',
        met: true,
      })
      expect(stop.ok).toBe(true)
      if (!stop.ok) return
      expect(stop.run.status).toBe('ended')
      expect(stop.run.endReason).toBe('objective_met')
    } finally {
      if (saved === undefined) delete process.env.AGIM_LOOP_HEADLESS
      else process.env.AGIM_LOOP_HEADLESS = saved
    }

    const threadId2 = 'loop-headless-objective'
    const keyed = startLoop({
      ...base,
      threadId: threadId2,
      text: '无人值守修好登录；退出条件为验收通过或最多5轮',
    })
    if (!keyed.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(keyed.error)
      return
    }
    noteLoopDispatch(base.platform, base.channelId, threadId2, { count: 1 })
    const ended = applyLoopVerdict(base.platform, base.channelId, threadId2, {
      decision: 'stop',
      summary: 'looks done',
      met: true,
    })
    expect(ended.ok).toBe(true)
    if (!ended.ok) return
    expect(ended.run.status).toBe('ended')
    expect(ended.run.endReason).toBe('objective_met')
  })

  it('maxRounds truncates after verify-unmet', () => {
    reset()
    const threadId = 'loop-r4-rounds'
    const started = startLoop({
      ...base,
      threadId,
      text: '短跑；退出条件为最多 1 轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.maxRounds).toBe(1)
    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'not yet',
      met: false,
      nextDirection: 'try again',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.status).toBe('ended')
    expect(r.run.endReason).toBe('limit')
  })

  it('maxWallMs truncates on verdict', () => {
    reset()
    const threadId = 'loop-r4-wall'
    const started = startLoop({
      ...base,
      threadId,
      text: '墙钟；退出条件为超过 1 分钟或最多 5 轮',
    })
    if (!started.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
      return
    }
    expect(started.run.mission?.exit.maxWallMs).toBe(60_000)
    _touchLoopCreatedAtForTests(
      base.platform, base.channelId, threadId, Date.now() - 120_000,
    )
    expect(isLoopWallExceeded(getLoopRun(base.platform, base.channelId, threadId)!)).toBe(true)

    noteLoopDispatch(base.platform, base.channelId, threadId, { count: 1 })
    const r = applyLoopVerdict(base.platform, base.channelId, threadId, {
      decision: 'continue',
      summary: 'still going',
      met: false,
      nextDirection: 'more',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.run.endReason).toBe('wall_limit')
  })
})

describe('loop history audit persistence', () => {
  it('writes history file and survives thread overwrite by a new Loop', () => {
    reset()
    const threadId = 'loop-history-overwrite'
    const first = startLoop({
      ...base,
      threadId,
      text: '第一轮目标；退出：验收通过或最多2轮',
    })
    if (!first.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(first.error)
      return
    }
    const firstId = first.run.id
    expect(existsSync(_historyPathForTests(firstId))).toBe(true)

    stopLoop(base.platform, base.channelId, threadId, 'user_stop')
    expect(getLoopRunById(firstId)?.status).toBe('ended')
    expect(getLoopRunById(firstId)?.endReason).toBe('user_stop')

    const second = startLoop({
      ...base,
      threadId,
      text: '第二轮目标；退出：最多3轮',
    })
    if (!second.ok) {
      if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(second.error)
      return
    }
    expect(second.run.id).not.toBe(firstId)
    // Thread snapshot is the new run…
    expect(getLoopRun(base.platform, base.channelId, threadId)?.id).toBe(second.run.id)
    // …but the first run remains in history for audit.
    const archived = getLoopRunById(firstId)
    expect(archived).not.toBeNull()
    expect(archived?.mission?.objective).toContain('第一轮')
    expect(archived?.status).toBe('ended')

    const listed = listLoopRuns({ threadId, limit: 20 })
    expect(listed.some((r) => r.id === firstId)).toBe(true)
    expect(listed.some((r) => r.id === second.run.id)).toBe(true)
  })

  it('listLoopRuns / getLoopRunById read history JSON without Focus/sqlite', () => {
    reset()
    const histDir = join(TMP, 'loops', 'history')
    mkdirSync(histDir, { recursive: true, mode: 0o700 })
    const id1 = '11111111-1111-4111-8111-111111111111'
    const id2 = '22222222-2222-4222-8222-222222222222'
    const mk = (id: string, objective: string, updatedAt: number) => ({
      id,
      sessionKey: 'wechat__rest__loop-hist-list',
      platform: 'wechat',
      channelId: 'rest',
      threadId: 'loop-hist-list',
      focusSnapshot: objective,
      openedFocus: false,
      status: 'ended',
      endReason: 'user_stop',
      round: 1,
      maxRounds: 3,
      mission: {
        objective,
        exit: { description: '最多3轮', maxRounds: 3, onFocusOff: 'cancel' },
      },
      dispatchesThisRound: 0,
      roundJobIds: [],
      loopJobIds: [9, 10],
      usage: { dispatchCount: 1, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
      createdAt: updatedAt - 1000,
      updatedAt,
      timeline: [{ at: updatedAt, kind: 'system', summary: 'ended' }],
    })
    writeFileSync(join(histDir, `${id1}.json`), JSON.stringify(mk(id1, '旧 Loop', 100), null, 2))
    writeFileSync(join(histDir, `${id2}.json`), JSON.stringify(mk(id2, '新 Loop', 200), null, 2))

    const byId = getLoopRunById(id1)
    expect(byId?.mission?.objective).toBe('旧 Loop')
    expect(byId?.loopJobIds).toEqual([9, 10])

    const listed = listLoopRuns({ threadId: 'loop-hist-list', limit: 10 })
    expect(listed.map((r) => r.id)).toEqual([id2, id1])
    expect(existsSync(_historyPathForTests(id1))).toBe(true)
  })

  it('discovers and reads detail reports under PROJECTS/loops/<loopId>.md', () => {
    reset()
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const reportsDir = join(TMP, 'reports-for-loop')
    mkdirSync(reportsDir, { recursive: true, mode: 0o700 })
    process.env.AGIM_LOOP_REPORTS_DIR = reportsDir
    try {
      expect(resolveLoopReportsDir()).toBe(reportsDir)
      writeFileSync(join(reportsDir, `${id}.md`), '# Report\n\nhello from loop\n', 'utf8')
      expect(discoverLoopReportPaths(id)).toEqual([join(reportsDir, `${id}.md`)])

      // Persist a minimal history run so noteLoopReportPath / read can attach.
      const histDir = join(TMP, 'loops', 'history')
      mkdirSync(histDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(histDir, `${id}.json`), JSON.stringify({
        id,
        sessionKey: 'web__web__t-report',
        platform: 'web',
        channelId: 'web',
        threadId: 't-report',
        focusSnapshot: 'x',
        openedFocus: false,
        status: 'ended',
        endReason: 'objective_met',
        round: 1,
        maxRounds: 3,
        mission: {
          objective: 'obj',
          exit: { description: 'exit', maxRounds: 3, onFocusOff: 'cancel' },
        },
        dispatchesThisRound: 0,
        roundJobIds: [],
        loopJobIds: [],
        reportPaths: [],
        usage: { dispatchCount: 0, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
        createdAt: 1,
        updatedAt: 2,
        timeline: [],
      }, null, 2))

      noteLoopReportPath(id, join(reportsDir, `${id}.md`))
      const linked = getLoopRunById(id)
      expect(linked?.reportPaths?.some((p) => p.endsWith(`${id}.md`))).toBe(true)

      const md = readLoopReportMarkdown(id)
      expect(md.ok).toBe(true)
      if (!md.ok) return
      expect(md.markdown).toContain('hello from loop')
      expect(md.path).toContain(`${id}.md`)
    } finally {
      delete process.env.AGIM_LOOP_REPORTS_DIR
    }
  })
})

describe('onLoopRunWritten', () => {
  it('fires after a successful startLoop write', () => {
    reset()
    const seen: string[] = []
    const off = onLoopRunWritten((run) => { seen.push(run.id) })
    try {
      const started = startLoop({
        ...base,
        threadId: 'loop-written-hook',
        text: '目标：写钩子；退出条件为最多1轮',
      })
      // Path B needs Focus persist; Bun skips better-sqlite3 — same soft-skip
      // as other loop-run cases when Focus cannot be set.
      if (!started.ok) {
        if (process.env.AGIM_TEST_REQUIRE_SQLITE === '1') throw new Error(started.error)
        return
      }
      expect(seen).toContain(started.run.id)
    } finally {
      off()
    }
  })
})

process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─── P1-2: confirm-timeout escape for pending_user_confirm ─────────────
describe('loop confirm timeout (AGIM_LOOP_CONFIRM_TIMEOUT_MS)', () => {
  const savedMs = process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS
  const savedAction = process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION

  afterEach(() => {
    if (savedMs === undefined) delete process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS
    else process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS = savedMs
    if (savedAction === undefined) delete process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION
    else process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION = savedAction
  })

  function seedPending(dir: string, over: Record<string, unknown> = {}): {
    platform: string
    channelId: string
    threadId: string
  } {
    const platform = 'wechat'
    const channelId = 'rest'
    const threadId = `t-confirm-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
    const sessionKey = `${platform}__${channelId}__${threadId}`
    const now = Date.now()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, `${sessionKey}.json`), JSON.stringify({
      id: `cccccccc-cccc-cccc-cccc-${threadId.slice(-12).padStart(12, '0')}`,
      sessionKey,
      platform,
      channelId,
      threadId,
      focusSnapshot: '分析金价',
      openedFocus: false,
      status: 'pending_user_confirm',
      round: 1,
      maxRounds: 3,
      mission: {
        objective: '分析金价箱体',
        exit: { description: '找到箱体或最多3轮', maxRounds: 3, onFocusOff: 'cancel' },
      },
      dispatchesThisRound: 1,
      usage: { dispatchCount: 1, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
      lastVerification: { at: now, met: true, summary: '箱体已定位' },
      createdAt: now,
      updatedAt: now,
      confirmedAt: now - 40 * 60 * 1000, // 40 min ago → past the 30 min default
      timeline: [],
      ...over,
    }), 'utf8')
    return { platform, channelId, threadId }
  }

  it('does nothing when AGIM_LOOP_CONFIRM_TIMEOUT_MS is unset (HITL default)', () => {
    delete process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS
    const dir = mkdtempSync(join(tmpdir(), 'loop-confirm-off-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    try {
      const { platform, channelId, threadId } = seedPending(process.env.AGIM_LOOPS_DIR!)
      const r = maybeResolveLoopConfirmTimeout(platform, channelId, threadId)
      expect(r.ended).toBe(false)
      expect(getActiveLoop(platform, channelId, threadId)?.status).toBe('pending_user_confirm')
    } finally {
      if (savedMs === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = savedMs
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('auto-ends as objective_met after the timeout window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-confirm-timeout-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS = String(30 * 60 * 1000)
    try {
      const { platform, channelId, threadId } = seedPending(process.env.AGIM_LOOPS_DIR!)
      const r = maybeResolveLoopConfirmTimeout(platform, channelId, threadId)
      expect(r.ended).toBe(true)
      if (!r.ended) return
      expect(r.run.status).toBe('ended')
      expect(r.run.endReason).toBe('objective_met')
      expect(r.reason).toBe('confirm_timeout')
    } finally {
      if (savedMs === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = savedMs
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('does not resolve before the timeout window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-confirm-early-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS = String(30 * 60 * 1000)
    try {
      const { platform, channelId, threadId } = seedPending(process.env.AGIM_LOOPS_DIR!, {
        confirmedAt: Date.now() - 60_000, // 1 min ago
      })
      const r = maybeResolveLoopConfirmTimeout(platform, channelId, threadId)
      expect(r.ended).toBe(false)
      expect(getActiveLoop(platform, channelId, threadId)?.status).toBe('pending_user_confirm')
    } finally {
      if (savedMs === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = savedMs
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('AGIM_LOOP_CONFIRM_TIMEOUT_ACTION=continue advances to planning instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-confirm-continue-'))
    process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    process.env.AGIM_LOOP_CONFIRM_TIMEOUT_MS = String(30 * 60 * 1000)
    process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION = 'continue'
    try {
      const { platform, channelId, threadId } = seedPending(process.env.AGIM_LOOPS_DIR!)
      const r = maybeResolveLoopConfirmTimeout(platform, channelId, threadId)
      expect(r.ended).toBe(false)
      const run = getActiveLoop(platform, channelId, threadId)
      expect(run?.status).toBe('planning')
      expect(run?.round).toBe(2)
      expect(run?.usage.continueCount).toBe(1)
    } finally {
      if (savedMs === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = savedMs
      if (savedAction === undefined) delete process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION
      else process.env.AGIM_LOOP_CONFIRM_TIMEOUT_ACTION = savedAction
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
