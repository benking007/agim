#!/usr/bin/env node
/** Capture Portal Loop docks for a seeded pending_user_confirm thread. */
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:3000'
const ART = '/opt/cursor/artifacts'
const CHROME = '/usr/bin/google-chrome-stable'
const TOKEN = readFileSync(`${process.env.HOME}/.agim/web-bootstrap-token`, 'utf8').trim()
mkdirSync(ART, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runWsTurn(threadId, text, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws')
    let chunks = '', done = '', finished = false
    const finish = (ok, detail) => {
      if (finished) return
      finished = true
      clearTimeout(t)
      try { ws.close() } catch { /* ignore */ }
      resolve({ ok, detail, done: done || chunks })
    }
    const t = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'switch-agent', agent: 'agim' }))
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'get-history', threadId }))
        setTimeout(() => ws.send(JSON.stringify({ type: 'message', text, agent: 'agim' })), 120)
      }, 60)
    })
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.type === 'chunk') chunks += String(msg.text || '')
      if (msg.type === 'done') { done = String(msg.text || chunks || ''); finish(true, done.slice(0, 100)) }
      if (msg.type === 'error') finish(false, msg.message)
    })
    ws.on('error', () => finish(false, 'ws error'))
  })
}

async function getLoop(threadId) {
  return (await fetch(`${BASE}/api/loop?threadId=${encodeURIComponent(threadId)}&lang=zh`)).json()
}

async function main() {
  const threadId = `web-loophard${Date.now().toString(36).slice(-6)}`
  console.log('thread', threadId)

  let t = await runWsTurn(threadId, '/loop Loop工程硬约束演示；退出条件为验收通过或最多5轮', 45_000)
  console.log('start', t.ok, t.detail)
  t = await runWsTurn(threadId, 'LOOP_E2E_TEST 请按 Loop 派工并验收', 120_000)
  console.log('e2e', t.ok, t.detail)

  let loop
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    loop = (await getLoop(threadId)).loop
    if (loop?.status === 'pending_user_confirm') break
  }
  console.log('loop', loop?.status, loop?.bucket, loop?.pendingConfirmation?.summary?.slice(0, 80))
  if (loop?.status !== 'pending_user_confirm') {
    throw new Error('expected pending_user_confirm')
  }

  const headed = process.env.LOOP_HARD_HEADED === '1'
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: headed ? false : true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,960'],
    defaultViewport: { width: 1440, height: 960 },
  })
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.evaluate((token, tid) => {
    localStorage.setItem('agim_token', token)
    localStorage.setItem('agim-web-thread-id', tid)
  }, TOKEN, threadId)
  await page.goto(`${BASE}/m/chat`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await sleep(2500)

  // Wait for confirm dock
  await page.waitForFunction(
    () => /结论已就绪|待确认结案|确认结束/.test(document.body.innerText || ''),
    { timeout: 20_000 },
  ).catch(() => null)

  const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 500))
  console.log('bodyHead', body.replace(/\s+/g, ' ').slice(0, 240))

  await page.screenshot({ path: join(ART, 'loop-hard-04-confirm-met.png'), fullPage: false })
  console.log('shot confirm')

  // Fill supplement + click confirm
  const clicked = await page.evaluate(() => {
    const areas = [...document.querySelectorAll('textarea')]
    const ta = areas.find((a) => /补充|核对/.test(a.placeholder || '')) || areas[0]
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(ta, '同意结案')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /确认结束|End Loop/i.test(b.textContent || ''))
    btn?.click()
    return !!btn
  })
  console.log('clickedConfirm', clicked)
  if (!clicked) {
    await fetch(`${BASE}/api/loop/confirm-met`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, action: 'end', supplement: '同意结案', lang: 'zh' }),
    })
  }
  await sleep(2000)
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(1500)
  await page.screenshot({ path: join(ART, 'loop-hard-05-ended.png'), fullPage: false })
  console.log('shot ended')
  loop = (await getLoop(threadId)).loop
  console.log('final', loop?.status, loop?.endReason)

  // Aligning dock
  const alignThread = `${threadId}a`
  await runWsTurn(alignThread, '/loop', 30_000)
  await page.evaluate((tid) => {
    localStorage.setItem('agim-web-thread-id', tid)
  }, alignThread)
  await page.goto(`${BASE}/m/chat`, { waitUntil: 'networkidle2' })
  await sleep(2500)
  await page.waitForFunction(
    () => /待对焦|确定并开始/.test(document.body.innerText || ''),
    { timeout: 15_000 },
  ).catch(() => null)
  await page.screenshot({ path: join(ART, 'loop-hard-02b-aligning-dock.png'), fullPage: false })
  console.log('shot aligning')

  // Portal ready
  await page.screenshot({ path: join(ART, 'loop-hard-01-portal-ready.png'), fullPage: false })

  // Re-seed a planning+dispatch view for screenshot 03: start confirmed loop only
  const dThread = `${threadId}d`
  await runWsTurn(dThread, '/loop Loop工程硬约束演示；退出条件为验收通过或最多5轮', 45_000)
  await page.evaluate((tid) => {
    localStorage.setItem('agim-web-thread-id', tid)
  }, dThread)
  await page.goto(`${BASE}/m/chat`, { waitUntil: 'networkidle2' })
  await sleep(2500)
  await page.screenshot({ path: join(ART, 'loop-hard-03-dispatch.png'), fullPage: false })
  console.log('shot dispatch/planning')

  await browser.close()

  writeFileSync(join(ART, 'loop-hard-ui-demo-report.json'), JSON.stringify({
    ok: loop?.endReason === 'objective_met',
    threadId,
    endReason: loop?.endReason,
    shots: [
      'loop-hard-01-portal-ready.png',
      'loop-hard-02b-aligning-dock.png',
      'loop-hard-03-dispatch.png',
      'loop-hard-04-confirm-met.png',
      'loop-hard-05-ended.png',
    ],
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
