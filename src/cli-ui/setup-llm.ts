// setup-llm — interactive wizard for adding / editing native LLM
// backends (Stage 4 of the nanobot vs agim comparison plan).
//
// Why this exists: editing `~/.agim/config.json` by hand to set up
// `llmBackends` + `llmRoles` + secrets is a multi-file dance:
//
//   1. add an entry to `config.json` `llmBackends` with the right
//      provider / model / baseUrl shape
//   2. decide which roles (cheap / evaluator / native-chat / custom)
//      should target the new backend and update `llmRoles`
//   3. save the API key to `~/.agim/llm-secrets.json` with 0600
//      permissions (or set the equivalent env var)
//
// This wizard walks the operator through all three in one go and
// validates the result by ROUNDTRIPPING through configSchema before
// writing. Cancel-safe at every prompt — Ctrl-C / empty answer aborts
// without touching disk.
//
// Invoked as `agim setup llm` (or `agim setup llm add`, `agim setup
// llm role`, etc. — subcommands documented in cli.ts).

import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { configSchema } from '../core/config-schema.js'
import { CONFIG_FILE, readConfigObject, updateConfigObject } from '../core/config-store.js'
import { saveSecret, removeSecret, listConfiguredBackends, describeSecretSource } from '../core/llm/secrets.js'
import {
  DEFAULT_LLM_PRESET,
  LLM_PRESETS,
  presetBackendStem,
  suggestLlmBackendName as suggestSharedBackendName,
} from '../core/llm/presets.js'
import { QuickEnableError, quickEnableLlmPreset } from '../core/llm/quick-enable.js'

/** All roles we currently inject into. New roles can be invented
 *  ad-hoc (the schema allows any string), but the wizard surfaces the
 *  blessed three by default. */
const KNOWN_ROLES = ['cheap', 'evaluator', 'native-chat'] as const

class SetupLlmConfigError extends Error {}

/** Curated provider quick-picks — shared with Web via core/llm/presets. */
const PROVIDER_PRESETS = LLM_PRESETS.map((p) => ({
  key: p.key,
  label: p.label,
  provider: p.provider,
  baseUrl: p.baseUrl,
  modelHint: p.model,
  apiKeyDoc: p.apiKeyDoc ?? '',
}))

interface RawLlmBackend {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  apiKeyEnv?: string
  costPer1kIn?: number
  costPer1kOut?: number
  maxRetries?: number
  timeoutMs?: number
}

interface RawConfig {
  llmBackends?: RawLlmBackend[]
  llmRoles?: Record<string, string>
  [k: string]: unknown
}

/** Top-level entry point. Subcommand-dispatching shell — keeps the
 *  wizard branches small + testable in isolation. */
