#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock for Phase A acceptance.
 *
 * Env:
 *   MOCK_LLM_PORT   default 18080
 *   MOCK_LLM_LOG    path to JSONL request log (default /tmp/agim-mock-llm.jsonl)
 *
 * Scripted markers in the latest user text:
 *   PHASE_A1_ISOLATE_TEST  → tool_call call_agent isolate:true
 *   PHASE_A1_CHEAP_TEST    → tool_call call_agent role:cheap
 *   PHASE_A1_VACUOUS_TEST  → tool_call call_agent (no isolate/role/backend)
 *   PHASE_A2_SERIAL_TEST   → first call_agent cheap, then isolate after tool result
 *   PHASE_A1_SUBAGENT_BRIEF → nested Subagent reply (plain text)
 *   PHASE_B_PARALLEL_TEST  → tool_call call_agents with 3 slow lanes
 *   PHASE_B_SUBAGENT_SLOW  → nested Subagent reply after ~800ms (concurrency probe)
 *   LOOP_E2E_TEST          → call_agents then loop_verdict stop met=true (Loop R3–R5)
 *   (evaluator)            → JSON agree when prompt asks for independent Loop verifier
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_LLM_PORT || 18080)
const LOG = process.env.MOCK_LLM_LOG || '/tmp/agim-mock-llm.jsonl'
const SLOW_MS = Number(process.env.MOCK_LLM_SLOW_MS || 800)
writeFileSync(LOG, '', 'utf8')

const state = {
  requests: [],
  /** Per-conversation fingerprint → how many assistant tool rounds already done. */
  rounds: new Map(),
  /** Concurrency probe for PHASE_B_SUBAGENT_SLOW nested calls. */
  liveSlow: 0,
  peakSlow: 0,
  slowHits: 0,
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user') return messageText(m)
  }
  return ''
}

function messageText(m) {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
  }
  return ''
}

function hasToolResult(messages) {
  return messages.some((m) => m?.role === 'tool' || m?.role === 'toolResult')
}

function countToolResults(messages) {
  return messages.filter((m) => m?.role === 'tool' || m?.role === 'toolResult').length
}

function systemText(messages) {
  return messages.filter((m) => m?.role === 'system').map(messageText).join('\n')
}

function toolCall(name, args, id = `call_${Date.now()}`) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }
}

