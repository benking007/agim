#!/usr/bin/env node
const BASE = process.env.AGIM_BASE || 'http://127.0.0.1:3000'
const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json, text }
}

async function main() {
  {
    const r = await req('GET', '/api/health')
    log('GET /api/health', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json))
  }
  {
    const r = await req('GET', '/')
    log('GET / (SPA)', r.status === 200 && String(r.text).includes('id="root"'), `status=${r.status}`)
  }
  {
    const r = await req('GET', '/api/llm')
    const ok = r.status === 200 && r.json?.backends?.some((b) => b.name === 'mock-llm')
    log('GET /api/llm mock backend', ok, JSON.stringify(r.json?.backends?.map((b) => b.name)))
  }
  {
    const r = await req('GET', '/api/llm/presets')
    log('GET /api/llm/presets', r.status === 200 && r.json?.presets?.length >= 4, `n=${r.json?.presets?.length}`)
  }
  {
    const r = await req('GET', '/api/mcp')
    log('GET /api/mcp', r.status === 200, `status=${r.status}`)
  }
  {
    const r = await req('POST', '/api/llm/backends', {
      name: 'ssrf-public-probe',
      provider: 'openai-compat',
      baseUrl: 'https://example.com/v1',
      model: 'x',
      apiKey: 'k',
    })
    log('POST /api/llm/backends public URL', [200, 201, 409].includes(r.status), `status=${r.status}`)
    await req('DELETE', '/api/llm/backends/ssrf-public-probe')
  }
  {
    const r = await req('POST', '/api/llm/backends', {
      name: 'ssrf-file',
      provider: 'openai-compat',
      baseUrl: 'file:///etc/passwd',
      model: 'x',
      apiKey: 'k',
    })
    log('POST /api/llm/backends rejects file://', r.status >= 400, `status=${r.status}`)
  }
  {
    const r = await req('POST', '/api/mobile/qr', {})
    const url = r.json?.loginUrl || r.json?.url || ''
    const hasCode = typeof url === 'string' && (url.includes('?c=') || url.includes('?t='))
    log('POST /api/mobile/qr', r.status === 200 && hasCode, `status=${r.status} url=${url}`)
  }
  {
    const r = await req('POST', '/api/auth/exchange-mobile', { code: 'not-a-real-code' })
    log('POST /api/auth/exchange-mobile rejects bad code', r.status >= 400, `status=${r.status}`)
  }
  {
    const r = await req('GET', '/api/config')
    log('GET /api/config', r.status === 200, `status=${r.status}`)
  }
  {
    const r = await req('GET', '/api/agents/status')
    log('GET /api/agents/status', r.status === 200 && r.json?.agim === true, JSON.stringify(r.json))
  }
  {
    const r = await req('GET', '/m/login')
    log('GET /m/login', r.status === 200, `status=${r.status}`)
  }
  {
    const r = await req('GET', '/m/chat')
    log('GET /m/chat portal', r.status === 200, `status=${r.status}`)
  }

  await new Promise((resolve) => {
    const wsUrl = BASE.replace('http', 'ws') + '/ws'
    const ws = new WebSocket(wsUrl)
    const saw = []
    let done = false
    const finish = (ok, detail) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      log('WS chat mock turn', ok, detail)
      resolve()
    }
    const timer = setTimeout(() => finish(false, saw.slice(0, 20).join('|') || 'timeout'), 20000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'get-agents' }))
      ws.send(JSON.stringify({ type: 'message', text: '回归测试：请只回复 OK', agent: 'agim' }))
    })
    ws.addEventListener('message', (ev) => {
      const raw = String(ev.data)
      let msg
      try { msg = JSON.parse(raw) } catch { saw.push(raw.slice(0, 40)); return }
      saw.push(msg.type || msg.event || 'obj')
      const blob = JSON.stringify(msg)
      if (/mock|已收到/i.test(blob) || msg.type === 'done' || (msg.type === 'assistant' && msg.text)) {
        finish(true, `types=${saw.join(',')}`)
      }
    })
    ws.addEventListener('error', () => finish(false, 'ws error: ' + saw.join('|')))
  })

  const failed = results.filter((r) => !r.ok)
  console.log('\n---')
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
  if (failed.length) {
    for (const f of failed) console.log('FAIL_DETAIL', f)
    process.exit(1)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
