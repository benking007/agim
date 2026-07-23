// transcribe — focus on provider detection and the OpenAI HTTP path (with
// mocked fetch). whisper.cpp's spawn path is harder to test cleanly without
// a real binary; we lean on the type-system + manual verification for it.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_ROOT = join(tmpdir(), `agim-transcribe-test-${process.pid}`)

const {
  transcribe,
  detectProvider,
  listTranscribeProviders,
  sortProvidersForUi,
  TranscribeError,
} = await import('./transcribe.js')

const ENV_KEYS = [
  'AGIM_TRANSCRIBE_PROVIDER',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AGIM_OPENAI_TRANSCRIBE_MODEL',
  'AGIM_WHISPERCPP_BIN',
  'AGIM_WHISPERCPP_MODEL',
  'AGIM_WHISPERCPP_ARGS',
  'AGIM_BAIDU_SPEECH_API_KEY',
  'AGIM_BAIDU_SPEECH_SECRET_KEY',
  'AGIM_TENCENT_SECRET_ID',
  'AGIM_TENCENT_SECRET_KEY',
  'AGIM_IFLYTEK_APP_ID',
  'AGIM_IFLYTEK_API_KEY',
  'AGIM_IFLYTEK_API_SECRET',
  'AGIM_ZHIPU_API_KEY',
  'AGIM_ZHIPU_BASE_URL',
  'AGIM_ZHIPU_TRANSCRIBE_MODEL',
  'AGIM_MIMO_API_KEY',
  'MIMO_API_KEY',
  'AGIM_MIMO_BASE_URL',
  'AGIM_MIMO_TRANSCRIBE_MODEL',
]

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('transcribe — detectProvider', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })

  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('returns "none" when nothing is configured', () => {
    expect(detectProvider()).toBe('none')
  })

  it('honors explicit AGIM_TRANSCRIBE_PROVIDER', () => {
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'openai'
    expect(detectProvider()).toBe('openai')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'whispercpp'
    expect(detectProvider()).toBe('whispercpp')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'none'
    expect(detectProvider()).toBe('none')
  })

  it('falls back to openai when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(detectProvider()).toBe('openai')
  })

  it('falls back to whispercpp when bin + model are set', () => {
    process.env.AGIM_WHISPERCPP_BIN = '/usr/local/bin/whisper-cli'
    process.env.AGIM_WHISPERCPP_MODEL = '/models/ggml-base.bin'
    expect(detectProvider()).toBe('whispercpp')
  })

  it('honors explicit baidu / tencent / iflytek / glm / mimo', () => {
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'baidu'
    expect(detectProvider()).toBe('baidu')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'tencent'
    expect(detectProvider()).toBe('tencent')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'iflytek'
    expect(detectProvider()).toBe('iflytek')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'glm'
    expect(detectProvider()).toBe('glm')
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'mimo'
    expect(detectProvider()).toBe('mimo')
  })

  it('auto-picks any cloud provider before whispercpp fallback', () => {
    process.env.AGIM_BAIDU_SPEECH_API_KEY = 'ak'
    process.env.AGIM_BAIDU_SPEECH_SECRET_KEY = 'sk'
    process.env.AGIM_WHISPERCPP_BIN = '/usr/local/bin/whisper-cli'
    process.env.AGIM_WHISPERCPP_MODEL = '/models/ggml-base.bin'
    expect(detectProvider()).toBe('baidu')
  })

  it('auto-ranks Chinese cloud ahead of OpenAI (iflytek > tencent > baidu > mimo > glm > openai)', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.AGIM_ZHIPU_API_KEY = 'zhipu-key'
    expect(detectProvider()).toBe('glm')

    process.env.AGIM_MIMO_API_KEY = 'mimo-key'
    expect(detectProvider()).toBe('mimo')

    process.env.AGIM_BAIDU_SPEECH_API_KEY = 'ak'
    process.env.AGIM_BAIDU_SPEECH_SECRET_KEY = 'sk'
    expect(detectProvider()).toBe('baidu')

    process.env.AGIM_TENCENT_SECRET_ID = 'id'
    process.env.AGIM_TENCENT_SECRET_KEY = 'key'
    expect(detectProvider()).toBe('tencent')

    process.env.AGIM_IFLYTEK_APP_ID = 'app'
    process.env.AGIM_IFLYTEK_API_KEY = 'ak'
    process.env.AGIM_IFLYTEK_API_SECRET = 'sk'
    expect(detectProvider()).toBe('iflytek')
  })

  it('treats MIMO_API_KEY as configured for mimo', () => {
    process.env.MIMO_API_KEY = 'legacy-mimo'
    expect(detectProvider()).toBe('mimo')
  })

  it('explicit override wins over auto-detection', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'whispercpp'
    expect(detectProvider()).toBe('whispercpp')
  })

  it('ignores unknown explicit value and falls through to auto-detect', () => {
    process.env.AGIM_TRANSCRIBE_PROVIDER = 'garbage'
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(detectProvider()).toBe('openai')
  })
})

