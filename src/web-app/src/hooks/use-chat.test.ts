/**
 * chatReducer — unit tests for the reducer at the heart of /chat.
 *
 * The reducer is a pure function `(state, action) → state` and
 * covers a non-trivial state machine: WS lifecycle, optimistic
 * send, streaming chunk accumulation, server-final reconciliation,
 * inline approval cards. Indirect coverage via the route smoke
 * tests is real, but a unit pass against the dispatch surface
 * catches regressions in the transitions themselves (the place
 * where the bug lives, not in the render layer).
 */

import { describe, expect, it } from 'vitest'
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatMessage,
  type ChatState,
} from './use-chat'
import type { ApprovalCardPrompt, ChoiceCardPrompt } from '@/types/ws'

function mkPrompt(over: Partial<ApprovalCardPrompt> = {}): ApprovalCardPrompt {
  return {
    reqId: 'req-1',
    toolName: 'Bash',
    inputJson: 'rm -rf /',
    mode: 'normal',
    ...over,
  }
}

function mkChoicePrompt(over: Partial<ChoiceCardPrompt> = {}): ChoiceCardPrompt {
  return {
    title: 'agim · 请选择',
    body: 'pick one',
    choices: [
      { label: '1. a', data: 'ask:req-9:1' },
      { label: '2. b', data: 'ask:req-9:2' },
    ],
    meta: {
      kind: 'ask-user',
      reqId: 'req-9',
      selectionMode: 'single',
      minSelections: 1,
      maxSelections: 1,
      allowCustomInput: false,
      customInputLabel: '',
      timeoutSec: 90,
    },
    ...over,
  }
}

function userMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 }
}
function asstMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0 }
}

function reduce(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state)
}

