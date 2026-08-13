import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-session-bind-'))
process.env.AGIM_HOME = TEST_HOME

const bind = await import('./agim-session-bind.js')

describe('agim-session-bind', () => {
  it('appends a JSONL join row without merging transcripts', () => {
    bind.bindNativeSession({
      nativeSessionId: 'a2a-12',
      threadId: 'web-thread-1',
      platform: 'web',
      channelId: 'web',
      parentJobId: 12,
    })
    bind.bindNativeSession({
      nativeSessionId: 'web-web-web-thread-1-abc',
      threadId: 'web-thread-1',
      platform: 'web',
      channelId: 'web',
    })
    const raw = readFileSync(bind.nativeSessionIndexPath(), 'utf8').trim().split('\n')
    expect(raw).toHaveLength(2)
    const rows = raw.map((l) => JSON.parse(l) as { nativeSessionId: string; threadId: string })
    expect(rows[0]?.nativeSessionId).toBe('a2a-12')
    expect(rows[0]?.threadId).toBe('web-thread-1')
    expect(rows[1]?.nativeSessionId).toBe('web-web-web-thread-1-abc')
  })

  it('ignores empty nativeSessionId', () => {
    const before = readFileSync(bind.nativeSessionIndexPath(), 'utf8')
    bind.bindNativeSession({ nativeSessionId: '  ' })
    expect(readFileSync(bind.nativeSessionIndexPath(), 'utf8')).toBe(before)
  })
})