describe('transcribe — settings UI provider order', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })

  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('lists by auto priority when nothing is configured', () => {
    const { providers, active } = listTranscribeProviders()
    expect(active).toBe('none')
    expect(providers.map((p) => p.id)).toEqual([
      'iflytek', 'tencent', 'baidu', 'mimo', 'glm', 'openai', 'whispercpp',
    ])
  })

  it('puts active + other configured ahead of missing, preserving priority', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.AGIM_ZHIPU_API_KEY = 'zhipu-key'
    process.env.AGIM_MIMO_API_KEY = 'mimo-key'
    process.env.AGIM_BAIDU_SPEECH_API_KEY = 'ak'
    process.env.AGIM_BAIDU_SPEECH_SECRET_KEY = 'sk'
    process.env.AGIM_WHISPERCPP_BIN = '/usr/local/bin/whisper-cli'
    process.env.AGIM_WHISPERCPP_MODEL = '/models/ggml-base.bin'
    // auto → baidu (ahead of mimo / glm / openai / whispercpp)
    const { providers, active } = listTranscribeProviders()
    expect(active).toBe('baidu')
    expect(providers.map((p) => p.id)).toEqual([
      'baidu',      // active
      'mimo',
      'glm',
      'openai',
      'whispercpp', // configured fallback
      'iflytek',    // missing
      'tencent',    // missing
    ])
  })

  it('sortProvidersForUi keeps active first even when unconfigured flag flips', () => {
    const sorted = sortProvidersForUi(
      [
        { id: 'openai', label: 'o', envKeys: [], configured: true },
        { id: 'baidu', label: 'b', envKeys: [], configured: false },
        { id: 'iflytek', label: 'i', envKeys: [], configured: true },
      ],
      'baidu',
    )
    expect(sorted.map((p) => p.id)).toEqual(['baidu', 'iflytek', 'openai'])
  })
})

describe('transcribe — none provider raises clear error', () => {
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
  })
  afterEach(() => {
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('throws TranscribeError with helpful message', async () => {
    await expect(transcribe('/no/such/file')).rejects.toThrow(/no provider configured/)
  })
})