describe('chatReducer', () => {
  it('WS_STATUS replaces the status field only', () => {
    const s = reduce(initialChatState, { kind: 'WS_STATUS', status: 'open' })
    expect(s.status).toBe('open')
    expect(s.messages).toEqual([])
    expect(s.agents).toEqual([])
  })

  it('INIT sets agents + defaultAgent; preserves a user-chosen agent', () => {
    const s1 = reduce(initialChatState, { kind: 'INIT', agents: ['a', 'b'], defaultAgent: 'a' })
    expect(s1).toMatchObject({ agents: ['a', 'b'], agent: 'a' })
    // If the user already picked 'b' before INIT lands, INIT does NOT
    // overwrite — defaultAgent is the fallback, not the override.
    const s2 = reduce(
      { ...initialChatState, agent: 'b' },
      { kind: 'INIT', agents: ['a', 'b'], defaultAgent: 'a' },
    )
    expect(s2.agent).toBe('b')
  })

  it('HISTORY replaces messages + sets agent', () => {
    const hist = [userMsg('h-1', 'hi'), asstMsg('h-2', 'hello')]
    const s = reduce(initialChatState, { kind: 'HISTORY', messages: hist, agent: 'claude' })
    expect(s.messages).toBe(hist)
    expect(s.agent).toBe('claude')
  })

  it('SEND_USER appends user message + placeholder + sets currentReplyId + clears error', () => {
    const u = userMsg('u-1', 'hi')
    const p = asstMsg('p-1')
    const s = reduce(
      { ...initialChatState, error: 'previous failure' },
      { kind: 'SEND_USER', message: u, placeholder: p },
    )
    expect(s.messages).toEqual([u, p])
    expect(s.currentReplyId).toBe('p-1')
    expect(s.error).toBeNull()
  })

  it('CHUNK appends to the matching message; ignored if replyId absent', () => {
    const base = reduce(initialChatState, {
      kind: 'SEND_USER', message: userMsg('u-1', 'hi'), placeholder: asstMsg('p-1'),
    })
    const afterChunk = reduce(base,
      { kind: 'CHUNK', replyId: 'p-1', text: 'Hel' },
      { kind: 'CHUNK', replyId: 'p-1', text: 'lo' },
    )
    expect(afterChunk.messages[1]?.content).toBe('Hello')
    // CHUNK for an unknown reply does not mutate.
    const ignored = reduce(afterChunk, { kind: 'CHUNK', replyId: 'nope', text: '!' })
    expect(ignored).toBe(afterChunk)
  })

  it('DONE prefers the server-final text + clears currentReplyId', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1', 'hi'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'partial' },
      { kind: 'DONE', replyId: 'p-1', finalText: 'Hello, full text.' },
    )
    expect(after.messages[1]?.content).toBe('Hello, full text.')
    expect(after.currentReplyId).toBeNull()
  })

  it('DONE with empty finalText keeps accumulated chunks', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'partial' },
      { kind: 'DONE', replyId: 'p-1', finalText: '' },
    )
    expect(after.messages[1]?.content).toBe('partial')
    expect(after.currentReplyId).toBeNull()
  })

  it('DONE for an unknown id only clears currentReplyId', () => {
    const after = reduce(
      { ...initialChatState, currentReplyId: 'p-1' },
      { kind: 'DONE', replyId: 'never-existed', finalText: 'x' },
    )
    expect(after.currentReplyId).toBeNull()
    expect(after.messages).toEqual([])
  })

  it('ERROR records the message + clears currentReplyId', () => {
    const after = reduce(
      { ...initialChatState, currentReplyId: 'p-1' },
      { kind: 'ERROR', message: 'WS closed' },
    )
    expect(after.error).toBe('WS closed')
    expect(after.currentReplyId).toBeNull()
  })

  it('CLEAR_ERROR resets only the error field', () => {
    const after = reduce(
      { ...initialChatState, error: 'oops', agents: ['a'] },
      { kind: 'CLEAR_ERROR' },
    )
    expect(after.error).toBeNull()
    expect(after.agents).toEqual(['a'])
  })

  it('AGENTS replaces the agent list; AGENT_SWITCHED replaces the selected agent', () => {
    const s1 = reduce(initialChatState,
      { kind: 'AGENTS', agents: ['claude', 'codex'] },
      { kind: 'AGENT_SWITCHED', agent: 'codex' },
    )
    expect(s1).toMatchObject({ agents: ['claude', 'codex'], agent: 'codex' })
  })

  // v1.2.115 — approvals moved out of the chat stream into a dock
  // (`pendingApprovals` slice). Reducer tests follow the new shape.

  it('APPROVAL_CARD pushes onto pendingApprovals; chat stream untouched', () => {
    const after = reduce(
      initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: mkPrompt({ inputJson: 'rm -rf /' }) },
    )
    expect(after.messages).toEqual([])
    expect(after.pendingApprovals).toHaveLength(1)
    expect(after.pendingApprovals[0]).toMatchObject({
      messageId: 'msg-7',
      prompt: { reqId: 'req-1', toolName: 'Bash', inputJson: 'rm -rf /' },
    })
    expect(after.pendingApprovals[0]?.outcome).toBeUndefined()
  })

  it('APPROVAL_CARD is deduped by messageId', () => {
    const after = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'dup', prompt: mkPrompt() },
      { kind: 'APPROVAL_CARD', messageId: 'dup', prompt: mkPrompt() },
    )
    expect(after.pendingApprovals).toHaveLength(1)
  })

  it('APPROVAL_TEXT is now a side-effect (toast) only; reducer is a no-op', () => {
    // v1.2.115 — approval-text receipts no longer land in chat or dock;
    // the hook's WS dispatcher surfaces them as a sonner toast. The
    // reducer must NOT pollute state.
    const after = reduce(initialChatState,
      { kind: 'APPROVAL_TEXT', messageId: 'msg-8', text: 'something happened' },
    )
    expect(after.messages).toEqual([])
    expect(after.pendingApprovals).toEqual([])
  })

  it('APPROVAL_EDIT updates the outcome on the matching dock entry', () => {
    const card = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: mkPrompt() },
      { kind: 'APPROVAL_EDIT', messageId: 'msg-7', outcome: { decision: 'allowed-pinned', byUserDisplay: '@alice' } },
    )
    expect(card.pendingApprovals[0]?.outcome).toMatchObject({
      decision: 'allowed-pinned',
      byUserDisplay: '@alice',
    })
    // resolvedAt timestamp is recorded for the timed-dismiss logic.
    expect(typeof card.pendingApprovals[0]?.resolvedAt).toBe('number')
  })

  it('APPROVAL_EDIT for an unknown messageId is a no-op', () => {
    const before = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: mkPrompt() },
    )
    const after = reduce(before, { kind: 'APPROVAL_EDIT', messageId: 'never', outcome: { decision: 'denied' } })
    expect(after).toBe(before)
  })

  it('APPROVAL_DISMISS removes the matching dock entry', () => {
    const seeded = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'a', prompt: mkPrompt() },
      { kind: 'APPROVAL_CARD', messageId: 'b', prompt: mkPrompt() },
    )
    expect(seeded.pendingApprovals).toHaveLength(2)
    const after = reduce(seeded, { kind: 'APPROVAL_DISMISS', messageId: 'a' })
    expect(after.pendingApprovals).toHaveLength(1)
    expect(after.pendingApprovals[0]?.messageId).toBe('b')
  })

  // ask_user (choice) cards — dock slice `pendingAsks`, same lifecycle as
  // approvals but resolution carries a `finalText` receipt.

  it('CHOICE_CARD pushes onto pendingAsks; chat stream untouched; deduped', () => {
    const after = reduce(initialChatState,
      { kind: 'CHOICE_CARD', messageId: 'ask-1', prompt: mkChoicePrompt() },
      { kind: 'CHOICE_CARD', messageId: 'ask-1', prompt: mkChoicePrompt() },
    )
    expect(after.messages).toEqual([])
    expect(after.pendingAsks).toHaveLength(1)
    expect(after.pendingAsks[0]).toMatchObject({
      messageId: 'ask-1',
      prompt: { body: 'pick one', meta: { reqId: 'req-9', selectionMode: 'single' } },
    })
    expect(after.pendingAsks[0]?.finalText).toBeUndefined()
  })

  it('CHOICE_EDIT marks the matching ask resolved with a receipt + timestamp', () => {
    const after = reduce(initialChatState,
      { kind: 'CHOICE_CARD', messageId: 'ask-1', prompt: mkChoicePrompt() },
      { kind: 'CHOICE_EDIT', messageId: 'ask-1', finalText: '✅ 已回答' },
    )
    expect(after.pendingAsks[0]?.finalText).toBe('✅ 已回答')
    expect(typeof after.pendingAsks[0]?.resolvedAt).toBe('number')
  })

  it('CHOICE_EDIT for an unknown messageId is a no-op', () => {
    const before = reduce(initialChatState,
      { kind: 'CHOICE_CARD', messageId: 'ask-1', prompt: mkChoicePrompt() },
    )
    const after = reduce(before, { kind: 'CHOICE_EDIT', messageId: 'never', finalText: 'x' })
    expect(after).toBe(before)
  })

  it('CHOICE_DISMISS removes the matching ask', () => {
    const seeded = reduce(initialChatState,
      { kind: 'CHOICE_CARD', messageId: 'a', prompt: mkChoicePrompt() },
      { kind: 'CHOICE_CARD', messageId: 'b', prompt: mkChoicePrompt() },
    )
    expect(seeded.pendingAsks).toHaveLength(2)
    const after = reduce(seeded, { kind: 'CHOICE_DISMISS', messageId: 'a' })
    expect(after.pendingAsks).toHaveLength(1)
    expect(after.pendingAsks[0]?.messageId).toBe('b')
  })

  it('RUN_START / RUN_USAGE / RUN_FINISH track recent run activity', () => {
    const after = reduce(
      initialChatState,
      { kind: 'RUN_START', runId: 'run-1', agent: 'claude', startedAt: 1000 },
      { kind: 'RUN_USAGE', runId: 'run-1', durationMs: 320, outputChars: 128 },
      { kind: 'RUN_FINISH', runId: 'run-1', status: 'success', finishedAt: 1320, durationMs: 320 },
    )
    expect(after.activeRunId).toBeNull()
    expect(after.runActivities).toHaveLength(1)
    expect(after.runActivities[0]).toMatchObject({
      runId: 'run-1',
      agent: 'claude',
      status: 'success',
      durationMs: 320,
      outputChars: 128,
      finishedAt: 1320,
    })
  })

  it('RESET_CONVERSATION clears messages + reply id + error; keeps agents + agent', () => {
    const seeded = reduce(initialChatState,
      { kind: 'WS_STATUS', status: 'open' },
      { kind: 'INIT', agents: ['claude', 'codex'], defaultAgent: 'claude' },
      { kind: 'SEND_USER', message: userMsg('u-1', 'hi'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'claude', startedAt: 1000 },
      { kind: 'ERROR', message: 'old' },
    )
    const after = reduce(seeded, { kind: 'RESET_CONVERSATION' })
    expect(after.messages).toEqual([])
    expect(after.pendingApprovals).toEqual([])
    expect(after.pendingAsks).toEqual([])
    expect(after.runActivities).toEqual([])
    expect(after.activeRunId).toBeNull()
    expect(after.currentReplyId).toBeNull()
    expect(after.error).toBeNull()
    // Preserved
    expect(after.status).toBe('open')
    expect(after.agents).toEqual(['claude', 'codex'])
    expect(after.agent).toBe('claude')
  })

  it('a full happy-path session: connect → init → send → stream → done', () => {
    const sess = reduce(initialChatState,
      { kind: 'WS_STATUS', status: 'connecting' },
      { kind: 'WS_STATUS', status: 'open' },
      { kind: 'INIT', agents: ['claude'], defaultAgent: 'claude' },
      { kind: 'SEND_USER', message: userMsg('u-1', 'hello'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'Hi ' },
      { kind: 'CHUNK', replyId: 'p-1', text: 'there!' },
      { kind: 'DONE', replyId: 'p-1', finalText: 'Hi there!' },
    )
    expect(sess.status).toBe('open')
    expect(sess.agent).toBe('claude')
    expect(sess.currentReplyId).toBeNull()
    expect(sess.messages.map((m) => m.content)).toEqual(['hello', 'Hi there!'])
  })

  it('RUN_START attaches a running activity to the current assistant placeholder', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
    )
    expect(after.activeRunId).toBe('run-1')
    expect(after.messages[1]?.activity).toMatchObject({
      runId: 'run-1',
      status: 'running',
      startedAt: 1_000,
      steps: [],
    })
  })

  it('APPROVAL_CARD appends a pending step onto the active activity', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      { kind: 'APPROVAL_CARD', messageId: 'apv-1', prompt: mkPrompt({ toolName: 'agim_exec' }) },
    )
    expect(after.pendingApprovals).toHaveLength(1)
    expect(after.messages[1]?.activity?.steps).toEqual([
      expect.objectContaining({
        id: 'apv-1',
        kind: 'approval',
        label: 'agim_exec',
        status: 'pending',
      }),
    ])
  })

  it('RUN_FINISH marks the activity Worked and resolves pending steps', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      { kind: 'APPROVAL_CARD', messageId: 'apv-1', prompt: mkPrompt() },
      {
        kind: 'RUN_FINISH',
        runId: 'run-1',
        status: 'success',
        finishedAt: 5_000,
        durationMs: 4_000,
      },
    )
    expect(after.messages[1]?.activity).toMatchObject({
      status: 'success',
      durationMs: 4_000,
    })
    expect(after.messages[1]?.activity?.steps[0]?.status).toBe('success')
    expect(after.activeRunId).toBeNull()
  })

  it('ACTIVITY_STEP upserts live tool steps onto the bound reply', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'tc-1',
          kind: 'tool',
          label: 'agim_read',
          status: 'running',
          startedAt: 1_100,
          preview: '{"path":"a.ts"}',
        },
      },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'tc-1',
          kind: 'tool',
          label: 'agim_read',
          status: 'success',
          startedAt: 1_100,
          finishedAt: 1_400,
          preview: 'ok',
        },
      },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'tc-2',
          kind: 'skill',
          label: 'skill_accessibility',
          status: 'running',
          startedAt: 1_500,
        },
      },
    )
    expect(after.messages[1]?.activity?.steps).toHaveLength(2)
    expect(after.messages[1]?.activity?.steps[0]).toMatchObject({
      id: 'tc-1',
      status: 'success',
      preview: 'ok',
    })
    expect(after.messages[1]?.activity?.steps[1]).toMatchObject({
      kind: 'skill',
      label: 'skill_accessibility',
      status: 'running',
    })
  })

  it('ACTIVITY_STEP accepts agent (A2A) steps', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'a2a-9',
          kind: 'agent',
          label: 'claude-code',
          status: 'running',
          startedAt: 1_200,
        },
      },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'a2a-9',
          kind: 'agent',
          label: 'claude-code',
          status: 'success',
          startedAt: 1_200,
          finishedAt: 2_000,
        },
      },
    )
    expect(after.messages[1]?.activity?.steps[0]).toMatchObject({
      kind: 'agent',
      label: 'claude-code',
      status: 'success',
    })
  })
})
