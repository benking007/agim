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

  it('HISTORY restores per-message activity accordions', () => {
    const hist: ChatMessage[] = [
      userMsg('h-1', 'hi'),
      {
        ...asstMsg('h-2', 'hello'),
        activity: {
          runId: 'run-a',
          status: 'success',
          startedAt: 1000,
          finishedAt: 2000,
          durationMs: 1000,
          steps: [{
            id: 's1', kind: 'tool', label: 'search', status: 'success',
            startedAt: 1100, finishedAt: 1500,
          }],
        },
      },
      userMsg('h-3', 'more'),
      {
        ...asstMsg('h-4', 'done'),
        activity: {
          runId: 'run-b',
          status: 'success',
          startedAt: 3000,
          finishedAt: 5000,
          durationMs: 2000,
          steps: [],
        },
      },
    ]
    const s = reduce(initialChatState, { kind: 'HISTORY', messages: hist, agent: 'agim' })
    expect(s.messages[1]?.activity?.runId).toBe('run-a')
    expect(s.messages[1]?.activity?.steps[0]?.label).toBe('search')
    expect(s.messages[3]?.activity?.durationMs).toBe(2000)
  })

  it('HISTORY with empty messages keeps local bubbles but adopts sticky agent', () => {
    const local = [userMsg('u-1', 'kept'), asstMsg('a-1', 'local')]
    const s = reduce(
      { ...initialChatState, messages: local, agent: 'default' },
      { kind: 'HISTORY', messages: [], agent: 'agim' },
    )
    expect(s.messages).toBe(local)
    expect(s.agent).toBe('agim')
  })

  it('ACTIVE_RUN restores running activity + streaming target after HISTORY', () => {
    const hist = [userMsg('h-1', 'analyze'), asstMsg('h-2', 'partial…')]
    const afterHist = reduce(initialChatState, {
      kind: 'HISTORY', messages: hist, agent: 'agim',
    })
    const s = reduce(afterHist, {
      kind: 'ACTIVE_RUN',
      runId: 'run-9',
      agent: 'agim',
      startedAt: 1_000,
      status: 'running',
      steps: [{
        id: 'tc-1',
        kind: 'tool',
        label: 'web_search',
        status: 'running',
        startedAt: 1_100,
      }],
      partialText: 'partial… more',
    })
    expect(s.activeRunId).toBe('run-9')
    expect(s.currentReplyId).toBe('reply-restore-run-9')
    expect(s.messages.at(-1)?.activity?.steps[0]?.label).toBe('web_search')
    expect(s.messages.at(-1)?.content).toBe('partial… more')
    expect(s.runActivities[0]?.status).toBe('running')
  })

  it('ACTIVE_RUN finished snapshot restores accordion without streaming badge', () => {
    const hist = [userMsg('h-1', 'hi'), asstMsg('h-2', 'final answer')]
    const s = reduce(
      initialChatState,
      { kind: 'HISTORY', messages: hist, agent: 'agim' },
      {
        kind: 'ACTIVE_RUN',
        runId: 'run-8',
        agent: 'agim',
        startedAt: 1_000,
        status: 'success',
        finishedAt: 2_000,
        durationMs: 1_000,
        steps: [{
          id: 'tc-1',
          kind: 'tool',
          label: 'web_search',
          status: 'success',
          startedAt: 1_100,
          finishedAt: 1_500,
        }],
        partialText: 'final answer',
      },
    )
    expect(s.activeRunId).toBeNull()
    expect(s.currentReplyId).toBeNull()
    expect(s.messages.at(-1)?.activity?.status).toBe('success')
    expect(s.messages.at(-1)?.activity?.steps).toHaveLength(1)
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

  it('DONE resolves activity by runId when replyId was remapped', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-cli', agent: 'claude-code', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-cli',
        step: {
          id: 'tc-1',
          kind: 'tool',
          label: 'Bash',
          status: 'running',
          startedAt: 1_100,
        },
      },
      // Simulate HISTORY remapping the bubble id while the run is live.
      {
        kind: 'DONE',
        replyId: 'stale-id',
        runId: 'run-cli',
        finalText: 'done via runId',
      },
    )
    expect(after.currentReplyId).toBeNull()
    expect(after.activeRunId).toBeNull()
    expect(after.messages[1]?.content).toBe('done via runId')
    expect(after.messages[1]?.activity).toMatchObject({ status: 'success', runId: 'run-cli' })
    expect(after.messages[1]?.activity?.steps[0]?.status).toBe('success')
  })

  it('DONE falls back to the last running activity when ids are missing', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-pi', agent: 'pi', startedAt: 1_000 },
      { kind: 'DONE', replyId: '', finalText: 'recovered' },
    )
    expect(after.messages[1]?.activity?.status).toBe('success')
    expect(after.currentReplyId).toBeNull()
  })

  it('HISTORY does not wipe an in-flight turn', () => {
    const mid = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'codex', startedAt: 1_000 },
    )
    const after = reduce(
      mid,
      {
        kind: 'HISTORY',
        agent: 'codex',
        messages: [
          { id: 'hist-0', role: 'user', content: 'old', timestamp: 1 },
          { id: 'hist-1', role: 'assistant', content: 'old reply', timestamp: 2 },
        ],
      },
    )
    expect(after.currentReplyId).toBe('p-1')
    expect(after.activeRunId).toBe('run-1')
    expect(after.messages[1]?.id).toBe('p-1')
    expect(after.messages[1]?.activity?.status).toBe('running')
  })

  it('HISTORY adopts finished run after sleep/wake (clears stuck Running)', () => {
    const mid = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-wake', agent: 'agim', startedAt: 1_000 },
    )
    const after = reduce(
      mid,
      {
        kind: 'HISTORY',
        agent: 'agim',
        messages: [
          { id: 'hist-0', role: 'user', content: 'go', timestamp: 1 },
          {
            id: 'hist-1',
            role: 'assistant',
            content: 'done while asleep',
            timestamp: 2,
            activity: {
              runId: 'run-wake',
              status: 'success',
              startedAt: 1_000,
              finishedAt: 2_000,
              steps: [],
            },
          },
        ],
      },
    )
    expect(after.activeRunId).toBeNull()
    expect(after.currentReplyId).toBeNull()
    expect(after.messages[1]?.content).toBe('done while asleep')
    expect(after.messages[1]?.activity?.status).toBe('success')
  })

  it('HISTORY adopts when summary text is ahead (no activity runId match)', () => {
    const mid = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-stale', agent: 'agim', startedAt: 1_000 },
      { kind: 'CHUNK', replyId: 'p-1', text: 'partial…' },
    )
    const summary = '✅ Loop 已结束\n\n' + '核心结论：'.repeat(20)
    const after = reduce(
      mid,
      {
        kind: 'HISTORY',
        agent: 'agim',
        messages: [
          { id: 'hist-0', role: 'user', content: 'go', timestamp: 1 },
          { id: 'hist-1', role: 'assistant', content: summary, timestamp: 2 },
        ],
      },
    )
    expect(after.activeRunId).toBeNull()
    expect(after.messages[1]?.content).toBe(summary)
  })

  it('RUN_FINISH clears currentReplyId so Running… cannot stick', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'claude-code', startedAt: 1_000 },
      {
        kind: 'RUN_FINISH',
        runId: 'run-1',
        status: 'success',
        finishedAt: 1_500,
        durationMs: 500,
      },
    )
    expect(after.currentReplyId).toBeNull()
    expect(after.activeRunId).toBeNull()
    expect(after.messages[1]?.activity?.status).toBe('success')
  })

  it('ERROR records the message + clears currentReplyId', () => {
    const after = reduce(
      { ...initialChatState, currentReplyId: 'p-1' },
      { kind: 'ERROR', message: 'WS closed' },
    )
    expect(after.error).toBe('WS closed')
    expect(after.currentReplyId).toBeNull()
  })

  it('ERROR closes open activity steps on the in-flight reply', () => {
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
        },
      },
      { kind: 'ERROR', message: 'agent crashed' },
    )
    expect(after.error).toBe('agent crashed')
    expect(after.messages[1]?.activity).toMatchObject({
      status: 'error',
      error: 'agent crashed',
    })
    expect(after.messages[1]?.activity?.steps[0]?.status).toBe('error')
  })

  it('DONE closes a still-running activity when run-finish is missing', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'pi', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'tc-1',
          kind: 'tool',
          label: 'Bash',
          status: 'running',
          startedAt: 1_100,
        },
      },
      { kind: 'DONE', replyId: 'p-1', finalText: 'all done' },
    )
    expect(after.currentReplyId).toBeNull()
    expect(after.activeRunId).toBeNull()
    expect(after.messages[1]?.activity).toMatchObject({ status: 'success' })
    expect(after.messages[1]?.activity?.steps[0]?.status).toBe('success')
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

  it('RUN_FINISH completes a sticky trailing in_progress Plan item', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'agim-plan-checklist',
          kind: 'tool',
          label: 'agim_todo_write',
          status: 'success',
          startedAt: 1_100,
          finishedAt: 1_200,
          todoItems: [
            { content: 'research', status: 'completed' },
            { content: 'write report', status: 'in_progress' },
          ],
        },
      },
      {
        kind: 'RUN_FINISH',
        runId: 'run-1',
        status: 'success',
        finishedAt: 5_000,
        durationMs: 4_000,
      },
    )
    expect(after.messages[1]?.activity?.steps[0]?.todoItems).toEqual([
      { content: 'research', status: 'completed' },
      { content: 'write report', status: 'completed' },
    ])
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

  it('ACTIVITY_STEP refreshes todoItems on the stable plan step mid-turn', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'RUN_START', runId: 'run-1', agent: 'agim', startedAt: 1_000 },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'agim-plan-checklist',
          kind: 'tool',
          label: 'agim_todo_write',
          status: 'success',
          startedAt: 1_100,
          finishedAt: 1_200,
          todoItems: [
            { content: 'one', status: 'in_progress' },
            { content: 'two', status: 'pending' },
          ],
        },
      },
      {
        kind: 'ACTIVITY_STEP',
        runId: 'run-1',
        step: {
          id: 'agim-plan-checklist',
          kind: 'tool',
          label: 'agim_todo_write',
          status: 'success',
          startedAt: 1_500,
          finishedAt: 1_600,
          todoItems: [
            { content: 'one', status: 'completed' },
            { content: 'two', status: 'in_progress' },
          ],
        },
      },
    )
    expect(after.messages[1]?.activity?.steps).toHaveLength(1)
    expect(after.messages[1]?.activity?.steps[0]?.todoItems).toEqual([
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
    ])
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
