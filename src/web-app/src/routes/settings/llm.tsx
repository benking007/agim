/**
 * /settings/llm — native LLM backends + role bindings (Stage 6).
 *
 * Front-end for the `/api/llm/*` REST surface that landed in Stage 4.
 * Operators add an OpenAI-compatible or Anthropic backend, paste an
 * API key, bind it to a role (cheap / evaluator / native-chat), and
 * ping-test the connection — all without hand-editing
 * ~/.agim/config.json.
 *
 * Intentionally minimal styling — focused on doing the job; matches
 * the existing settings pages' shadcn look without bespoke chrome.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, Plus, RefreshCcw, Trash2, Zap } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useLlmList, useLlmAddBackend, useLlmRemoveBackend, useLlmPutRoles, useLlmPing,
} from '@/hooks/use-llm-admin'

const KNOWN_ROLES = ['cheap', 'evaluator', 'native-chat'] as const
const UNBIND_SENTINEL = '__unbind__'

interface ProviderPreset {
  label: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  modelHint: string
}

const PRESETS: ProviderPreset[] = [
  { label: 'DeepSeek',  provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  { label: 'Moonshot Kimi', provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1', modelHint: 'moonshot-v1-8k' },
  { label: 'Zhipu GLM', provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelHint: 'glm-4-air' },
  { label: 'OpenAI',    provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { label: 'Anthropic', provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', modelHint: 'claude-3-5-sonnet-20241022' },
  { label: 'Custom',    provider: 'openai-compat',
    baseUrl: '', modelHint: '' },
]

export default function SettingsLlmRoute(): JSX.Element {
  const listQuery = useLlmList()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Native LLM Backends</h1>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label="Refresh"
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">
        These backends power the in-process <code>native</code> agent and internal introspection
        callers (memo extraction, intent classification, notification evaluator, heartbeat).
        Backend metadata lives in <code>~/.agim/config.json</code>;
        API keys live in <code>~/.agim/llm-secrets.json</code> (0600) or the
        <code> AGIM_LLM_SECRET_&lt;NAME&gt;</code> env var.
      </p>

      {listQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <BackendsCard data={listQuery.data} />
          <RolesCard data={listQuery.data} />
          <AddBackendCard />
        </>
      )}
    </div>
  )
}

/* ─────────────── Backends list ─────────────── */

function BackendsCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const removeBackend = useLlmRemoveBackend()
  const ping = useLlmPing()
  const [pingResults, setPingResults] = useState<Record<string, string>>({})

  async function onRemove(name: string): Promise<void> {
    if (!confirm(`Remove backend "${name}"? Role bindings + API key will be cleared.`)) return
    try {
      const r = await removeBackend.mutateAsync(name)
      toast.success(`Removed (also cleared ${r.removedRoles} role binding(s)).`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  async function onPing(name: string): Promise<void> {
    setPingResults((m) => ({ ...m, [name]: 'pinging…' }))
    try {
      const r = await ping.mutateAsync(name)
      const msg = r.ok
        ? `✓ ${r.durationMs}ms · tokens ${r.tokensIn}→${r.tokensOut}`
        : `✗ ${r.error}`
      setPingResults((m) => ({ ...m, [name]: msg }))
    } catch (err) {
      setPingResults((m) => ({ ...m, [name]: `✗ ${((err as Error)?.message ?? String(err))}` }))
    }
  }

  const rows = data?.backends ?? []
  if (rows.length === 0) {
    return (
      <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
        No LLM backends configured yet. Add one below.
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Backends ({rows.length})</h2>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>API Key</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((b) => {
            const keyBadge = b.secret.source === 'none'
              ? <Badge variant="outline">missing</Badge>
              : <Badge variant="success">{b.secret.source}</Badge>
            return (
              <TableRow key={b.name}>
                <TableCell className="font-mono text-xs">{b.name}</TableCell>
                <TableCell>{b.provider}</TableCell>
                <TableCell className="font-mono text-xs">{b.model}</TableCell>
                <TableCell className="break-all font-mono text-[11px] text-text-dim">{b.baseUrl ?? '—'}</TableCell>
                <TableCell>{keyBadge}</TableCell>
                <TableCell className="flex flex-col gap-1 sm:flex-row sm:items-center">
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onPing(b.name)}
                    disabled={ping.isPending || b.secret.source === 'none'}
                    title={b.secret.source === 'none' ? 'set API key first' : 'send a tiny chat probe'}
                  >
                    <Zap className="h-4 w-4" />
                    <span>Ping</span>
                  </Button>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onRemove(b.name)}
                    disabled={removeBackend.isPending}
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Remove</span>
                  </Button>
                  {pingResults[b.name] && (
                    <span className="ml-2 text-[11px] text-text-dim">{pingResults[b.name]}</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}

/* ─────────────── Role bindings ─────────────── */

function RolesCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const putRoles = useLlmPutRoles()
  const backendNames = (data?.backends ?? []).map((b) => b.name)
  const current = data?.roles ?? {}

  async function onChangeRole(role: string, value: string): Promise<void> {
    const next: Record<string, string | null> = {
      [role]: value === UNBIND_SENTINEL ? null : value,
    }
    try {
      await putRoles.mutateAsync(next)
      toast.success(`Updated role ${role}`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Role Bindings</h2>
      </header>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        {KNOWN_ROLES.map((role) => (
          <div key={role} className="flex flex-col gap-1">
            <Label className="text-xs font-medium">{role}</Label>
            <Select
              value={current[role] ?? UNBIND_SENTINEL}
              onValueChange={(v) => void onChangeRole(role, v)}
              disabled={backendNames.length === 0 || putRoles.isPending}
            >
              <SelectTrigger className="font-mono text-xs">
                <SelectValue placeholder="(unset)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNBIND_SENTINEL}>(unbound)</SelectItem>
                {backendNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-text-dim">
              {role === 'cheap' && 'Internal introspection: memo extraction, intent classification, fallback chain stage 1.'}
              {role === 'evaluator' && 'Notification evaluator + router-compare judge LLM.'}
              {role === 'native-chat' && 'The /na agent loop default. Goes to the user if /cc native is invoked.'}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ─────────────── Add backend form ─────────────── */

function AddBackendCard(): JSX.Element {
  const addBackend = useLlmAddBackend()
  const [presetIdx, setPresetIdx] = useState(0)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState(PRESETS[0]?.baseUrl ?? '')
  const [model, setModel] = useState(PRESETS[0]?.modelHint ?? '')
  const [apiKey, setApiKey] = useState('')

  function onPickPreset(idx: number): void {
    setPresetIdx(idx)
    const p = PRESETS[idx]
    if (!p) return
    setBaseUrl(p.baseUrl)
    setModel(p.modelHint)
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const p = PRESETS[presetIdx]
    if (!p) { toast.error('invalid preset'); return }
    if (!name.trim()) { toast.error('name required'); return }
    if (!baseUrl.trim()) { toast.error('baseUrl required'); return }
    if (!model.trim()) { toast.error('model required'); return }
    try {
      await addBackend.mutateAsync({
        name: name.trim(),
        provider: p.provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      toast.success(`Added "${name.trim()}"${apiKey.trim() ? ' with API key' : ' (set key separately)'}`)
      setName(''); setApiKey('')
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Add Backend</h2>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs font-medium">Provider preset</Label>
          <Select value={String(presetIdx)} onValueChange={(v) => onPickPreset(Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESETS.map((p, i) => (
                <SelectItem key={p.label} value={String(i)}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-medium">Name</Label>
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. deepseek-cheap"
            className="font-mono text-xs"
          />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs font-medium">Base URL</Label>
          <Input
            value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label className="text-xs font-medium">Model</Label>
          <Input
            value={model} onChange={(e) => setModel(e.target.value)}
            placeholder="model-id"
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label className="text-xs font-medium">API Key (optional)</Label>
          <Input
            type="password"
            value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="font-mono text-xs"
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2 flex">
          <Button
            type="submit"
            disabled={addBackend.isPending}
            className="ml-auto"
          >
            {addBackend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add Backend
          </Button>
        </div>
      </form>
    </section>
  )
}

/* helper — toast tag passthrough */
function _unused(): typeof CheckCircle2 { return CheckCircle2 }
void _unused
