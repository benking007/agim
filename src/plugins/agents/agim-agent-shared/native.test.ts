// Unit tests for the native AgentAdapter.
//
// Strategy: stub the LLM registry by configuring a fake OpenAI-compat
// backend whose fetch is mocked, then call the adapter's sendPrompt and
// assert on the AsyncGenerator output + describeNativeAgent banner.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { describeNativeAgent, buildSystemPrompt, readOperatorRole, readWorkspaceMemory, isWorkspaceTrusted } from './index.js'
import { nativeAgentAdapter } from '../agim-agent/factory.js'
import { invalidateSkillsCache } from '../../../core/skills/loader.js'
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
  'AGIM_NATIVE_AGENT_ROLE',
  'AGIM_NATIVE_AGENT_MODE',
  'AGIM_NATIVE_AGENT_AUTOALLOW',
  'AGIM_NATIVE_AGENT_DENYLIST',
  // v1.2.119 — keep blank-retry out of these legacy adapter tests
  // so assertions on the recorded messages array stay stable. The
  // blank-retry path is exercised in agent-loop-blank-retry.test.ts.
  'AGIM_NATIVE_BLANK_RETRY_MAX',
  'AGIM_SKILLS_MODE',
  'AGIM_SKILLS_WORKSPACE_DIR',
  'AGIM_SKILLS_BUILTIN_DIR',
  'AGIM_SKILLS_INJECTION_OVERRIDE_PATH',
  'AGIM_NATIVE_TRUST_WORKSPACE',
  envKeyForBackend('native-mock'),
]

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  // v1.2.119 — disable intra-loop blank-retry for this suite (see
  // ENV_KEYS comment above).
  process.env.AGIM_NATIVE_BLANK_RETRY_MAX = '0'
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

beforeEach(clearAll)
afterEach(clearAll)

describe('nativeAgentAdapter — identity', () => {
  it('exposes name=agim + sensible aliases (incl. legacy native)', () => {
    expect(nativeAgentAdapter.name).toBe('agim')
    expect(nativeAgentAdapter.aliases).toContain('native')
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

  it('returns true when backend exists and llmRoles is empty', async () => {
    saveSecret('native-mock', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
      llmRoles: {},
    })
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('falls back to any configured backend when no default role is bound', async () => {
    // Configure only a custom role. Native should still be available now
    // because role bindings are optional and it can fall back to any backend.
    saveSecret('native-mock', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
      llmRoles: { 'custom-role': 'native-mock' },
    })
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('AGIM_NATIVE_AGENT_ROLE env override still works', async () => {
    saveSecret('native-mock', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
      llmRoles: { 'custom-role': 'native-mock' },
    })
    process.env.AGIM_NATIVE_AGENT_ROLE = 'custom-role'
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })
})

// A minimal provider stub — buildSystemPrompt only reads providerType + name.
const stubProvider = { providerType: 'stub', name: 'stub-backend' } as unknown as LlmProvider

describe('buildSystemPrompt — Agim Skills injection', () => {
  let dir = ''
  let overridePath = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agim-skills-cap-'))
    overridePath = join(dir, 'skill-injection-override.md')
    process.env.AGIM_SKILLS_MODE = 'agim-only'
    process.env.AGIM_SKILLS_WORKSPACE_DIR = dir
    process.env.AGIM_SKILLS_BUILTIN_DIR = join(dir, '__no_builtins__')
    process.env.AGIM_SKILLS_INJECTION_OVERRIDE_PATH = overridePath
    invalidateSkillsCache()
  })
  afterEach(() => {
    delete process.env.AGIM_SKILLS_MODE
    delete process.env.AGIM_SKILLS_WORKSPACE_DIR
    delete process.env.AGIM_SKILLS_BUILTIN_DIR
    invalidateSkillsCache()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('uses the operator-authored injection override in the native system prompt', () => {
    mkdirSync(join(dir, 'auto-noise'), { recursive: true })
    writeFileSync(
      join(dir, 'auto-noise', 'SKILL.md'),
      '---\nname: auto-noise\ndescription: auto text must be suppressed by override\n---\nbody\n',
    )
    writeFileSync(overridePath, '## Operator curated\n- curated-only: must be injected.\n', 'utf-8')
    invalidateSkillsCache()
    const prompt = buildSystemPrompt(stubProvider, 'native-chat', dir)
    expect(prompt).toContain('Agim Skills system-prompt injection')
    expect(prompt).toContain('Operator curated')
    expect(prompt).toContain('curated-only: must be injected')
    expect(prompt).not.toContain('auto text must be suppressed')
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
    delete process.env.AGIM_NATIVE_AGENT_ROLE_FILE
  })
  afterEach(() => {
    delete process.env.AGIM_NATIVE_AGENT_ROLE_FILE
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

  it('AGIM_NATIVE_AGENT_ROLE_FILE forces a single file, bypassing the hierarchy', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'PROJECT should be ignored')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'LOCAL should be ignored')
    const pinned = join(dir, 'pinned-role.md')
    writeFileSync(pinned, 'PINNED role only')
    process.env.AGIM_NATIVE_AGENT_ROLE_FILE = pinned
    const role = readOperatorRole(dir)
    expect(role).toContain('PINNED role only')
    expect(role).not.toContain('PROJECT should be ignored')
    expect(role).not.toContain('LOCAL should be ignored')
  })
})

describe('readOperatorRole — workspace trust gate (T6)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agim-role-trust-'))
    delete process.env.AGIM_NATIVE_AGENT_ROLE_FILE
    delete process.env.AGIM_NATIVE_TRUST_WORKSPACE
  })
  afterEach(() => {
    delete process.env.AGIM_NATIVE_AGENT_ROLE_FILE
    delete process.env.AGIM_NATIVE_TRUST_WORKSPACE
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('default is trusted → workspace role files are injected', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'WORKSPACE ROLE')
    expect(isWorkspaceTrusted()).toBe(true)
    expect(readOperatorRole(dir)).toContain('WORKSPACE ROLE')
  })

  it('untrusted workspace skips ALL discovered role files', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'SHOULD NOT LEAK')
    writeFileSync(join(dir, 'AGENTS.local.md'), 'ALSO NOT')
    process.env.AGIM_NATIVE_TRUST_WORKSPACE = 'off'
    expect(isWorkspaceTrusted()).toBe(false)
    expect(readOperatorRole(dir)).toBe('')
  })

  it('an explicit pinned role file is honoured even when the workspace is untrusted', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'discovered should be skipped')
    const pinned = join(dir, 'pinned.md')
    writeFileSync(pinned, 'OPERATOR PINNED ROLE')
    process.env.AGIM_NATIVE_TRUST_WORKSPACE = '0'
    process.env.AGIM_NATIVE_AGENT_ROLE_FILE = pinned
    const role = readOperatorRole(dir)
    expect(role).toContain('OPERATOR PINNED ROLE')
    expect(role).not.toContain('discovered should be skipped')
  })
})

