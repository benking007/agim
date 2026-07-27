/**
 * Drive Agim web chat WS: for each sticky CLI agent, run call_agent + call_agents.
 * Writes JSON report under /opt/cursor/artifacts/cli-call-agents-matrix/
 */
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'fs'

const AGENTS = [
  'claude-code', 'codex', 'copilot', 'opencode', 'cursor',
  'kimi-code', 'qoder', 'pi', 'mimo', 'antigravity',
]
const OUT = '/opt/cursor/artifacts/cli-call-agents-matrix'
mkdirSync(OUT, { recursive: true })

function onceMessages(ws, predicate, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timeout ${timeoutMs}ms`))
    }, timeoutMs)
    function onMsg(buf) {
      let msg
      try { msg = JSON.parse(String(buf)) } catch { return }
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

function collectUntilDone(ws, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let doneText = ''
    let err = null
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting done; partial=${doneText.slice(0, 200)}`))
    }, timeoutMs)
    function onMsg(buf) {
      let msg
      try { msg = JSON.parse(String(buf)) } catch { return }
      if (msg.type === 'chunk' && msg.text) chunks.push(msg.text)
      if (msg.type === 'done') {
        doneText = msg.text || chunks.join('')
        cleanup()
        resolve({ ok: !err, text: doneText, error: err })
      }
      if (msg.type === 'error') {
        err = msg.message || 'error'
        // still wait for done sometimes
      }
    }
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMsg)
    }
    ws.on('message', onMsg)
  })
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj))
}

async function runOne(ws, agent, kind) {
  send(ws, { type: 'switch-agent', agent })
  await onceMessages(ws, (m) => m.type === 'agent-switched' && m.agent === agent, 15000).catch(() => {})
  // small settle
  await new Promise((r) => setTimeout(r, 200))
  const prompt = kind === 'batch'
    ? `CALL_AGENTS_TEST：请用 call_agents 两路 fan-out 派两个 agim 子代理`
    : `CALL_AGENT_TEST：请用 call_agent 派 agim 子代理回复 CALL_AGENT_OK`
  send(ws, { type: 'message', text: prompt })
  const result = await collectUntilDone(ws, 90000)
  const text = result.text || ''
  const passed = kind === 'batch'
    ? (/okCount\s*[:=]\s*2|"okCount":\s*2|两路|call_agents/i.test(text) && /"ok"\s*:\s*true|结论：okCount/i.test(text))
    : (/call_agent|CALL_AGENT_OK|单路派工成功|"ok"\s*:\s*true/i.test(text) && !/"ok"\s*:\s*false/.test(text.split('结论')[0] || text) || /单路派工成功/.test(text))
  // refine: require stub success markers
  const ok = kind === 'batch'
    ? /call_agents/i.test(text) && (/okCount.: 2|"okCount": 2|okCount=2/.test(text) || /"okCount":2/.test(text))
    : /call_agent/i.test(text) && (/"ok": true|"ok":true|单路派工成功/.test(text))
  return { agent, kind, ok, text: text.slice(0, 1500), error: result.error || null }
}

async function main() {
  const ws = new WebSocket('ws://127.0.0.1:3000/ws')
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await onceMessages(ws, (m) => m.type === 'init', 10000)
  send(ws, { type: 'new-conversation' })
  await onceMessages(ws, (m) => m.type === 'history', 10000).catch(() => {})

  const rows = []
  for (const agent of AGENTS) {
    console.log(`== ${agent} single ==`)
    try {
      const r = await runOne(ws, agent, 'single')
      rows.push(r)
      console.log(agent, 'single', r.ok ? 'PASS' : 'FAIL', r.text.slice(0, 120).replace(/\n/g, ' '))
    } catch (e) {
      rows.push({ agent, kind: 'single', ok: false, text: '', error: String(e) })
      console.log(agent, 'single FAIL', e.message)
    }
    await new Promise((r) => setTimeout(r, 7000)) // stay under default web rate 10/60s
    console.log(`== ${agent} batch ==`)
    try {
      const r = await runOne(ws, agent, 'batch')
      rows.push(r)
      console.log(agent, 'batch', r.ok ? 'PASS' : 'FAIL', r.text.slice(0, 120).replace(/\n/g, ' '))
    } catch (e) {
      rows.push({ agent, kind: 'batch', ok: false, text: '', error: String(e) })
      console.log(agent, 'batch FAIL', e.message)
    }
    // reset conversation between agents to avoid sticky session weirdness
    send(ws, { type: 'new-conversation' })
    await onceMessages(ws, (m) => m.type === 'history', 10000).catch(() => {})
    await new Promise((r) => setTimeout(r, 7000))
  }

  const summary = {
    at: new Date().toISOString(),
    total: rows.length,
    passed: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    rows,
  }
  writeFileSync(`${OUT}/matrix-report.json`, JSON.stringify(summary, null, 2))
  const md = [
    '# CLI call_agent / call_agents matrix',
    '',
    `| Agent | call_agent | call_agents |`,
    `|---|---|---|`,
    ...AGENTS.map((a) => {
      const s = rows.find((r) => r.agent === a && r.kind === 'single')
      const b = rows.find((r) => r.agent === a && r.kind === 'batch')
      return `| ${a} | ${s?.ok ? 'PASS' : 'FAIL'} | ${b?.ok ? 'PASS' : 'FAIL'} |`
    }),
    '',
    `Passed ${summary.passed}/${summary.total}`,
  ].join('\n')
  writeFileSync(`${OUT}/matrix-report.md`, md)
  console.log(md)
  ws.close()
  if (summary.failed) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