describe('transcribe — openai path with mocked fetch', () => {
  let originalFetch: typeof fetch
  let saved: Record<string, string | undefined>

  beforeAll(async () => {
    await mkdir(TEST_ROOT, { recursive: true })
  })
  afterAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
    process.env.OPENAI_API_KEY = 'sk-test'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('uploads via multipart/form-data, returns trimmed text on success', async () => {
    const audioPath = join(TEST_ROOT, 'sample.ogg')
    await writeFile(audioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53]))  // 'OggS'

    let capturedReq: Request | null = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedReq = new Request(input as string, init)
      return new Response(JSON.stringify({ text: '  hello world  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await transcribe(audioPath, { language: 'zh' })
    expect(result.text).toBe('hello world')
    expect(result.provider).toBe('openai')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)

    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.url).toContain('/audio/transcriptions')
    expect(capturedReq!.headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('honors OPENAI_BASE_URL for self-hosted gateways', async () => {
    const audioPath = join(TEST_ROOT, 'sample2.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'

    let capturedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = (input as Request | string).toString()
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch

    await transcribe(audioPath)
    expect(capturedUrl).toContain('gateway.example.com')
  })

  it('throws on HTTP non-2xx with status in message', async () => {
    const audioPath = join(TEST_ROOT, 'bad.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof fetch

    await expect(transcribe(audioPath)).rejects.toThrow(/HTTP 429/)
  })

  it('throws when response is missing text field', async () => {
    const audioPath = join(TEST_ROOT, 'weird.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 })) as unknown as typeof fetch

    await expect(transcribe(audioPath)).rejects.toThrow(/missing text/)
  })

  it('TranscribeError carries provider so callers can switch on it', async () => {
    const audioPath = join(TEST_ROOT, 'fail.ogg')
    await writeFile(audioPath, Buffer.from([0]))
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    try {
      await transcribe(audioPath)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(TranscribeError)
      expect((err as InstanceType<typeof TranscribeError>).provider).toBe('openai')
    }
  })
})

describe('transcribe — glm (Zhipu) path with mocked fetch', () => {
  let originalFetch: typeof fetch
  let saved: Record<string, string | undefined>
  let silenceWav = ''

  beforeAll(async () => {
    await mkdir(TEST_ROOT, { recursive: true })
    silenceWav = join(TEST_ROOT, 'silence.wav')
    // 0.2s of silence — ffmpeg input for convertToWav in the glm path.
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2',
      '-c:a', 'pcm_s16le', silenceWav,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`)
  })
  afterAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    originalFetch = globalThis.fetch
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
    process.env.AGIM_ZHIPU_API_KEY = 'zhipu-test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('posts to bigmodel transcriptions and returns text', async () => {
    let capturedReq: Request | null = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedReq = new Request(input as string, init)
      return new Response(JSON.stringify({ text: '  你好智谱  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await transcribe(silenceWav, { provider: 'glm' })
    expect(result.text).toBe('你好智谱')
    expect(result.provider).toBe('glm')
    expect(capturedReq!.url).toBe('https://open.bigmodel.cn/api/paas/v4/audio/transcriptions')
    expect(capturedReq!.headers.get('authorization')).toBe('Bearer zhipu-test-key')
    expect(capturedReq!.method).toBe('POST')
  })

  it('honors AGIM_ZHIPU_BASE_URL + model', async () => {
    process.env.AGIM_ZHIPU_BASE_URL = 'https://api.z.ai/api/paas/v4'
    process.env.AGIM_ZHIPU_TRANSCRIBE_MODEL = 'glm-asr-2512'
    let capturedUrl = ''
    let capturedModel = ''
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      const req = new Request(input as string, init)
      const form = await req.formData()
      capturedModel = String(form.get('model') ?? '')
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch

    await transcribe(silenceWav, { provider: 'glm' })
    expect(capturedUrl).toContain('api.z.ai')
    expect(capturedModel).toBe('glm-asr-2512')
  })
})

describe('transcribe — mimo path with mocked fetch', () => {
  let originalFetch: typeof fetch
  let saved: Record<string, string | undefined>
  let silenceWav = ''

  beforeAll(async () => {
    await mkdir(TEST_ROOT, { recursive: true })
    silenceWav = join(TEST_ROOT, 'mimo-silence.wav')
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2',
      '-c:a', 'pcm_s16le', silenceWav,
    ], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`)
  })
  afterAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    originalFetch = globalThis.fetch
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    clearEnv()
    process.env.AGIM_MIMO_API_KEY = 'mimo-test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearEnv()
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it('posts chat/completions with input_audio and returns content', async () => {
    let capturedReq: Request | null = null
    let capturedBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedReq = new Request(input as string, init)
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{ message: { content: '  小米你好  ' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await transcribe(silenceWav, { provider: 'mimo', language: 'zh' })
    expect(result.text).toBe('小米你好')
    expect(result.provider).toBe('mimo')
    expect(capturedReq!.url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(capturedReq!.headers.get('authorization')).toBe('Bearer mimo-test-key')
    expect(capturedReq!.headers.get('api-key')).toBe('mimo-test-key')
    expect(capturedBody!.model).toBe('mimo-v2.5-asr')
    expect((capturedBody!.asr_options as { language: string }).language).toBe('zh')
    const messages = capturedBody!.messages as Array<{ content: Array<{ input_audio: { data: string } }> }>
    expect(messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true)
  })
})
