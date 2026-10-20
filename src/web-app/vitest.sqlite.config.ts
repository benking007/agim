import { fileURLToPath, URL } from 'node:url'
import { getTests } from '@vitest/runner/utils'
import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const bunTestShim = fileURLToPath(new URL('./src/test/bun-test-shim.ts', import.meta.url))

const failOnSkippedTests: Reporter = {
  onFinished(files) {
    const skipped = getTests(files).filter((test) =>
      test.result?.state === 'skip' || test.mode === 'skip' || test.mode === 'todo')
    if (skipped.length === 0) return

    const sample = skipped.slice(0, 5).map((test) => test.name).join(', ')
    process.exitCode = 1
    throw new Error(
      `[sqlite-test] ${skipped.length} test(s) skipped; Node persistence tests must not degrade silently: ${sample}`,
    )
  },
}

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      'bun:test': bunTestShim,
    },
  },
  test: {
    environment: 'node',
    reporters: ['default', failOnSkippedTests],
    setupFiles: [fileURLToPath(new URL('../../test/setup.ts', import.meta.url))],
    include: [
      'src/core/goals.test.ts',
      'src/core/focus.test.ts',
      'src/core/loop-run.test.ts',
      'src/core/loop-scheduler.test.ts',
      'src/core/loop-schedule-nl.test.ts',
      'src/core/loop-schedule-intent.test.ts',
      'src/core/loop-verify-gate.test.ts',
      'src/core/commands/loop-parent-gate.test.ts',
      'src/web/background-tasks-api.test.ts',
      'src/web/schedule-api.test.ts',
      'src/web/schedule-owner-scope.test.ts',
      'test/unit/audit-events.test.ts',
      'test/unit/goal-evidence.test.ts',
      'test/unit/goals-migration.test.ts',
      'test/unit/todo-persist.test.ts',
      'test/unit/bridge-phase1.test.ts',
      'test/unit/bridge-phase2.test.ts',
      'test/unit/bridge-phase3.test.ts',
      'test/unit/job-board-inline.test.ts',
      'test/unit/jobs-api-get-auth.test.ts',
      'test/unit/job-recovery.test.ts',
      'test/unit/memo-rpc.test.ts',
      'test/unit/memory-dedup.test.ts',
      'test/unit/memory-retention.test.ts',
      'test/unit/message-sink.test.ts',
      'test/unit/memos.test.ts',
      'test/unit/outbox.test.ts',
      'test/unit/plan-session-sync.test.ts',
      'test/unit/reminder-rpc.test.ts',
      'test/unit/reminders.test.ts',
      'test/unit/viewer-retention.test.ts',
      'test/unit/wechat-context-store.test.ts',
    ],
    pool: 'forks',
    fileParallelism: false,
    isolate: true,
    env: {
      AGIM_TEST_REQUIRE_SQLITE: '1',
      LOG_LEVEL: 'silent',
    },
  },
})
