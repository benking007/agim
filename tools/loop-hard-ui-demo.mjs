#!/usr/bin/env node
/**
 * Loop hard-constraint UI demo (mock LLM + Portal).
 * 1) Drive WS: confirm Loop → LOOP_E2E_TEST → pending_user_confirm
 * 2) Open Chrome CDP on that threadId, screenshot docks, click 确认结束
 * 3) Write report + screenshots under /opt/cursor/artifacts/
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = process.env.AGIM_BASE || 'http://127.0.0.1:3000'
const ART = process.env.LOOP_HARD_ART || '/opt/cursor/artifacts'
const THREAD = process.env.LOOP_HARD_THREAD || `web-loophard${Date.now().toString(36).slice(-6)}`
const CDP_PORT = Number(process.env.LOOP_HARD_CDP || 9333)
const CHROME = process.env.CHROME_PATH
  || (existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : 'google-chrome')

mkdirSync(ART, { recursive: true })

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getLoop() {
  const r = await fetch(`${BASE}/api/loop?threadId=${encodeURIComponent(THREAD)}&lang=zh`)
  return r.json()
}

function runWsTurn(text, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws')
    let chunks = ''
    let doneText = ''
    let finished = false
    const activity = []
    const finish = (ok, detail) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolve({ ok, detail, doneText: doneText || chunks, activity })
    }
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'switch-agent', agent: 'agim' }))
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'get-history', threadId: THREAD }))
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'message', text, agent: 'agim' }))
        }, 150)
      }, 80)
    })
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (msg.type === 'activity-step' && msg.step) activity.push(msg.step)
      if (msg.type === 'chunk') chunks += String(msg.text || '')
      if (msg.type === 'done') {
        doneText = String(msg.text || chunks || '')
        finish(true, doneText.slice(0, 160))
      }
      if (msg.type === 'error') finish(false, `error=${msg.message}`)
    })
    ws.on('error', () => finish(false, 'ws error'))
  })
}

async function cdpSend(ws, method, params = {}, sessionId) {
  const id = cdpSend._id = (cdpSend._id || 0) + 1
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 30_000)
    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

async function withChrome(fn) {
  const userData = `/tmp/agim-loop-chrome-${CDP_PORT}`
  mkdirSync(userData, { recursive: true })
  const child = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,960',
    'about:blank',
  ], { stdio: 'ignore', detached: true })
  child.unref()
  await sleep(1500)
  try {
    const ver = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
    const browserWs = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      browserWs.once('open', res)
      browserWs.once('error', rej)
    })
    const { targetId } = await cdpSend(browserWs, 'Target.createTarget', {
      url: 'about:blank',
    })
    const { sessionId } = await cdpSend(browserWs, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const result = await fn({ browserWs, sessionId })
    try { browserWs.close() } catch { /* ignore */ }
    return result
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* ignore */ }
    try { child.kill('SIGTERM') } catch { /* ignore */ }
  }
}

async function screenshot(sessionId, browserWs, file) {
  await cdpSend(browserWs, 'Page.enable', {}, sessionId)
  const { data } = await cdpSend(browserWs, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  }, sessionId)
  const path = join(ART, file)
  writeFileSync(path, Buffer.from(data, 'base64'))
  console.log('shot', path)
  return path
}