function textReply(text) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
  }
}

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const user = lastUserText(messages)
  const model = String(body.model || '')
  const toolsN = Array.isArray(body.tools) ? body.tools.length : 0
  const sys = systemText(messages)
  const toolResults = countToolResults(messages)

  const toolsBlob = Array.isArray(body.tools)
    ? body.tools.map((t) => `${t?.function?.name || t?.name || ''}:${t?.function?.description || t?.description || ''}`).join('\n')
    : ''
  const heuristicHaystack = `${sys}\n${toolsBlob}`
  const entry = {
    at: new Date().toISOString(),
    model,
    toolsN,
    userHead: user.slice(0, 160).replace(/\s+/g, ' '),
    toolResults,
    hasSubagentHeuristics: /Subagent delegation|do not spawn for trivial|Brief four-piece|do not parallel-write|Objective \+ Output format/i.test(heuristicHaystack),
    systemHasCallAgent: /mcp__agim__call_agent|call_agent/i.test(heuristicHaystack),
    systemHasCallAgents: /mcp__agim__call_agents|call_agents/i.test(heuristicHaystack),
    systemHead: sys.slice(0, 240).replace(/\s+/g, ' '),
    systemLen: sys.length,
    toolsHead: toolsBlob.slice(0, 280).replace(/\s+/g, ' '),
  }
  state.requests.push(entry)
  try { appendFileSync(LOG, `${JSON.stringify(entry)}\n`) } catch { /* ignore */ }

  // Independent Loop cheap evaluator (AGIM_LOOP_EVALUATOR)
  if (/independent Loop verifier|Loop verifier/i.test(user) || /"agree":boolean/i.test(user)) {
    return textReply('{"agree":true,"reason":"mock evaluator: objective claim looks sufficient"}')
  }

  // Nested Subagent sessions get a fresh transcript with our brief marker.
  if (/PHASE_B_SUBAGENT_SLOW/i.test(user)) {
    const lane = (user.match(/lane=(\w+)/i) || [])[1] || '?'
    return textReply(`SUBAGENT_OK SLOW lane=${lane} model=${model}`)
  }

  if (/LOOP_E2E_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agents', {
        tasks: [
          {
            agent: 'agim',
            role: 'cheap',
            prompt:
              'PHASE_A1_SUBAGENT_BRIEF lane=loop\n'
              + 'Objective: reply SUBAGENT_OK for Loop E2E\n'
              + 'Output format: one line\n'
              + 'Boundaries: no tools\n'
              + 'Done-when: printed SUBAGENT_OK',
          },
        ],
      }, 'loop_e2e_dispatch')
    }
    if (toolResults === 1) {
      return toolCall('mcp__agim__loop_verdict', {
        decision: 'stop',
        met: true,
        summary: 'LOOP_E2E: mock dispatch done; objective treated as met for demo',
        gaps: [],
      }, 'loop_e2e_verdict')
    }
    return textReply('LOOP_E2E_PARENT_DONE — mission closed (objective_met)')
  }

  if (/PHASE_A1_SUBAGENT_BRIEF/i.test(user)) {
    if (/LONG_RESULT/i.test(user)) {
      const lines = Array.from({ length: 80 }, (_, i) =>
        `RESULT_LINE_${String(i + 1).padStart(3, '0')}: lorem detail for Subagent sheet scroll/expand — model=${model}`)
      return textReply(['SUBAGENT_OK LONG_RESULT', ...lines].join('\n'))
    }
    return textReply(`SUBAGENT_OK model=${model}`)
  }

  if (/PHASE_A_TODO_AND_SUBAGENT_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('agim_todo_write', {
        items: [
          { content: 'plan work', status: 'in_progress' },
          { content: 'delegate detail', status: 'pending' },
          { content: 'synthesize', status: 'pending' },
        ],
      }, 'todo_sa_1')
    }
    if (toolResults === 1) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        isolate: true,
        prompt:
          'PHASE_A1_SUBAGENT_BRIEF\n'
          + 'Objective: reply with SUBAGENT_OK\n'
          + 'Output format: one line\n'
          + 'Boundaries: no tools\n'
          + 'Done-when: printed SUBAGENT_OK',
      }, 'todo_sa_call')
    }
    if (toolResults === 2) {
      return toolCall('agim_todo_write', {
        items: [
          { content: 'plan work', status: 'completed' },
          { content: 'delegate detail', status: 'completed' },
          { content: 'synthesize', status: 'completed' },
        ],
      }, 'todo_sa_2')
    }
    return textReply('PARENT_DONE todo-and-subagent')
  }

  if (/PHASE_A_TODO_PROGRESS_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('agim_todo_write', {
        items: [
          { content: 'outline steps', status: 'in_progress' },
          { content: 'do the work', status: 'pending' },
          { content: 'summarize', status: 'pending' },
        ],
      }, 'todo_prog_1')
    }
    if (toolResults === 1) {
      return toolCall('agim_todo_write', {
        items: [
          { content: 'outline steps', status: 'completed' },
          { content: 'do the work', status: 'in_progress' },
          { content: 'summarize', status: 'pending' },
        ],
      }, 'todo_prog_2')
    }
    if (toolResults === 2) {
      return toolCall('agim_todo_write', {
        items: [
          { content: 'outline steps', status: 'completed' },
          { content: 'do the work', status: 'completed' },
          { content: 'summarize', status: 'completed' },
        ],
      }, 'todo_prog_3')
    }
    return textReply('PARENT_DONE todo-progress')
  }

  if (/PHASE_A_LONG_SHEET_TEST/i.test(user)) {
    if (toolResults === 0) {
      const promptLines = Array.from({ length: 60 }, (_, i) =>
        `PROMPT_LINE_${String(i + 1).padStart(3, '0')}: parent brief filler for overflow testing of the docked sheet.`)
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        isolate: true,
        prompt: [
          'PHASE_A1_SUBAGENT_BRIEF LONG_RESULT',
          'Objective: reply with a long multi-line result for UI overflow',
          'Output format: many lines',
          'Boundaries: no tools',
          'Done-when: printed SUBAGENT_OK LONG_RESULT',
          '',
          ...promptLines,
        ].join('\n'),
      }, 'call_long_sheet')
    }
    return textReply('PARENT_DONE long-sheet')
  }

  if (/PHASE_A1_ISOLATE_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        isolate: true,
        prompt:
          'PHASE_A1_SUBAGENT_BRIEF\n'
          + 'Objective: reply with SUBAGENT_OK\n'
          + 'Output format: one line\n'
          + 'Boundaries: no tools\n'
          + 'Done-when: printed SUBAGENT_OK',
      }, 'call_isolate')
    }
    return textReply('PARENT_DONE isolate')
  }

  if (/PHASE_A1_CHEAP_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        role: 'cheap',
        prompt:
          'PHASE_A1_SUBAGENT_BRIEF\n'
          + 'Objective: reply with SUBAGENT_OK\n'
          + 'Output format: one line\n'
          + 'Boundaries: no tools\n'
          + 'Done-when: printed SUBAGENT_OK',
      }, 'call_cheap')
    }
    return textReply('PARENT_DONE cheap')
  }

  if (/PHASE_A1_VACUOUS_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        prompt: 'should be refused without isolate/role/backend',
      }, 'call_vacuous')
    }
    // Parent sees the refused tool result and acknowledges.
    return textReply('PARENT_DONE vacuous-refused')
  }

  if (/PHASE_A1_CROSS_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'claude-code',
        prompt:
          'PHASE_A1_CROSS brief\n'
          + 'Objective: reply with any short ack\n'
          + 'Output format: one line\n'
          + 'Boundaries: none\n'
          + 'Done-when: any text',
      }, 'call_cross')
    }
    return textReply('PARENT_DONE cross-adapter')
  }

  if (/PHASE_A2_SERIAL_TEST/i.test(user)) {
    if (toolResults === 0) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        role: 'cheap',
        prompt:
          'PHASE_A1_SUBAGENT_BRIEF lane=cheap\n'
          + 'Objective: reply SUBAGENT_OK\n'
          + 'Output format: one line\n'
          + 'Boundaries: none\n'
          + 'Done-when: SUBAGENT_OK',
      }, 'call_a2_1')
    }
    if (toolResults === 1) {
      return toolCall('mcp__agim__call_agent', {
        agent: 'agim',
        isolate: true,
        prompt:
          'PHASE_A1_SUBAGENT_BRIEF lane=isolate\n'
          + 'Objective: reply SUBAGENT_OK\n'
          + 'Output format: one line\n'
          + 'Boundaries: none\n'
          + 'Done-when: SUBAGENT_OK',
      }, 'call_a2_2')
    }
    return textReply('PARENT_DONE serial-two-subagents')
  }

  if (/PHASE_B_PARALLEL_TEST/i.test(user)) {
    if (toolResults === 0) {
      const brief = (lane) => (
        `PHASE_B_SUBAGENT_SLOW lane=${lane}\n`
        + `Objective: reply SUBAGENT_OK SLOW for lane ${lane}\n`
        + 'Output format: one line\n'
        + 'Boundaries: do not write files\n'
        + 'Done-when: printed SUBAGENT_OK SLOW'
      )
      return toolCall('mcp__agim__call_agents', {
        tasks: [
          { agent: 'agim', isolate: true, prompt: brief('0') },
          { agent: 'agim', isolate: true, prompt: brief('1') },
          { agent: 'agim', role: 'cheap', prompt: brief('2') },
        ],
      }, 'call_agents_b')
    }
    return textReply('PARENT_DONE parallel-fanout')
  }

  // Default / A3 probe — answer without tools.
  if (/PHASE_A3_SIMPLE/i.test(user)) {
    return textReply('2')
  }

  return textReply(`MOCK_OK model=${model}`)
}