describe('readWorkspaceMemory — MEMORY.md consumption', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agim-workspace-memory-'))
    delete process.env.AGIM_NATIVE_TRUST_WORKSPACE
  })
  afterEach(() => {
    delete process.env.AGIM_NATIVE_TRUST_WORKSPACE
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reads root MEMORY.md as operator-maintained long-term context', () => {
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n用户喜欢短句。')
    expect(readWorkspaceMemory(dir)).toContain('用户喜欢短句')
  })

  it('injects MEMORY.md into the native system prompt', () => {
    writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n项目叫 Agim。')
    const prompt = buildSystemPrompt(stubProvider, 'native-chat', dir)
    expect(prompt).toContain('[workspace memory: MEMORY.md]')
    expect(prompt).toContain('项目叫 Agim')
  })

  it('skips MEMORY.md when the workspace is not trusted', () => {
    writeFileSync(join(dir, 'MEMORY.md'), 'SHOULD NOT LEAK')
    process.env.AGIM_NATIVE_TRUST_WORKSPACE = 'off'
    expect(readWorkspaceMemory(dir)).toBe('')
    const prompt = buildSystemPrompt(stubProvider, 'native-chat', dir)
    expect(prompt).not.toContain('SHOULD NOT LEAK')
  })

  it('reads AGENTS.md / MEMORY.md from constraintRoot, not the selected cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'agim-constraint-root-'))
    const selected = mkdtempSync(join(tmpdir(), 'agim-selected-cwd-'))
    try {
      writeFileSync(join(root, 'AGENTS.md'), 'ROOT ROLE: stay at workspace root')
      writeFileSync(join(root, 'MEMORY.md'), 'ROOT MEMORY: prefer short answers')
      writeFileSync(join(selected, 'AGENTS.md'), 'CHILD ROLE: should not inject')
      writeFileSync(join(selected, 'MEMORY.md'), 'CHILD MEMORY: should not inject')
      const prompt = buildSystemPrompt(stubProvider, 'native-chat', selected, undefined, root)
      expect(prompt).toContain('ROOT ROLE: stay at workspace root')
      expect(prompt).toContain('ROOT MEMORY: prefer short answers')
      expect(prompt).not.toContain('CHILD ROLE')
      expect(prompt).not.toContain('CHILD MEMORY')
      expect(prompt).toContain(`Working directory: ${selected}`)
      expect(prompt).toContain(`Workspace root:    ${root}`)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
      try { rmSync(selected, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

describe('buildSystemPrompt — tool-call discipline (v1.2.147)', () => {
  const stub = { providerType: 'stub', name: 'stub-backend' } as unknown as LlmProvider

  it('injects the framework-level tool-call discipline by default', () => {
    delete process.env.AGIM_NATIVE_TOOL_DISCIPLINE
    const prompt = buildSystemPrompt(stub, 'native-chat', '/tmp/agim-no-such-cwd')
    expect(prompt).toContain('[agim framework rule — tool-call discipline]')
    expect(prompt).toContain('工具调用纪律')
    // Specific high-value rules must survive into the prompt verbatim:
    expect(prompt).toContain('禁止用文本')
    expect(prompt).toContain('不要假装调用了又没调')
    expect(prompt).toContain('禁止编造')
  })

  it('places discipline BEFORE the operator role so framework rule dominates', () => {
    delete process.env.AGIM_NATIVE_TOOL_DISCIPLINE
    const dir = mkdtempSync(join(tmpdir(), 'agim-role-order-'))
    try {
      writeFileSync(join(dir, 'AGENTS.md'), 'You are Persona X. Custom rule: be quirky.')
      const prompt = buildSystemPrompt(stub, 'native-chat', dir)
      const disciplineIdx = prompt.indexOf('[agim framework rule — tool-call discipline]')
      const roleIdx = prompt.indexOf('[operator role definition]')
      expect(disciplineIdx).toBeGreaterThanOrEqual(0)
      expect(roleIdx).toBeGreaterThan(disciplineIdx)
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('omits discipline block when AGIM_NATIVE_TOOL_DISCIPLINE=off', () => {
    process.env.AGIM_NATIVE_TOOL_DISCIPLINE = 'off'
    try {
      const prompt = buildSystemPrompt(stub, 'native-chat', '/tmp/agim-no-such-cwd')
      expect(prompt).not.toContain('[agim framework rule — tool-call discipline]')
      expect(prompt).not.toContain('工具调用纪律')
    } finally {
      delete process.env.AGIM_NATIVE_TOOL_DISCIPLINE
    }
  })

  it('treats unrecognized env values (e.g. "yes") as ON', () => {
    process.env.AGIM_NATIVE_TOOL_DISCIPLINE = 'yes'
    try {
      const prompt = buildSystemPrompt(stub, 'native-chat', '/tmp/agim-no-such-cwd')
      expect(prompt).toContain('[agim framework rule — tool-call discipline]')
    } finally {
      delete process.env.AGIM_NATIVE_TOOL_DISCIPLINE
    }
  })
})

describe('buildSystemPrompt — Subagent delegation heuristics (Phase A3)', () => {
  const stub = { providerType: 'stub', name: 'stub-backend' } as unknown as LlmProvider
  it('includes decompose heuristics + synthesize-dont-delegate guidance', () => {
    const prompt = buildSystemPrompt(stub, 'native-chat', '/tmp/agim-no-such-cwd')
    expect(prompt).toContain('Subagent delegation')
    expect(prompt).toContain('call_agents')
    expect(prompt).toMatch(/Brief four-piece/)
    expect(prompt).toMatch(/delegate first/i)
    expect(prompt).toMatch(/Live preferred picks/)
    expect(prompt).not.toMatch(/use native tools first/i)
    expect(prompt).not.toMatch(/do not spawn for trivial/i)
    expect(prompt).toMatch(/do not parallel-write/i)
    expect(prompt).toMatch(/Synthesize, don't delegate understanding/)
    expect(prompt).toMatch(/same-family/)
    expect(prompt).toMatch(/When YOU are a Subagent/)
    expect(prompt).toMatch(/absolute path/i)
    expect(prompt).toMatch(/见上文/)
  })
})

describe('buildSystemPrompt — IM / bgjob SOP', () => {
  const stub = { providerType: 'stub', name: 'stub-backend' } as unknown as LlmProvider
  it('includes IM reply shape and bgjob long-task guidance', async () => {
    const { AGIM_BGJOB_WRAPPER_EXPR } = await import('../../../core/agent-cwd.js')
    const prompt = buildSystemPrompt(stub, 'native-chat', '/tmp/agim-no-such-cwd')
    expect(prompt).toContain('IM reply shape')
    expect(prompt).toContain('Long-task / bgjob')
    expect(prompt).toContain(`${AGIM_BGJOB_WRAPPER_EXPR} start`)
    expect(prompt).not.toMatch(/\/home\/[^/\s]+\/\.agim/)
    expect(prompt).toMatch(/>10m MUST use bgjob/)
    expect(prompt).toMatch(/file-only replies are forbidden/)
    expect(prompt).toMatch(/见上文输出/)
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
