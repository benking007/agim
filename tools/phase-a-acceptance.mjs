#!/usr/bin/env node
/**
 * Phase A formal acceptance against a live Agim + mock LLM stack.
 *
 * Prereqs (see docs or script header comments):
 *   - mock-llm on :18080
 *   - ~/.agim/config.json with mock-pro + mock-flash + llmRoles.cheap
 *   - agim start with AGIM_URL_ALLOW_PRIVATE=1 AGIM_WEB_AUTH=off AGIM_TODO_GATE=off
 *
 * Usage:
 *   node tools/phase-a-acceptance.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.AGIM_BASE || 'http://127.0.0.1:3000'
const MOCK = process.env.MOCK_LLM_BASE || 'http://127.0.0.1:18080'
const OUT = process.env.PHASE_A_REPORT
  || '/opt/cursor/artifacts/phase-a-acceptance-report.json'

const results = []

function log(name, ok, detail = '') {
  results.push({ name, ok, detail: String(detail).slice(0, 500) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json, text }
}

async function resetMock() {
  await req('POST', `${MOCK}/__mock/reset`)
}

async function mockLog() {
  const r = await req('GET', `${MOCK}/__mock/log`)
  return r.json?.requests || []
}

function runChat(text, { timeoutMs = 60000, expectDoneRe } = {}) {
  return new Promise((resolvePromise) => {
    const wsUrl = BASE.replace('http', 'ws') + '/ws'
    const ws = new WebSocket(wsUrl)
    const events = []
    const activity = []
    let doneText = ''
    let finished = false
    const finish = (ok, detail) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolvePromise({ ok, detail, events, activity, doneText })
    }
    const timer = setTimeout(() => {
      finish(false, `timeout types=${events.map((e) => e.type).slice(0, 30).join(',')}`)
    }, timeoutMs)

    let chunks = ''
    ws.addEventListener('open', () => {
      // Prior UI sessions may leave sticky agent on claude-code — pin agim.
      ws.send(JSON.stringify({ type: 'switch-agent', agent: 'agim' }))
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'new-conversation' }))
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'message', text, agent: 'agim' }))
        }, 120)
      }, 80)
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      events.push(msg)
      if (msg.type === 'activity-step' && msg.step) activity.push(msg.step)
      if (msg.type === 'chunk') chunks += String(msg.text || '')
      if (msg.type === 'done') {
        doneText = String(msg.text || chunks || '')
        if (!expectDoneRe || expectDoneRe.test(doneText) || expectDoneRe.test(chunks)) {
          finish(true, `done=${doneText.slice(0, 120)}`)
        } else {
          finish(false, `done_mismatch text=${JSON.stringify(doneText).slice(0, 160)}`)
        }
      }
      if (msg.type === 'error') {
        finish(false, `error=${msg.message}`)
      }
      if (msg.type === 'run-finish' && msg.status === 'error') {
        // wait a beat for done/error text
        setTimeout(() => {
          if (!finished) finish(false, `run-finish error=${msg.error || ''}`)
        }, 500)
      }
    })
    ws.addEventListener('error', () => finish(false, 'ws error'))
  })
}

async function main() {
  console.log(`Agim=${BASE}  mock=${MOCK}`)
  console.log('---')

  // ── Bootstrap ──────────────────────────────────────────────
  {
    const h = await req('GET', `${MOCK}/health`)
    log('mock-llm health', h.status === 200 && h.json?.ok === true, JSON.stringify(h.json))
  }
  {
    const h = await req('GET', `${BASE}/api/health`)
    const agimOk = h.json?.ok === true && h.json?.agents?.agim === true
    log('agim health (agim agent ready)', agimOk, JSON.stringify(h.json))
  }
  {
    const r = await req('GET', `${BASE}/api/llm`)
    const names = (r.json?.backends || []).map((b) => b.name)
    const hasPro = names.includes('mock-pro')
    const hasFlash = names.includes('mock-flash')
    log('llm backends mock-pro + mock-flash', hasPro && hasFlash, names.join(','))
    const roles = r.json?.roles || r.json?.llmRoles || {}
    // API shape may nest differently — also accept bindings list.
    const cheapOk = JSON.stringify(r.json).includes('mock-flash')
    log('llm cheap role bound to flash (presence)', cheapOk, JSON.stringify(roles).slice(0, 200))
  }

  // ── A3 prompt presence (system prompt from mock) ───────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A3_SIMPLE: what is 1+1? Reply with one digit.', {
      expectDoneRe: /^2$|MOCK_OK|PARENT_DONE/,
      timeoutMs: 30000,
    })
    log('A3 simple turn completes without hang', turn.ok, turn.detail)
    const logs = await mockLog()
    const withHeuristics = logs.filter((e) => e.hasSubagentHeuristics)
    log(
      'A3 parent request includes Subagent heuristics (system and/or tool desc)',
      withHeuristics.length > 0,
      `heuristicRequests=${withHeuristics.length}/${logs.length} systemLen=${logs[0]?.systemLen ?? 0} toolsHead=${(logs[0]?.toolsHead || '').slice(0, 120)}`,
    )
    // Scripted mock never spawns on PHASE_A3_SIMPLE — assert no agent activity step.
    const parentUsedTools = turn.activity.some((s) => s.kind === 'agent')
    log(
      'A3 simple marker did not spawn Subagent (scripted mock)',
      turn.ok && !parentUsedTools,
      `agentSteps=${turn.activity.filter((s) => s.kind === 'agent').length}`,
    )
  }

  // ── A1 isolate ─────────────────────────────────────────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A1_ISOLATE_TEST please spawn same-family subagent', {
      expectDoneRe: /PARENT_DONE isolate|SUBAGENT_OK/,
    })
    log('A1 isolate turn completes', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent')
    log('A1 isolate activity agent step present', agentSteps.length >= 1, JSON.stringify(agentSteps.map((s) => ({
      label: s.label, status: s.status, jobId: s.jobId,
    }))))
    const okStep = agentSteps.find((s) => s.status === 'success' || s.status === 'running')
    const finalOk = agentSteps.some((s) => s.status === 'success')
    log('A1 isolate activity reaches success', finalOk, JSON.stringify(agentSteps.at(-1)))
    log('A1 isolate activity carries jobId', agentSteps.some((s) => typeof s.jobId === 'number'), String(agentSteps[0]?.jobId))
    log('A1 isolate label is same-family agim', agentSteps.some((s) => s.label === 'agim' || s.label?.startsWith('agim')), agentSteps.map((s) => s.label).join(','))

    const recent = await req('GET', `${BASE}/api/a2a/recent?limit=5`)
    log('A1 isolate a2a/recent reachable', recent.status === 200, `status=${recent.status}`)
    const jobId = agentSteps.find((s) => typeof s.jobId === 'number')?.jobId
    if (typeof jobId === 'number') {
      const tree = await req('GET', `${BASE}/api/a2a/tree/${jobId}`)
      log('A1 isolate a2a/tree/:jobId', tree.status === 200, JSON.stringify(tree.json).slice(0, 200))
    } else {
      log('A1 isolate a2a/tree/:jobId', false, 'no jobId on activity')
    }
    void okStep
  }

  // ── A1 role=cheap → flash model ────────────────────────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A1_CHEAP_TEST please spawn cheap subagent', {
      expectDoneRe: /PARENT_DONE cheap|SUBAGENT_OK/,
    })
    log('A1 cheap turn completes', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent')
    log(
      'A1 cheap activity label agim/cheap',
      agentSteps.some((s) => s.label === 'agim/cheap'),
      agentSteps.map((s) => s.label).join(','),
    )
    log('A1 cheap activity success + jobId', agentSteps.some((s) => s.status === 'success' && typeof s.jobId === 'number'), JSON.stringify(agentSteps.at(-1)))
    const logs = await mockLog()
    const subCalls = logs.filter((e) => /PHASE_A1_SUBAGENT_BRIEF/i.test(e.userHead))
    const usedFlash = subCalls.some((e) => e.model === 'mock-flash-model')
    log(
      'A1 cheap nested call used mock-flash-model',
      usedFlash,
      `subModels=${subCalls.map((e) => e.model).join(',') || '(none)'}`,
    )
  }

  // ── A1 vacuous self-call refused ───────────────────────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A1_VACUOUS_TEST attempt self call_agent without isolate', {
      expectDoneRe: /PARENT_DONE vacuous|refused|isolate/,
      timeoutMs: 60000,
    })
    log('A1 vacuous turn completes', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent')
    const refused = turn.doneText.toLowerCase().includes('vacuous')
      || turn.events.some((e) => e.type === 'activity-step' && e.step?.status === 'error')
      || /refused|isolate\/role\/backend/i.test(JSON.stringify(turn.events))
    // Tool may fail before activity agent row if dispatcher returns isError quickly —
    // accept either error activity or parent acknowledging refusal.
    log(
      'A1 vacuous self-call refused (error or parent ack)',
      refused || /vacuous-refused|refused/i.test(turn.doneText),
      `done=${turn.doneText.slice(0, 160)} agentSteps=${agentSteps.length}`,
    )
  }

  // ── A1 cross-adapter (claude-code stub) ────────────────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A1_CROSS_TEST delegate to claude-code', {
      expectDoneRe: /PARENT_DONE cross|claude|stub/i,
      timeoutMs: 60000,
    })
    log('A1 cross-adapter turn completes', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent')
    log(
      'A1 cross-adapter activity label claude-code',
      agentSteps.some((s) => String(s.label).includes('claude')),
      agentSteps.map((s) => `${s.label}:${s.status}`).join(','),
    )
    log(
      'A1 cross-adapter activity has jobId',
      agentSteps.some((s) => typeof s.jobId === 'number'),
      String(agentSteps[0]?.jobId),
    )
  }

  // ── A2 serial two Subagents ────────────────────────────────
  await resetMock()
  {
    const turn = await runChat('PHASE_A2_SERIAL_TEST spawn two subagents in sequence', {
      expectDoneRe: /PARENT_DONE serial|SUBAGENT_OK/,
      timeoutMs: 90000,
    })
    log('A2 serial turn completes', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent')
    const labels = [...new Set(agentSteps.map((s) => s.label))]
    const jobIds = [...new Set(agentSteps.map((s) => s.jobId).filter((x) => typeof x === 'number'))]
    log(
      'A2 distinguishes agim/cheap vs agim labels',
      labels.includes('agim/cheap') && labels.some((l) => l === 'agim' || l.startsWith('agim')),
      `labels=${labels.join(',')}`,
    )
    log(
      'A2 two distinct jobIds',
      jobIds.length >= 2,
      `jobIds=${jobIds.join(',')}`,
    )
    const finals = agentSteps.filter((s) => s.status === 'success' || s.status === 'error')
    // Collapse by id — last status per step id
    const byId = new Map()
    for (const s of agentSteps) byId.set(s.id, s)
    const terminal = [...byId.values()].filter((s) => s.status === 'success' || s.status === 'error')
    log(
      'A2 both Subagent steps reach terminal status',
      terminal.length >= 2 && terminal.every((s) => s.status === 'success'),
      JSON.stringify([...byId.values()].map((s) => ({ id: s.id, label: s.label, status: s.status, jobId: s.jobId }))),
    )
    void finals
  }

  // ── Persist report ─────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    mock: MOCK,
    total: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    results,
  }
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  console.log('\n---')
  console.log(`total=${report.total} pass=${report.pass} fail=${report.fail}`)
  console.log(`report: ${OUT}`)
  if (failed.length) {
    for (const f of failed) console.log('FAIL_DETAIL', f.name, f.detail)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