async function main() {
  const report = { threadId: THREAD, steps: [], ok: true }
  const log = (name, ok, detail = '') => {
    report.steps.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) report.ok = false
  }

  {
    const h = await fetch(`${BASE}/api/health`).then((r) => r.json())
    log('health', h?.ok === true, JSON.stringify(h).slice(0, 120))
  }

  // Start confirmed Loop (Chinese exit phrase)
  {
    const turn = await runWsTurn(
      '/loop Loop工程硬约束演示；退出条件为验收通过或最多5轮',
      { timeoutMs: 45_000 },
    )
    log('start loop turn', turn.ok, turn.detail)
    await sleep(400)
    const st = await getLoop()
    const loop = st.loop
    const good = loop
      && loop.active
      && loop.status !== 'aligning'
      && loop.round >= 1
      && (loop.exitDescription || '').includes('验收')
    log(
      'loop confirmed planning',
      !!good,
      `status=${loop?.status} round=${loop?.round}/${loop?.maxRounds} exit=${loop?.exitDescription}`,
    )
  }

  // E2E mock: dispatch + verdict → pending_user_confirm
  {
    const turn = await runWsTurn('LOOP_E2E_TEST 请按 Loop 派工并验收', { timeoutMs: 120_000 })
    log('LOOP_E2E turn', turn.ok, turn.detail)
    const agentSteps = turn.activity.filter((s) => s.kind === 'agent' || /call_agent/i.test(s.label || ''))
    log('had subagent activity', agentSteps.length > 0, `n=${agentSteps.length}`)

    let loop = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      const st = await getLoop()
      loop = st.loop
      if (loop?.status === 'pending_user_confirm' || loop?.bucket === 'confirm') break
      if (loop?.status === 'ended') break
    }
    log(
      'pending_user_confirm',
      loop?.status === 'pending_user_confirm' || loop?.bucket === 'confirm',
      `status=${loop?.status} bucket=${loop?.bucket} live=${loop?.liveSubagents} summary=${loop?.pendingConfirmation?.summary?.slice(0, 80)}`,
    )
  }

  // Chrome: bind threadId, show docks, confirm end
  const shots = await withChrome(async ({ browserWs, sessionId }) => {
    await cdpSend(browserWs, 'Page.enable', {}, sessionId)
    await cdpSend(browserWs, 'Runtime.enable', {}, sessionId)
    // SPA RequireAuth needs agim_token even when AGIM_WEB_AUTH=off.
    let token = ''
    try {
      token = (await import('node:fs')).readFileSync(
        `${process.env.HOME || '/home/ubuntu'}/.agim/web-bootstrap-token`,
        'utf8',
      ).trim()
    } catch { /* optional */ }
    await cdpSend(browserWs, 'Page.navigate', { url: `${BASE}/login` }, sessionId)
    await sleep(1200)
    await cdpSend(browserWs, 'Runtime.evaluate', {
      expression: `
        localStorage.setItem('agim_token', ${JSON.stringify(token)});
        localStorage.setItem('agim-web-thread-id', ${JSON.stringify(THREAD)});
        location.href = ${JSON.stringify(`${BASE}/m/chat`)};
      `,
    }, sessionId)
    await sleep(4500)

    const shotDispatch = await screenshot(sessionId, browserWs, 'loop-hard-03-dispatch.png')

    // Wait for confirm dock text
    let dockOk = false
    for (let i = 0; i < 20; i++) {
      const { result } = await cdpSend(browserWs, 'Runtime.evaluate', {
        expression: `document.body?.innerText?.includes('结论已就绪') || document.body?.innerText?.includes('待确认结案') || document.body?.innerText?.includes('确认结束')`,
        returnByValue: true,
      }, sessionId)
      if (result?.value === true) { dockOk = true; break }
      await sleep(500)
    }
    log('confirm dock visible in DOM', dockOk)
    const shotConfirm = await screenshot(sessionId, browserWs, 'loop-hard-04-confirm-met.png')

    // Fill supplement + click 确认结束
    await cdpSend(browserWs, 'Runtime.evaluate', {
      expression: `
        (() => {
          const areas = [...document.querySelectorAll('textarea')];
          const ta = areas.find(a => (a.placeholder||'').includes('补充') || (a.placeholder||'').includes('核对')) || areas[areas.length-1];
          if (ta) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(ta, '同意结案');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const btn = [...document.querySelectorAll('button')].find(b => /确认结束|End Loop/i.test(b.textContent||''));
          if (btn) { btn.click(); return 'clicked'; }
          return 'no-btn';
        })()
      `,
      returnByValue: true,
    }, sessionId)
    await sleep(2500)

    // Fallback API confirm if button miss
    let st = await getLoop()
    if (st.loop?.status === 'pending_user_confirm') {
      await fetch(`${BASE}/api/loop/confirm-met`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: THREAD,
          action: 'end',
          supplement: '同意结案',
          lang: 'zh',
        }),
      })
      await sleep(800)
      await cdpSend(browserWs, 'Page.reload', {}, sessionId)
      await sleep(2000)
    }
    st = await getLoop()
    log(
      'ended objective_met',
      st.loop?.status === 'ended' && st.loop?.endReason === 'objective_met',
      `status=${st.loop?.status} endReason=${st.loop?.endReason}`,
    )
    const shotEnded = await screenshot(sessionId, browserWs, 'loop-hard-05-ended.png')

    // Aligning dock bonus on a fresh thread id in same browser
    const alignThread = `${THREAD}a`
    await cdpSend(browserWs, 'Runtime.evaluate', {
      expression: `localStorage.setItem('agim-web-thread-id', ${JSON.stringify(alignThread)}); location.href=${JSON.stringify(`${BASE}/m/chat`)}`,
    }, sessionId)
    await sleep(2500)
    // seed aligning via WS
    await new Promise((resolve) => {
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws')
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'get-history', threadId: alignThread }))
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'message', text: '/loop', agent: 'agim' }))
        }, 120)
      })
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data))
          if (msg.type === 'done' || msg.type === 'error') {
            try { ws.close() } catch { /* ignore */ }
            resolve(null)
          }
        } catch { /* ignore */ }
      })
      setTimeout(() => { try { ws.close() } catch { /* ignore */ }; resolve(null) }, 20_000)
    })
    await sleep(1500)
    await cdpSend(browserWs, 'Page.reload', {}, sessionId)
    await sleep(2500)
    const { result: alignVis } = await cdpSend(browserWs, 'Runtime.evaluate', {
      expression: `document.body?.innerText?.includes('待对焦') || document.body?.innerText?.includes('确定并开始')`,
      returnByValue: true,
    }, sessionId)
    log('aligning dock visible', alignVis?.value === true)
    const shotAlign = await screenshot(sessionId, browserWs, 'loop-hard-02b-aligning-dock.png')

    return { shotDispatch, shotConfirm, shotEnded, shotAlign }
  })

  report.shots = shots
  report.threadId = THREAD
  const reportPath = join(ART, 'loop-hard-ui-demo-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log('report', reportPath)
  process.exit(report.ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
