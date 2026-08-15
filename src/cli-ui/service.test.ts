import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = join(tmpdir(), `agim-service-test-${process.pid}`)
process.env.AGIM_HOME = TMP_OWN

const { AGIM_HOME } = await import('../core/agim-paths.js')
const {
  _internal: serviceInternal,
  PID_FILE,
  LOG_FILE,
  LOG_REDIRECTED_ENV,
  ensureServiceLogMirror,
  readWebEndpoint,
} = await import('./service.js')
const { _internal, cmdStatus, cmdWeb } = await import('./cmd-handlers.js')

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(AGIM_HOME, { recursive: true })
  writeFileSync(join(AGIM_HOME, 'config.json'), JSON.stringify(cfg, null, 2))
}

beforeEach(() => {
  delete process.env.AGIM_WEB_BIND
  delete process.env.AGIM_WEB_AUTH
  delete process.env.AGIM_TRUST_LOOPBACK
  delete process.env.AGIM_VIEWER_PUBLIC_BASE_URL
  delete process.env.AGIM_VIEWER_TUNNEL_MODE
  delete process.env.AGIM_VIEWER_ENABLED
  delete process.env[LOG_REDIRECTED_ENV]
  serviceInternal.setDetectServiceOverride(null)
  serviceInternal.resetServiceLogMirrorForTests()
  rmSync(AGIM_HOME, { recursive: true, force: true })
  mkdirSync(AGIM_HOME, { recursive: true })
})

afterEach(() => {
  serviceInternal.resetServiceLogMirrorForTests()
  delete process.env[LOG_REDIRECTED_ENV]
})

async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const oldLog = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.log = oldLog
  }
  return lines.join('\n')
}

describe('readWebEndpoint', () => {
  it('reads the current top-level webPort config shape', () => {
    writeConfig({ webPort: 3456 })
    expect(readWebEndpoint()).toEqual({ bind: '127.0.0.1', port: 3456 })
  })

  it('keeps supporting legacy nested web.port configs', () => {
    writeConfig({ web: { bind: '0.0.0.0', port: 4567 } })
    expect(readWebEndpoint()).toEqual({ bind: '0.0.0.0', port: 4567 })
  })

  it('uses AGIM_WEB_BIND from the env file when present', () => {
    writeConfig({ webPort: 3456 })
    writeFileSync(join(AGIM_HOME, 'env'), 'AGIM_WEB_BIND=0.0.0.0\n')
    expect(readWebEndpoint()).toEqual({ bind: '0.0.0.0', port: 3456 })
  })
})

describe('cmdWeb', () => {
  it('prints the local console URL even without a public viewer URL', async () => {
    writeConfig({ webPort: 3333 })
    const out = await captureStdout(async () => {
      const code = await cmdWeb({ welcome: true })
      expect(code).toBe(0)
    })
    expect(out).toContain('Agim Web')
    expect(out).toContain('http://127.0.0.1:3333/?welcome=1')
  })

  it('keeps a public URL mode for reverse-proxy/tunnel scripts', async () => {
    writeFileSync(join(AGIM_HOME, 'env'), 'AGIM_VIEWER_PUBLIC_BASE_URL=https://agim.example.test\n')
    const out = await captureStdout(async () => {
      const code = await cmdWeb({ public: true })
      expect(code).toBe(0)
    })
    expect(out).toContain('https://agim.example.test')
    expect(out).toContain('AGIM_VIEWER_PUBLIC_BASE_URL')
  })

  it('does not open a browser when the local service is not running', async () => {
    serviceInternal.setDetectServiceOverride(() => ({ mode: 'none', pid: null }))
    let opened = ''
    const out = await captureStdout(async () => {
      const code = await cmdWeb({
        open: true,
        openBrowser: (url) => {
          opened = url
          return true
        },
      })
      expect(code).toBe(0)
    })
    expect(opened).toBe('')
    expect(out).toContain('agim web --start --open')
    expect(out.includes('服务未运行') || out.includes('Service:not running')).toBe(true)
  })

  it('opens the local console URL when the service is running', async () => {
    writeConfig({ webPort: 3333 })
    writeFileSync(PID_FILE, `${process.pid}\n`)
    serviceInternal.setDetectServiceOverride(() => ({ mode: 'background', pid: process.pid }))
    let opened = ''
    const out = await captureStdout(async () => {
      const code = await cmdWeb({
        open: true,
        openBrowser: (url) => {
          opened = url
          return true
        },
      })
      expect(code).toBe(0)
    })
    expect(opened).toBe('http://127.0.0.1:3333')
    expect(
      out.includes('浏览器：已打开 http://127.0.0.1:3333')
      || out.includes('Browser: opened http://127.0.0.1:3333'),
    ).toBe(true)
  })
})

describe('browserOpenCommand', () => {
  it('selects the platform browser opener without shell interpolation', () => {
    expect(_internal.browserOpenCommand('http://127.0.0.1:3000', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:3000'],
    })
    expect(_internal.browserOpenCommand('http://127.0.0.1:3000', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:3000'],
    })
    expect(_internal.browserOpenCommand('http://127.0.0.1:3000', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:3000'],
    })
  })
})

describe('cmdStatus', () => {
  it('keeps the user on the main path when the service is not running', async () => {
    serviceInternal.setDetectServiceOverride(() => ({ mode: 'none', pid: null }))
    const out = await captureStdout(() => cmdStatus())
    expect(out).toContain('http://127.0.0.1:3000')
    expect(out).toContain('agim go')
    expect(out).toContain('agim start --bg')
  })
})

describe('ensureServiceLogMirror', () => {
  it('creates ~/.agim/agim.log when missing', () => {
    expect(existsSync(LOG_FILE)).toBe(false)
    ensureServiceLogMirror()
    expect(existsSync(LOG_FILE)).toBe(true)
    expect(readFileSync(LOG_FILE, 'utf-8')).toContain('[agim] service log opened')
  })

  it('mirrors stdout into agim.log when not redirected', async () => {
    ensureServiceLogMirror()
    const marker = `ops-log-mirror-${Date.now()}`
    process.stdout.write(`${marker}\n`)
    // Give the write stream a tick to flush the buffered chunk.
    await new Promise((r) => setTimeout(r, 20))
    expect(readFileSync(LOG_FILE, 'utf-8')).toContain(marker)
  })

  it('creates the file but does not tee when AGIM_LOG_REDIRECTED=1', async () => {
    process.env[LOG_REDIRECTED_ENV] = '1'
    ensureServiceLogMirror()
    expect(existsSync(LOG_FILE)).toBe(true)
    expect(readFileSync(LOG_FILE, 'utf-8')).toContain('[agim] service log opened')
    const marker = `ops-log-no-tee-${Date.now()}`
    process.stdout.write(`${marker}\n`)
    await new Promise((r) => setTimeout(r, 20))
    expect(readFileSync(LOG_FILE, 'utf-8')).not.toContain(marker)
  })
})