function writeSse(res, payload) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const choice = payload.choices[0]
  const msg = choice.message
  if (msg.tool_calls) {
    const tc = msg.tool_calls[0]
    res.write(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            index: 0,
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`)
    res.write(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })}\n\n`)
  } else {
    const text = msg.content || ''
    res.write(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })}\n\n`)
    res.write(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      requests: state.requests.length,
      peakSlow: state.peakSlow,
      slowHits: state.slowHits,
    }))
    return
  }
  if (req.method === 'GET' && req.url === '/__mock/log') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      requests: state.requests,
      peakSlow: state.peakSlow,
      slowHits: state.slowHits,
      liveSlow: state.liveSlow,
    }))
    return
  }
  if (req.method === 'POST' && req.url === '/__mock/reset') {
    state.requests = []
    state.rounds.clear()
    state.liveSlow = 0
    state.peakSlow = 0
    state.slowHits = 0
    writeFileSync(LOG, '', 'utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const user = lastUserText(messages)
    const slow = /PHASE_B_SUBAGENT_SLOW/i.test(user)
    if (slow) {
      state.liveSlow += 1
      state.slowHits += 1
      state.peakSlow = Math.max(state.peakSlow, state.liveSlow)
      await sleep(SLOW_MS)
      state.liveSlow = Math.max(0, state.liveSlow - 1)
    }
    const payload = decide(body)
    if (body.stream) {
      writeSse(res, payload)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }

  // Models list for some probes
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'mock-pro-model', object: 'model' },
        { id: 'mock-flash-model', object: 'model' },
      ],
    }))
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`)
  console.log(`[mock-llm] log ${LOG}`)
})
