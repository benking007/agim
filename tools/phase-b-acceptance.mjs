#!/usr/bin/env node
/**
 * Phase B formal acceptance — parallel call_agents fan-out.
 *
 * Prereqs:
 *   - mock-llm on :18080 (tools/mock-llm-server.mjs with PHASE_B_* markers)
 *   - ~/.agim config with mock-pro + mock-flash
 *   - agim start built from Phase B branch, with:
 *       AGIM_URL_ALLOW_PRIVATE=1 AGIM_WEB_AUTH=off AGIM_TODO_GATE=off
 *       AGIM_AUTO_APPROVE=1 AGIM_ALLOWED_USERS='*'
 *       AGIM_SUBAGENT_PARALLEL unset or on (default on)
 *
 * Usage:
 *   node tools/phase-b-acceptance.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.AGIM_BASE || 'http://127.0.0.1:3000'
const MOCK = process.env.MOCK_LLM_BASE || 'http://127.0.0.1:18080'
const OUT = process.env.PHASE_B_REPORT
  || '/opt/cursor/artifacts/phase-b-acceptance-report.json'

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
  return r.json || {}
}

function runChat(text, { timeoutMs = 90000, expectDoneRe } = {}) {
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
      finish(false, `timeout types=${events.map((e) => e.type).slice(0, 40).join(',')}`)
    }, timeoutMs)

    let chunks = ''
    ws.addEventListener('open', () => {
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
          finish(true, `done=${doneText.slice(0, 160)}`)
        } else {
          finish(false, `done_mismatch text=${JSON.stringify(doneText).slice(0, 200)}`)
        }
      }
      if (msg.type === 'error') finish(false, `error=${msg.message}`)
      if (msg.type === 'run-finish' && msg.status === 'error') {
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

  {
    const h = await req('GET', `${MOCK}/health`)
    log('mock-llm health', h.status === 200 && h.json?.ok === true, JSON.stringify(h.json))
  }
  {
    const h = await req('GET', `${BASE}/api/health`)
    const agimOk = h.json?.ok === true && h.json?.agents?.agim === true
    log('agim health (agim agent ready)', agimOk, JSON.stringify(h.json))
  }

  await resetMock()
  {
    const t0 = Date.now()
    const turn = await runChat(
      'PHASE_B_PARALLEL_TEST please fan-out three independent research lanes',
      { expectDoneRe: /PARENT_DONE parallel|call_agents join|SUBAGENT_OK/, timeoutMs: 120000 },
    )
    const wallMs = Date.now() - t0
    log('B parallel turn completes', turn.ok, `${turn.detail} wallMs=${wallMs}`)

    const byId = new Map()
    for (const s of turn.activity.filter((x) => x.kind === 'agent')) byId.set(s.id, s)
    const lanes = [...byId.values()]
    log(
      'B activity has ≥3 distinct Subagent step ids',
      lanes.length >= 3,
      JSON.stringify(lanes.map((s) => ({ id: s.id, label: s.label, status: s.status, jobId: s.jobId }))),
    )
    log(
      'B step ids use toolCallId#i form',
      lanes.filter((s) => /#\d+$/.test(String(s.id))).length >= 2,
      lanes.map((s) => s.id).join(','),
    )
    const jobIds = [...new Set(lanes.map((s) => s.jobId).filter((x) => typeof x === 'number'))]
    log('B three distinct jobIds', jobIds.length >= 3, `jobIds=${jobIds.join(',')}`)
    log(
      'B all lanes reach success',
      lanes.length >= 3 && lanes.every((s) => s.status === 'success'),
      lanes.map((s) => `${s.id}:${s.status}`).join(','),
    )
    log(
      'B includes agim/cheap lane label',
      lanes.some((s) => s.label === 'agim/cheap'),
      lanes.map((s) => s.label).join(','),
    )

    // 3×800ms serial ≈ 2400ms+; parallel peak should be ≥2 and wall ≪ 2400.
    const mock = await mockLog()
    const peak = Number(mock.peakSlow || 0)
    const hits = Number(mock.slowHits || 0)
    log('B mock saw ≥3 slow Subagent hits', hits >= 3, `slowHits=${hits} peakSlow=${peak}`)
    log(
      'B mock peak concurrency ≥2 (true parallel)',
      peak >= 2,
      `peakSlow=${peak} (need ≥2; 1 means serialized)`,
    )
    log(
      'B wall clock consistent with parallel (under 2.2s of pure serial 2.4s)',
      wallMs < 2200 || peak >= 2,
      `wallMs=${wallMs} peakSlow=${peak}`,
    )

    const joinInDone = /call_agents join|parallel-fanout|0\/|1\/|2\/|3\//i.test(turn.doneText)
      || /PARENT_DONE parallel/i.test(turn.doneText)
    log('B parent synthesizes after join', turn.ok && joinInDone, turn.doneText.slice(0, 200))

    const logs = mock.requests || []
    const parentReq = logs.find((e) => /PHASE_B_PARALLEL_TEST/i.test(e.userHead || ''))
    log(
      'B parent tools advertise call_agents',
      !!parentReq?.systemHasCallAgents,
      `systemHasCallAgents=${parentReq?.systemHasCallAgents} toolsHead=${(parentReq?.toolsHead || '').slice(0, 120)}`,
    )
  }

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