export async function runSetupLlm(argv: string[]): Promise<number> {
  const sub = (argv[0] || '').toLowerCase()
  try {
    if (sub === '' || sub === 'help' || sub === '-h' || sub === '--help') return showHelp()
    if (sub === 'list' || sub === 'ls') return await listAction()
    if (sub === 'quick' || sub === 'enable') return await quickAction(argv.slice(1))
    if (sub === 'add')                  return await addAction()
    if (sub === 'remove' || sub === 'rm') return await removeAction(argv[1])
    if (sub === 'role' || sub === 'roles') return await roleAction()
    if (sub === 'secret') return await secretAction(argv[1])
    if (sub === 'native-enable' || sub === 'enable-native') {
      return await nativeEnableAction(argv[1])
    }
    return showHelp(`unknown subcommand: ${sub}`)
  } catch (err) {
    process.stderr.write(`\n❌ wizard failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function showHelp(error?: string): number {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stdout.write(`
agim setup llm — manage native LLM backends interactively.

Subcommands:
  list                  show configured backends and role bindings
  quick [--preset <k>]  one-shot: paste API key → enable Agim Agent
                        (default preset: DeepSeek / deepseek-v4-pro)
  add                   add a new backend (provider preset → name → model → API key → role binding)
  remove [<name>]       remove a backend (also clears the API key)
  role                  edit role → backend mapping (cheap / evaluator / native-chat / custom)
  secret <name>         (re)set the API key for an existing backend
  native-enable [<name>] one-walk wizard: bind native-chat role + cheap (optional)
                        + defaultAgent: 'agim' so the in-process agent is the
                        default backend for unrouted IM traffic

Notes:
  · Default Agim Agent preset is DeepSeek (deepseek-v4-pro). Other vendors
    are selectable via \`quick --preset <key>\` or \`add\`.
  · Backends live in ~/.agim/config.json under "llmBackends".
  · Role bindings live in the same file under "llmRoles".
  · API keys live in ~/.agim/llm-secrets.json (0600). The env var
    AGIM_LLM_SECRET_<UPPER_NAME> overrides what's on disk.
`)
  return error ? 1 : 0
}

/** `agim setup llm quick` — paste key, enable DeepSeek (or other preset). */
async function quickAction(argv: string[]): Promise<number> {
  let presetKey: string = DEFAULT_LLM_PRESET.key
  let apiKeyArg = ''
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--preset' || a === '-p') {
      presetKey = (argv[++i] || '').trim() || presetKey
      continue
    }
    if (a === '--api-key' || a === '-k') {
      apiKeyArg = (argv[++i] || '').trim()
      continue
    }
    if (!a.startsWith('-') && !apiKeyArg) {
      apiKeyArg = a.trim()
    }
  }

  const rl = readline()
  try {
    process.stdout.write('\n── agim setup llm quick ──\n')
    process.stdout.write(`Default preset: ${DEFAULT_LLM_PRESET.label} (${DEFAULT_LLM_PRESET.model})\n`)
    process.stdout.write('Available presets:\n')
    PROVIDER_PRESETS.forEach((p, i) => {
      const mark = p.key === presetKey ? ' ← selected' : ''
      process.stdout.write(`  ${i + 1}. ${p.label} [${p.key}]${mark}\n`)
    })
    const choice = (await ask(rl, `Preset [Enter=${presetKey} / 1-${PROVIDER_PRESETS.length} / key]: `)).trim()
    if (choice) {
      const asIdx = parseInt(choice, 10) - 1
      if (Number.isFinite(asIdx) && asIdx >= 0 && asIdx < PROVIDER_PRESETS.length) {
        presetKey = PROVIDER_PRESETS[asIdx].key
      } else if (PROVIDER_PRESETS.some((p) => p.key === choice)) {
        presetKey = choice as typeof presetKey
      } else {
        return cancel(`unknown preset: ${choice}`)
      }
    }
    const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey) ?? PROVIDER_PRESETS[0]
    if (preset.apiKeyDoc) {
      process.stdout.write(`(API key: get one at ${preset.apiKeyDoc})\n`)
    }
    let apiKey = apiKeyArg
    if (!apiKey) {
      apiKey = (await ask(rl, 'Paste API key: ', { silent: true })).trim()
    }
    if (!apiKey) return cancel('API key is required')

    let baseUrl = preset.baseUrl
    let model = preset.modelHint
    if (!baseUrl) {
      baseUrl = (await ask(rl, 'Base URL (e.g. https://api.example.com/v1): ')).trim()
      if (!baseUrl) return cancel('empty base URL')
    }
    if (!model) {
      model = (await ask(rl, 'Model: ')).trim()
      if (!model) return cancel('empty model')
    }

    const result = await quickEnableLlmPreset({
      preset: preset.key,
      apiKey,
      baseUrl,
      model,
    })
    process.stdout.write(
      `\n✅ Agim Agent enabled\n`
      + `   backend: ${result.name}\n`
      + `   model:   ${result.model}\n`
      + `   baseUrl: ${result.baseUrl}\n`
      + `   roles:   native-chat / cheap / evaluator → ${result.name}\n`
      + `   defaultAgent: ${result.defaultAgent}\n`,
    )
    return 0
  } catch (err) {
    if (err instanceof QuickEnableError) {
      process.stderr.write(`❌ ${err.message}\n`)
      return 1
    }
    throw err
  } finally {
    rl.close()
  }
}

// ─── subcommands ────────────────────────────────────────────────────

