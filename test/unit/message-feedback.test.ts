import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearThreadFeedback,
  listMessageFeedback,
  resolveFeedbackVote,
  upsertMessageFeedback,
} from '../../src/core/message-feedback.js'
import {
  clearPendingDownvoteHint,
  consumePendingDownvoteHint,
  DOWNVOTE_HINT_TEMPLATE,
  feedbackThreadKey,
  resetPendingDownvoteHints,
  setPendingDownvoteHint,
} from '../../src/core/message-feedback-hints.js'

describe('message-feedback sidecar', () => {
  const platform = 'web'
  const channelId = 'web'
  const threadId = `web-fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  afterEach(async () => {
    await clearThreadFeedback(platform, channelId, threadId)
  })

  it('upserts, resolves by id/index, and clears', async () => {
    await upsertMessageFeedback({
      platform,
      channelId,
      threadId,
      messageIndex: 3,
      messageId: 'msg-abc',
      vote: 'down',
    })
    let entries = await listMessageFeedback(platform, channelId, threadId)
    expect(entries).toHaveLength(1)
    expect(resolveFeedbackVote(entries, { messageId: 'msg-abc', messageIndex: 99 })).toBe('down')
    expect(resolveFeedbackVote(entries, { messageIndex: 3 })).toBe('down')

    await upsertMessageFeedback({
      platform,
      channelId,
      threadId,
      messageIndex: 3,
      messageId: 'msg-abc',
      vote: 'up',
    })
    entries = await listMessageFeedback(platform, channelId, threadId)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.vote).toBe('up')

    await upsertMessageFeedback({
      platform,
      channelId,
      threadId,
      messageIndex: 3,
      messageId: 'msg-abc',
      vote: null,
    })
    entries = await listMessageFeedback(platform, channelId, threadId)
    expect(entries).toHaveLength(0)
  })
})

describe('message-feedback-hints', () => {
  beforeEach(() => {
    resetPendingDownvoteHints()
  })

  it('consumes a downvote hint once', () => {
    const key = feedbackThreadKey('web', 'web', 'web-hint-1')
    setPendingDownvoteHint(key)
    expect(consumePendingDownvoteHint(key)).toBe(DOWNVOTE_HINT_TEMPLATE)
    expect(consumePendingDownvoteHint(key)).toBeUndefined()
  })

  it('clears an armed hint without consuming', () => {
    const key = feedbackThreadKey('web', 'web', 'web-hint-2')
    setPendingDownvoteHint(key)
    clearPendingDownvoteHint(key)
    expect(consumePendingDownvoteHint(key)).toBeUndefined()
  })
})
