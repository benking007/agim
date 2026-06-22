/**
 * /settings/llm — Agim Agent model APIs + runtime settings.
 *
 * Front-end for the `/api/llm/*` REST surface that landed in Stage 4.
 * Operators add an OpenAI-compatible or Anthropic API, paste an API
 * key, optionally bind roles (cheap / evaluator / native-chat), and
 * tune built-in Agim Agent runtime behavior without hand-editing
 * ~/.agim/config.json.
 *
 * Intentionally minimal styling — focused on doing the job; matches
 * the existing settings pages' shadcn look without bespoke chrome.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { NativeAgentSettingsPanel } from '@/routes/settings/native-agent'

const KNOWN_ROLES = ['cheap', 'evaluator', 'native-chat'] as const
const UNBIND_SENTINEL = '__unbind__'

interface ProviderPreset {
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  modelHint: string
}

const PRESET_KEYS = ['deepseek', 'moonshot', 'zhipu', 'openai', 'anthropic', 'custom'] as const

const PRESETS: ProviderPreset[] = [
  { provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  { provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1', modelHint: 'moonshot-v1-8k' },
  { provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelHint: 'glm-4-air' },
  { provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { provider: 'anthropic',
    // No trailing /v1: the Anthropic provider appends `/v1/messages` itself.
    baseUrl: 'https://api.anthropic.com', modelHint: 'claude-3-5-sonnet-20241022' },
  { provider: 'openai-compat',
    baseUrl: '', modelHint: '' },
]

export default function SettingsLlmRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useLlmList()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('llm.title')}</h1>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('llm.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('llm.subtitle')}</p>

      {listQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <BackendsCard data={listQuery.data} />
          <AddBackendCard />
          <RolesCard data={listQuery.data} />
          <section id="agim-agent" className="rounded-md border border-border bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold">{t('llm.agimAgentRuntimeTitle')}</h2>
            <p className="mt-1 text-xs text-text-dim">{t('llm.agimAgentRuntimeHint')}</p>
          </section>
          <NativeAgentSettingsPanel embedded />
        </>
      )}
    </div>
  )
}

/* ─────────────── Backends list ─────────────── */

function BackendsCard({ data }: { data: ReturnType<typeof useLlmList>['data'] }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const removeBackend = useLlmRemoveBackend()
  const ping = useLlmPing()
  const [pingResults, setPingResults] = useState<Record<string, string>>({})

  async function onRemove(name: string): Promise<void> {
    if (!confirm(t('llm.removeConfirm', { name }))) return
    try {
      const r = await removeBackend.mutateAsync(name)
      toast.success(t('llm.removedToast', { count: r.removedRoles }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  async function onPing(name: string): Promise<void> {
    setPingResults((m) => ({ ...m, [name]: t('llm.pinging') }))
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
        {t('llm.backendsEmpty')}
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.backendsTitle', { count: rows.length })}</h2>
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('llm.col.name')}</TableHead>
            <TableHead>{t('llm.col.provider')}</TableHead>
            <TableHead>{t('llm.col.model')}</TableHead>
            <TableHead>{t('llm.col.baseUrl')}</TableHead>
            <TableHead>{t('llm.col.apiKey')}</TableHead>
            <TableHead>{t('llm.col.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((b) => {
            const keyBadge = b.secret.source === 'none'
              ? <Badge variant="outline">{t('llm.secretMissing')}</Badge>
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
                    title={b.secret.source === 'none' ? t('llm.setKeyFirst') : t('llm.pingHint')}
                  >
                    <Zap className="h-4 w-4" />
                    <span>{t('llm.ping')}</span>
                  </Button>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onRemove(b.name)}
                    disabled={removeBackend.isPending}
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">{t('llm.remove')}</span>
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
  const { t } = useTranslation(['settings', 'common'])
  const putRoles = useLlmPutRoles()
  const backendNames = (data?.backends ?? []).map((b) => b.name)
  const current = data?.roles ?? {}

  async function onChangeRole(role: string, value: string): Promise<void> {
    const next: Record<string, string | null> = {
      [role]: value === UNBIND_SENTINEL ? null : value,
    }
    try {
      await putRoles.mutateAsync(next)
      toast.success(t('llm.roleUpdated', { role }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.rolesTitle')}</h2>
        <p className="mt-1 text-xs text-text-dim">{t('llm.rolesOptionalHint')}</p>
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
                <SelectValue placeholder={t('llm.unset')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNBIND_SENTINEL}>{t('llm.unbound')}</SelectItem>
                {backendNames.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-text-dim">
              {t(`llm.roleHint.${role}`)}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ─────────────── Add backend form ─────────────── */

function AddBackendCard(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const addBackend = useLlmAddBackend()
  const [presetIdx, setPresetIdx] = useState(0)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState(PRESETS[0]?.baseUrl ?? '')
  const [model, setModel] = useState(PRESETS[0]?.modelHint ?? '')
  const [apiKey, setApiKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  function fail(message: string): void {
    setFormError(message)
    toast.error(message)
  }

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
    if (!p) { fail(t('llm.invalidPreset')); return }
    if (!name.trim()) { fail(t('llm.nameRequired')); return }
    if (!baseUrl.trim()) { fail(t('llm.baseUrlRequired')); return }
    if (!model.trim()) { fail(t('llm.modelRequired')); return }
    if (!apiKey.trim()) { fail(t('llm.apiKeyRequired')); return }
    try {
      await addBackend.mutateAsync({
        name: name.trim(),
        provider: p.provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      })
      setFormError(null)
      toast.success(t('llm.addedWithKey', { name: name.trim() }))
      setName(''); setApiKey('')
    } catch (err) {
      const message = ((err as Error)?.message ?? String(err))
      fail(message)
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('llm.addTitle')}</h2>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs font-medium">{t('llm.preset')}</Label>
          <Select value={String(presetIdx)} onValueChange={(v) => onPickPreset(Number(v))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESETS.map((_p, i) => (
                <SelectItem key={PRESET_KEYS[i]} value={String(i)}>
                  {t(`llm.presets.${PRESET_KEYS[i]}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-medium">{t('llm.name')}</Label>
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t('llm.namePlaceholder')}
            className="font-mono text-xs"
          />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs font-medium">{t('llm.baseUrl')}</Label>
          <Input
            value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('llm.baseUrlPlaceholder')}
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label className="text-xs font-medium">{t('llm.model')}</Label>
          <Input
            value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={t('llm.modelPlaceholder')}
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label className="text-xs font-medium">{t('llm.apiKey')}</Label>
          <Input
            type="password"
            value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('llm.apiKeyPlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2 flex">
          <div className="flex w-full flex-col gap-2 sm:items-end">
            {formError && (
              <p className="text-xs text-danger">{formError}</p>
            )}
            <Button
              type="submit"
              disabled={addBackend.isPending}
              className="ml-auto"
            >
              {addBackend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('llm.addBackend')}
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}

/* helper — toast tag passthrough */
function _unused(): typeof CheckCircle2 { return CheckCircle2 }
void _unused
