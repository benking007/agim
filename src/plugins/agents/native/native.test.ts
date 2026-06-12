// Unit tests for the native AgentAdapter.
//
// Strategy: stub the LLM registry by configuring a fake OpenAI-compat
// backend whose fetch is mocked, then call the adapter's sendPrompt and
// assert on the AsyncGenerator output + describeNativeAgent banner.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { nativeAgentAdapter, describeNativeAgent, buildSystemPrompt, readOperatorRole } from './index.js'
import { invalidateSkillsCache, MAX_INJECTED_SKILLS } from '../../../core/skills/loader.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmProvider } from '../../../core/llm/index.js'
import {
  loadFromConfig,
  _resetRegistry,
} from '../../../core/llm/index.js'
import {
  saveSecret,
  envKeyForBackend,
  LLM_SECRETS_PATH,
} from '../../../core/llm/secrets.js'
import { existsSync, unlinkSync } from 'node:fs'

const ORIGINAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  'IMHUB_NATIVE_AGENT_ROLE',
  'IMHUB_NATIVE_AGENT_MODE',
  'IMHUB_NATIVE_AGENT_AUTOALLOW',
  'IMHUB_NATIVE_AGENT_DENYLIST',
  // v1.2.119 — keep blank-retry out of these legacy adapter tests
  // so assertions on the recorded messages array stay stable. The
  // blank-retry path is exercised in agent-loop-blank-retry.test.ts.
  'IMHUB_NATIVE_BLANK_RETRY_MAX',
  envKeyForBackend('native-mock'),
]

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  // v1.2.119 — disable intra-loop blank-retry for this suite (see
  // ENV_KEYS comment above).
  process.env.IMHUB_NATIVE_BLANK_RETRY_MAX = '0'
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  _resetRegistry()
  globalThis.fetch = ORIGINAL_FETCH
}

function configureBackend(role: string = 'native-chat'): void {
  saveSecret('native-mock', 'sk-test')
  loadFromConfig({
    llmBackends: [{
      name: 'native-mock', provider: 'openai-compat', model: 'gpt-4.1-mini',
    }],
    llmRoles: { [role]: 'native-mock' },
  })
}

function makeChatResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function collect(g: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const c of g) out.push(c)
  return out
}

beforeEach(clearAll)
afterEach(clearAll)

describe('nativeAgentAdapter — identity', () => {
  it('exposes name=native + sensible aliases', () => {
    expect(nativeAgentAdapter.name).toBe('native')
    expect(nativeAgentAdapter.aliases).toContain('llm')
    expect(nativeAgentAdapter.aliases).toContain('na')
  })
})

describe('nativeAgentAdapter — isAvailable', () => {
  it('returns false when no LLM backend is registered', async () => {
    loadFromConfig({})
    expect(await nativeAgentAdapter.isAvailable()).toBe(false)
  })

  it('returns true when native-chat role is configured', async () => {
    configureBackend('native-chat')
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('returns true when only cheap role is configured (fallback)', async () => {
    configureBackend('cheap')
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('honours IMHUB_NATIVE_AGENT_ROLE env override', async () => {
    // Configure a 'custom-role' backend; without env, fallback chain
    // skips it. With env, it becomes the preferred role.
    saveSecret('native-mock', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
      llmRoles: { 'custom-role': 'native-mock' },
    })
    expect(await nativeAgentAdapter.isAvailable()).toBe(false)
    process.env.IMHUB_NATIVE_AGENT_ROLE = 'custom-role'
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })
})

describe('nativeAgentAdapter — sendPrompt', () => {
  it('with no backend: yields a helpful error and stops', async () => {
    loadFromConfig({})
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'hi'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('no LLM backend')
  })

  it('with a backend: yields the LLM text as a single chunk', async () => {
    configureBackend()
    globalThis.fetch = (async () => makeChatResponse('hello from native')) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'say hi'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('hello from native')
  })

  it('threads history into the LLM messages array', async () => {
    configureBackend()
    let seenMessages: Array<{ role: string; content: string }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>
      }
      seenMessages = body.messages
      return makeChatResponse('reply')
    }) as unknown as typeof fetch

    await collect(nativeAgentAdapter.sendPrompt(
      'sess',
      'next question',
      [
        { role: 'user', content: 'first', timestamp: new Date() },
        { role: 'assistant', content: 'first answer', timestamp: new Date() },
      ],
    ))

    // First message is the synthetic system prompt (injected by the
    // provider's system= option). Then history. Then the new user msg.
    expect(seenMessages[0].role).toBe('system')
    expect(seenMessages[1].role).toBe('user')
    expect(seenMessages[1].content).toBe('first')
    expect(seenMessages[2].role).toBe('assistant')
    expect(seenMessages[2].content).toBe('first answer')
    expect(seenMessages[3].role).toBe('user')
    expect(seenMessages[3].content).toBe('next question')
  })

  it('skips empty history entries', async () => {
    configureBackend()
    let seenMessages: Array<{ role: string; content: string }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>
      }
      seenMessages = body.messages
      return makeChatResponse('ok')
    }) as unknown as typeof fetch

    await collect(nativeAgentAdapter.sendPrompt(
      'sess',
      'q',
      [
        { role: 'user', content: '', timestamp: new Date() },
        { role: 'assistant', content: 'a', timestamp: new Date() },
      ],
    ))
    // Roles after system + user-prompt
    const nonSystem = seenMessages.filter((m) => m.role !== 'system')
    expect(nonSystem).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q' },
    ])
  })

  it('handles provider HTTP error gracefully', async () => {
    configureBackend()
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'x'))
    expect(chunks[0]).toMatch(/native agent error/i)
  })

  it('renders a structured recap when the model returns empty text', async () => {
    // v1.2.91 — replaced the legacy "(empty response)" banner with a
    // recap that lists what got done + suggests continuation paths.
    // When zero tool calls preceded the empty turn we expect the
    // "没说话也没动工具" branch.
    configureBackend()
    globalThis.fetch = (async () => makeChatResponse('')) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'x'))
    expect(chunks[0]).toMatch(/没说话/)
    // Should suggest at least one continuation option.
    expect(chunks[0]).toMatch(/继续|切到别的智能体/)
  })

  it('propagates costUsd to opts.onUsage', async () => {
    configureBackend()
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0042 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    let seenCost: number | undefined
    await collect(nativeAgentAdapter.sendPrompt('sess', 'x', [], {
      onUsage: (delta) => { seenCost = delta.costUsd },
    }))
    expect(seenCost).toBeCloseTo(0.0042, 6)
  })
})