async function listAction(): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  const roles = cfg.llmRoles ?? {}
  if (backends.length === 0) {
    process.stdout.write('(no LLM backends configured — run `agim setup llm add`)\n')
  } else {
    process.stdout.write('\nConfigured backends:\n')
    for (const b of backends) {
      const src = describeSecretSource(b.name)
      const keyStr = src.source === 'none' ? 'key: ⚠️  missing' : `key: ✅ ${src.source}`
      process.stdout.write(`  · ${b.name} → ${b.provider} ${b.model} @ ${b.baseUrl}  [${keyStr}]\n`)
    }
  }
  process.stdout.write('\nRole bindings:\n')
  for (const role of KNOWN_ROLES) {
    const bound = roles[role]
    process.stdout.write(`  · ${role.padEnd(12)} → ${bound ? bound : '(unset)'}\n`)
  }
  for (const [role, name] of Object.entries(roles)) {
    if ((KNOWN_ROLES as readonly string[]).includes(role)) continue
    process.stdout.write(`  · ${role.padEnd(12)} → ${name} (custom)\n`)
  }
  return 0
}

async function addAction(): Promise<number> {
  const rl = readline()
  try {
    process.stdout.write('\n── agim setup llm add ──\n')
    process.stdout.write('Pick a provider:\n')
    PROVIDER_PRESETS.forEach((p, i) => { process.stdout.write(`  ${i + 1}. ${p.label}\n`) })
    const choice = await ask(rl, `Choice [1-${PROVIDER_PRESETS.length}]: `)
    const idx = parseInt(choice, 10) - 1
    if (!Number.isFinite(idx) || idx < 0 || idx >= PROVIDER_PRESETS.length) {
      return cancel('not a valid choice')
    }
    const preset = PROVIDER_PRESETS[idx]

    const provider: 'openai-compat' | 'anthropic' = preset.provider
    let baseUrl = preset.baseUrl
    if (!baseUrl) {
      baseUrl = (await ask(rl, 'Base URL (e.g. https://api.example.com/v1): ')).trim()
      if (!baseUrl) return cancel('empty base URL')
    }

    const defaultName = suggestBackendName(provider, preset)
    const cfgForNames = await readConfig()
    const existing = (cfgForNames.llmBackends ?? []).map((b) => b.name)
    const uniqueDefault = suggestSharedBackendName(defaultName, existing)
    const name = (await ask(rl, `Backend name [${uniqueDefault}]: `)).trim() || uniqueDefault
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      return cancel('name must match [A-Za-z0-9][A-Za-z0-9-]*')
    }

    const modelDefault = preset.modelHint
    const model = (await ask(rl, `Model${modelDefault ? ` [${modelDefault}]` : ''}: `)).trim() || modelDefault
    if (!model) return cancel('empty model')

    if (preset.apiKeyDoc) {
      process.stdout.write(`(API key: get one at ${preset.apiKeyDoc})\n`)
    }
    const apiKey = (await ask(rl, 'Paste API key: ', { silent: true })).trim()
    if (!apiKey) {
      return cancel('API key is required')
    }

    try {
      await updateConfigObject((current) => {
        const cfg = current as RawConfig
        const backends = cfg.llmBackends ?? []
        if (backends.some((b) => b.name === name)) {
          throw new SetupLlmConfigError(
            `backend "${name}" already exists — use \`agim setup llm remove ${name}\` first`,
          )
        }
        const next = {
          ...cfg,
          llmBackends: [...backends, { name, provider, baseUrl, model }],
        }
        const result = configSchema.safeParse(next)
        if (!result.success) {
          throw new SetupLlmConfigError(
            `config validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
          )
        }
        return { config: next, result: undefined }
      }, {
        fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
      })
    } catch (err) {
      if (err instanceof SetupLlmConfigError) return cancel(err.message)
      throw err
    }
    await reportConfigWrite()
    saveSecret(name, apiKey)

    process.stdout.write(`\n✅ Saved backend "${name}" (${provider} / ${model}).\n`)

    process.stdout.write('\nBind to which role(s)? (comma-separated, empty to skip)\n')
    process.stdout.write(`  Known roles: ${KNOWN_ROLES.join(', ')}\n`)
    const roleAns = (await ask(rl, 'Roles: ')).trim()
    if (roleAns) {
      const roles = roleAns.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean)
      try {
        await updateConfigObject((current) => {
          const cfg = current as RawConfig
          if (!(cfg.llmBackends ?? []).some((backend) => backend.name === name)) {
            throw new SetupLlmConfigError(`backend "${name}" was removed before roles were saved`)
          }
          const llmRoles = { ...(cfg.llmRoles ?? {}) }
          for (const role of roles) llmRoles[role] = name
          return { config: { ...cfg, llmRoles }, result: undefined }
        }, {
          fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
        })
      } catch (err) {
        if (err instanceof SetupLlmConfigError) return cancel(err.message)
        throw err
      }
      await reportConfigWrite()
      process.stdout.write(`✅ Bound roles: ${roles.join(', ')} → ${name}\n`)
    }
    return 0
  } finally {
    rl.close()
  }
}

async function removeAction(maybeName?: string): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  if (backends.length === 0) {
    process.stdout.write('(no backends to remove)\n')
    return 0
  }
  let name = (maybeName ?? '').trim()
  if (!name) {
    const rl = readline()
    try {
      process.stdout.write('\nWhich backend?\n')
      backends.forEach((b, i) => { process.stdout.write(`  ${i + 1}. ${b.name}\n`) })
      const choice = await ask(rl, `Choice [1-${backends.length}]: `)
      const idx = parseInt(choice, 10) - 1
      if (!Number.isFinite(idx) || idx < 0 || idx >= backends.length) return cancel('not a valid choice')
      name = backends[idx].name
    } finally { rl.close() }
  }
  let droppedRoles = 0
  try {
    await updateConfigObject((current) => {
      const latest = current as RawConfig
      const latestBackends = latest.llmBackends ?? []
      const next = latestBackends.filter((backend) => backend.name !== name)
      if (next.length === latestBackends.length) {
        throw new SetupLlmConfigError(`no backend named "${name}"`)
      }
      const cleanedRoles: Record<string, string> = {}
      droppedRoles = 0
      for (const [role, backend] of Object.entries(latest.llmRoles ?? {})) {
        if (backend === name) { droppedRoles++; continue }
        cleanedRoles[role] = backend
      }
      return {
        config: { ...latest, llmBackends: next, llmRoles: cleanedRoles },
        result: undefined,
      }
    }, {
      fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
    })
  } catch (err) {
    if (err instanceof SetupLlmConfigError) return cancel(err.message)
    throw err
  }
  await reportConfigWrite()
  removeSecret(name)
  process.stdout.write(`✅ Removed backend "${name}" (cleared ${droppedRoles} role binding(s) and the on-disk API key).\n`)
  return 0
}

async function roleAction(): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  if (backends.length === 0) {
    return cancel('add a backend first: `agim setup llm add`')
  }
  const rl = readline()
  try {
    process.stdout.write('\nAvailable backends:\n')
    backends.forEach((b, i) => { process.stdout.write(`  ${i + 1}. ${b.name}\n`) })
    process.stdout.write('  0. (unbind)\n\n')

    const roleChanges: Record<string, string | null> = {}
    const configuredRoles = cfg.llmRoles ?? {}
    for (const role of KNOWN_ROLES) {
      const current = configuredRoles[role] ?? '(unset)'
      const ans = (await ask(rl, `${role} [current: ${current}] → backend # (Enter = keep): `)).trim()
      if (!ans) continue
      const n = parseInt(ans, 10)
      if (n === 0) {
        roleChanges[role] = null
        continue
      }
      const idx = n - 1
      if (!Number.isFinite(idx) || idx < 0 || idx >= backends.length) {
        process.stdout.write(`  ⚠ skipped "${role}" (invalid choice)\n`)
        continue
      }
      roleChanges[role] = backends[idx].name
    }
    try {
      await updateConfigObject((current) => {
        const latest = current as RawConfig
        const latestBackends = new Set((latest.llmBackends ?? []).map((backend) => backend.name))
        const llmRoles = { ...(latest.llmRoles ?? {}) }
        for (const [role, backend] of Object.entries(roleChanges)) {
          if (backend === null) {
            delete llmRoles[role]
            continue
          }
          if (!latestBackends.has(backend)) {
            throw new SetupLlmConfigError(`backend "${backend}" was removed before roles were saved`)
          }
          llmRoles[role] = backend
        }
        return { config: { ...latest, llmRoles }, result: undefined }
      }, {
        fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
      })
    } catch (err) {
      if (err instanceof SetupLlmConfigError) return cancel(err.message)
      throw err
    }
    await reportConfigWrite()
    process.stdout.write('\n✅ Role bindings updated.\n')
    return 0
  } finally { rl.close() }
}

async function secretAction(maybeName?: string): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  if (backends.length === 0) return cancel('no backends configured')
  let name = (maybeName ?? '').trim()
  if (!name) {
    const rl = readline()
    try {
      process.stdout.write('\nWhich backend?\n')
      backends.forEach((b, i) => { process.stdout.write(`  ${i + 1}. ${b.name}\n`) })
      const choice = await ask(rl, `Choice [1-${backends.length}]: `)
      const idx = parseInt(choice, 10) - 1
      if (!Number.isFinite(idx) || idx < 0 || idx >= backends.length) return cancel('not a valid choice')
      name = backends[idx].name
    } finally { rl.close() }
  } else if (!backends.some((b) => b.name === name)) {
    return cancel(`no backend named "${name}"`)
  }
  const rl = readline()
  try {
    const key = (await ask(rl, `Paste API key for "${name}" (empty to abort): `, { silent: true })).trim()
    if (!key) return cancel('empty key')
    saveSecret(name, key)
    process.stdout.write(`✅ Saved API key for "${name}".\n`)
    return 0
  } finally { rl.close() }
}

async function nativeEnableAction(maybeBackendName?: string): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  if (backends.length === 0) {
    process.stdout.write('\n(no LLM backends configured yet)\n')
    process.stdout.write('Run `agim setup llm add` first to set one up, then re-run this.\n')
    return 1
  }
  let name = (maybeBackendName ?? '').trim()
  if (!name) {
    const rl = readline()
    try {
      process.stdout.write('\nPick the backend that powers the native agent:\n')
      backends.forEach((b, i) => { process.stdout.write(`  ${i + 1}. ${b.name}  (${b.provider} / ${b.model})\n`) })
      const choice = await ask(rl, `Choice [1-${backends.length}]: `)
      const idx = parseInt(choice, 10) - 1
      if (!Number.isFinite(idx) || idx < 0 || idx >= backends.length) {
        return cancel('not a valid choice')
      }
      name = backends[idx].name
    } finally { rl.close() }
  } else if (!backends.some((b) => b.name === name)) {
    return cancel(`no backend named "${name}"`)
  }

  let bindCheapSelected = false
  let setDefaultSelected = false
  const rl = readline()
  try {
    const bindCheap = (await ask(rl, `Also bind cheap role to "${name}"? [Y/n]: `)).trim().toLowerCase()
    if (bindCheap === '' || bindCheap === 'y' || bindCheap === 'yes') {
      bindCheapSelected = true
    }
    const setDefault = (await ask(rl, `Set defaultAgent: "agim" (in-process agent handles unrouted IM)? [Y/n]: `))
      .trim().toLowerCase()
    if (setDefault === '' || setDefault === 'y' || setDefault === 'yes') {
      setDefaultSelected = true
    }
  } finally { rl.close() }

  let savedConfig: RawConfig
  try {
    const update = await updateConfigObject((current) => {
      const latest = current as RawConfig
      if (!(latest.llmBackends ?? []).some((backend) => backend.name === name)) {
        throw new SetupLlmConfigError(`backend "${name}" was removed before native setup was saved`)
      }
      const llmRoles: Record<string, string> = { ...(latest.llmRoles ?? {}), 'native-chat': name }
      if (bindCheapSelected) llmRoles.cheap = name
      const next = {
        ...latest,
        llmRoles,
        ...(setDefaultSelected ? { defaultAgent: 'agim' } : {}),
      }
      const parsed = configSchema.safeParse(next)
      if (!parsed.success) {
        throw new SetupLlmConfigError(
          `config validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        )
      }
      return { config: next, result: undefined }
    }, {
      fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
    })
    savedConfig = update.config as RawConfig
  } catch (err) {
    if (err instanceof SetupLlmConfigError) return cancel(err.message)
    throw err
  }
  await reportConfigWrite()

  process.stdout.write(`\n✅ Native agent enabled.\n`)
  process.stdout.write(`   native-chat -> ${savedConfig.llmRoles?.['native-chat']}\n`)
  if (savedConfig.llmRoles?.cheap) {
    process.stdout.write(`   cheap       -> ${savedConfig.llmRoles.cheap}\n`)
  }
  const def = savedConfig.defaultAgent
  if (typeof def === 'string') {
    process.stdout.write(`   defaultAgent: ${def}\n`)
  }
  const src = describeSecretSource(name)
  if (src.source === 'none') {
    process.stdout.write(`⚠️  No API key for "${name}". Run \`agim setup llm secret ${name}\` to add one.\n`)
  }
  process.stdout.write(`\nTry it: in any IM thread, send \`/agim hello\` (legacy \`/na\` still works; or just chat if you set defaultAgent above).\n`)
  return 0
}

// ─── helpers ────────────────────────────────────────────────────────

async function readConfig(): Promise<RawConfig> {
  return await readConfigObject<RawConfig>({
    fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
  })
}

async function reportConfigWrite(): Promise<void> {
  // Surface the path so testers see exactly what got written.
  try {
    const s = await stat(CONFIG_FILE)
    process.stdout.write(`   (wrote ${CONFIG_FILE} — ${s.size} bytes)\n`)
  } catch { /* ignore */ }
}

function suggestBackendName(
  provider: string,
  preset: { key?: string; label: string; modelHint?: string },
): string {
  const fromKey = preset.key && preset.key !== 'custom'
    ? `${preset.key}-agim`
    : undefined
  const fallback = fromKey
    ?? ((preset.label.split(/[\s(]/)[0]?.toLowerCase() ?? provider).replace(/[^a-z0-9-]/g, '') || 'agim-api')
  // Prefer the model id so CLI / Web show the same string operators know.
  return presetBackendStem(fallback, preset.modelHint ?? '', 0)
}

function envSuffix(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

function readline(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout })
}

interface AskOpts { silent?: boolean }

function ask(rl: ReturnType<typeof createInterface>, prompt: string, opts: AskOpts = {}): Promise<string> {
  if (!opts.silent || !process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise<string>((resolve) => rl.question(prompt, resolve))
  }

  type ReadlineWithMask = ReturnType<typeof createInterface> & {
    stdoutMuted?: boolean
    _writeToOutput?: (str: string) => void
    output: NodeJS.WritableStream
  }

  const maskedRl = rl as ReadlineWithMask
  const prevWrite = maskedRl._writeToOutput

  return new Promise<string>((resolve) => {
    maskedRl.stdoutMuted = true
    maskedRl._writeToOutput = function (this: ReadlineWithMask, text: string): void {
      if (!this.stdoutMuted) {
        if (typeof prevWrite === 'function') prevWrite.call(this, text)
        else this.output.write(text)
        return
      }
      if (text === '\n' || text === '\r' || text === '\r\n') {
        this.output.write(text)
        return
      }
      // Mask each user keystroke chunk while keeping the prompt visible.
      this.output.write('*')
    }

    process.stdout.write(prompt)
    rl.question('', (answer) => {
      maskedRl.stdoutMuted = false
      if (typeof prevWrite === 'function') maskedRl._writeToOutput = prevWrite
      else delete maskedRl._writeToOutput
      resolve(answer)
    })
  })
}

function cancel(reason: string): number {
  process.stdout.write(`\n✖ aborted: ${reason}\n`)
  return 1
}

// ─── test hooks ─────────────────────────────────────────────────────

/** Exported only for unit tests; lets us verify the suggestBackendName
 *  derivation without spinning up readline. */
export const _internal = {
  suggestBackendName,
  envSuffix,
  KNOWN_ROLES,
  PROVIDER_PRESETS,
}

/** Re-export of the public secrets helpers so tests can confirm
 *  saveSecret was wired correctly without importing the secrets
 *  module twice. */
export const _wired = { listConfiguredBackends }
