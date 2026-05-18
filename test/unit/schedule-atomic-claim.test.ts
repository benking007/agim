// M-N11 — fireSchedule must atomically claim a row before creating a
// Job, so two concurrent ticks can't double-fire the same schedule.
// Without the CAS:
//   tick A reads (next_run=T)         ─┐
//   tick B reads (next_run=T)          │ → both call fireSchedule
//   tick A: createJob, UPDATE next_run │   → DB now has next_run=T+1
//   tick B: createJob, UPDATE next_run │   → second createJob, same expr
// With the CAS (UPDATE … WHERE next_run = read_value), only one UPDATE
// finds the original next_run; the other becomes a no-op and bails out
// before createJob runs.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import {
  createSchedule,
  getSchedule,
  deleteSchedule,
  tick,
} from '../../src/core/schedule'
import { listJobs } from '../../src/core/job-board'
import { registry } from '../../src/core/registry'

// bun + better-sqlite3 native binding is unreliable in this dev image.
// Probe with a real createSchedule; if it throws, skip the whole suite
// (the test logic only makes sense when SQL actually executes).
const dbAvailable = (() => {
  try {
    const id = createSchedule({
      name: '_probe_', agent: 'stub-atomic', prompt: 'x', cron: '* * * * *',
    })
    deleteSchedule(id)
    return true
  } catch {
    return false
  }
})()

const skipIfNoDb = dbAvailable ? describe : describe.skip

skipIfNoDb('fireSchedule atomic claim (M-N11)', () => {
  beforeAll(() => {
    registry.registerAgent({
      name: 'stub-atomic',
      aliases: [],
      isAvailable: async () => true,
      // biome-ignore lint/correctness/useYield: no chunks needed for this test
      sendPrompt: async function* () {},
    })
  })

  afterAll(() => { /* registry is process-global; leave the stub installed */ })

  it('two concurrent tick() calls produce one Job, not two', async () => {
    const id = createSchedule({
      name: 'atomic-test',
      agent: 'stub-atomic',
      prompt: 'noop',
      cron: '* * * * *',
    })
    try {
      const before = listJobs(50).length
      // Both ticks pass `now`= future enough so dueSchedules definitely
      // matches the row's next_run (which was set to the soonest minute).
      const future = new Date(Date.now() + 10 * 60_000)
      await Promise.all([tick(future), tick(future)])
      const after = listJobs(50).length
      expect(after - before).toBe(1)

      // And the row was advanced past `future`, so a third tick at the
      // same instant is a no-op.
      const sched = getSchedule(id)
      expect(sched).not.toBeNull()
      const advancedTo = new Date(sched!.next_run).getTime()
      expect(advancedTo).toBeGreaterThan(future.getTime())
    } finally {
      deleteSchedule(id)
    }
  })

  it('returns 0 changes when next_run was already advanced (idempotent)', async () => {
    const id = createSchedule({
      name: 'idempotent-test',
      agent: 'stub-atomic',
      prompt: 'noop',
      cron: '* * * * *',
    })
    try {
      const future = new Date(Date.now() + 10 * 60_000)
      await tick(future)
      const advanced = getSchedule(id)
      const before = listJobs(50).length

      // Second tick at the SAME `now`: row's next_run is past `now`
      // (because we advanced it), so dueSchedules returns nothing and
      // no Job is created. The atomic CAS isn't even needed here — the
      // SELECT filter handles it — but this confirms the post-tick state.
      await tick(future)
      expect(listJobs(50).length - before).toBe(0)
      const after = getSchedule(id)
      expect(after!.next_run).toBe(advanced!.next_run)
    } finally {
      deleteSchedule(id)
    }
  })
})