// A minimal provider stub — buildSystemPrompt only reads providerType + name.
const stubProvider = { providerType: 'stub', name: 'stub-backend' } as unknown as LlmProvider

describe('buildSystemPrompt — skills listing is bounded (T3)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agim-skills-cap-'))
    process.env.IMHUB_SKILLS_MODE = 'agim-only'
    process.env.IMHUB_SKILLS_WORKSPACE_DIR = dir
    process.env.IMHUB_SKILLS_BUILTIN_DIR = join(dir, '__no_builtins__')
    invalidateSkillsCache()
  })
  afterEach(() => {
    delete process.env.IMHUB_SKILLS_MODE
    delete process.env.IMHUB_SKILLS_WORKSPACE_DIR
    delete process.env.IMHUB_SKILLS_BUILTIN_DIR
    invalidateSkillsCache()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('caps the system-prompt skills block at MAX_INJECTED_SKILLS and shows "+N more"', () => {
    const total = MAX_INJECTED_SKILLS + 5
    for (let i = 0; i < total; i++) {
      const name = `skill-${String(i).padStart(3, '0')}`
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(
        join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: does thing ${i}\n---\nbody\n`,
      )
    }
    invalidateSkillsCache()
    const prompt = buildSystemPrompt(stubProvider, 'native-chat', dir)
    const shownLines = prompt.split('\n').filter((l) => /^\s+- skill-\d+:/.test(l))
    expect(shownLines.length).toBe(MAX_INJECTED_SKILLS)
    expect(prompt).toContain(`… and ${total - MAX_INJECTED_SKILLS} more`)
    // The overflow skills must NOT be listed inline.
    expect(prompt).not.toContain('skill-034:')
  })
})

describe('readOperatorRole — memoized + mtime/size invalidation (T1)', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agim-role-cache-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('returns "" when AGENTS.md is absent', () => {
    expect(readOperatorRole(dir)).toBe('')
  })

  it('reads, then serves the same content on repeat (cache hit)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'You are the ops bot. Be terse.')
    const first = readOperatorRole(dir)
    expect(first).toContain('ops bot')
    expect(readOperatorRole(dir)).toBe(first)
  })

  it('invalidates when the file changes (different size + mtime)', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'role one')
    expect(readOperatorRole(dir)).toContain('role one')
    await new Promise((r) => setTimeout(r, 10))
    writeFileSync(join(dir, 'AGENTS.md'), 'a completely different and longer role definition v2')
    const updated = readOperatorRole(dir)
    expect(updated).toContain('longer role definition v2')
    expect(updated).not.toContain('role one')
  })
})

describe('readOperatorRole — project + local hierarchy (T4, local wins)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agim-role-hier-'))
    delete process.env.IMHUB_NATIVE_AGENT_ROLE_FILE
  })
  afterEach(() => {
    delete process.env.IMHUB_NATIVE_AGENT_ROLE_FILE
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('concatenates project then local, with local LAST (most model attention)', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'PROJECT ROLE: be terse')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'LOCAL OVERRIDE: always reply in English')
    const role = readOperatorRole(dir)
    expect(role).toContain('PROJECT ROLE')
    expect(role).toContain('LOCAL OVERRIDE')
    // local must appear after project so it wins on conflicting guidance
    expect(role.indexOf('LOCAL OVERRIDE')).toBeGreaterThan(role.indexOf('PROJECT ROLE'))
  })

  it('local-only is still injected when no project file exists', () => {
    writeFileSync(join(dir, 'AGENTS.local.md'), 'LOCAL ONLY role')
    expect(readOperatorRole(dir)).toContain('LOCAL ONLY role')
  })

  it('IMHUB_NATIVE_AGENT_ROLE_FILE forces a single file, bypassing the hierarchy', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'PROJECT should be ignored')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'LOCAL should be ignored')
    const pinned = join(dir, 'pinned-role.md')
    writeFileSync(pinned, 'PINNED role only')
    process.env.IMHUB_NATIVE_AGENT_ROLE_FILE = pinned
    const role = readOperatorRole(dir)
    expect(role).toContain('PINNED role only')
    expect(role).not.toContain('PROJECT should be ignored')
    expect(role).not.toContain('LOCAL should be ignored')
  })
})

describe('describeNativeAgent — banner', () => {
  it('reports NOT CONFIGURED when no backend', () => {
    loadFromConfig({})
    expect(describeNativeAgent()).toContain('NOT CONFIGURED')
  })

  it('reports backend name + policy when configured', () => {
    configureBackend()
    const banner = describeNativeAgent()
    expect(banner).toContain('backend=native-mock')
    expect(banner).toContain('role=native-chat')
    expect(banner).toContain('mode=allow-list')
  })
})
