/**
 * /settings/search — web_search provider config (v1.2.126).
 *
 * One row per registered provider (Tavily / Brave / Serper / Exa /
 * DuckDuckGo / Metaso): API-key input (masked-by-default), enable
 * toggle (= "is this name in the chain?"), reorder via up / down,
 * one-shot test button. The chain preview at the top shows what
 * IMHUB_WEB_SEARCH_PROVIDERS resolves to right now.
 *
 * Persistence: API keys go via PUT /api/env (which masks GET +
 * refuses echoed masks on PUT); the chain order is a single CSV
 * env key — same endpoint. Save is one round-trip per dirty key.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowDown, ArrowUp, CheckCircle2, FlaskConical, Globe, Key,
  Loader2, RefreshCcw, Save, X, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useEnv,
  useSearchProviders,
  useTestSearchProvider,
  useUpdateEnv,
} from '@/hooks/use-settings'
import type { SearchProviderInfo } from '@/types/api'

interface ChainEntry {
  name: string
  enabled: boolean
}

interface Draft {
  /** Provider chain — every known provider, with `enabled`
   *  reflecting "is name in the CSV". Order is the row order. */
  chain: ChainEntry[]
  /** Each provider's API-key input. Keyed by envKey (e.g.
   *  TAVILY_API_KEY). Holds either '' (clear) or the new plaintext
   *  the operator typed. We never load values back from the server. */
  keys: Record<string, string>
  /** Tracks which key fields the operator actually touched — so
   *  Save only sends the diff and untouched masked keys are left
   *  alone. */
  keysTouched: Record<string, boolean>
}

function envChainOrder(envValue: string | undefined, providers: SearchProviderInfo[]): ChainEntry[] {
  // Parse the CSV chain; preserve operator order; tail-append any
  // provider not in the CSV as disabled so they remain renderable.
  const raw = (envValue ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const known = new Set(providers.map((p) => p.name))
  const seen = new Set<string>()
  const out: ChainEntry[] = []
  for (const name of raw) {
    if (!known.has(name) || seen.has(name)) continue
    out.push({ name, enabled: true })
    seen.add(name)
  }
  for (const p of providers) {
    if (seen.has(p.name)) continue
    out.push({ name: p.name, enabled: false })
  }
  return out
}

function chainToCsv(chain: ChainEntry[]): string {
  return chain.filter((c) => c.enabled).map((c) => c.name).join(',')
}

export default function SettingsSearchRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv({ reveal: false })
  const providersQuery = useSearchProviders()
  const updateEnv = useUpdateEnv()
  const testProvider = useTestSearchProvider()

  const envData = envQuery.data?.env ?? {}
  const providers = providersQuery.data?.providers ?? []
  const live = providersQuery.data?.chain ?? []

  const initial = useMemo<Draft>(
    () => ({
      chain: envChainOrder(envData.IMHUB_WEB_SEARCH_PROVIDERS, providers),
      keys: {},
      keysTouched: {},
    }),
    [envData.IMHUB_WEB_SEARCH_PROVIDERS, providers],
  )

  const [draft, setDraft] = useState<Draft>(initial)
  const [syncedHash, setSyncedHash] = useState('')

  useEffect(() => {
    const hash = JSON.stringify(initial)
    if (hash !== syncedHash) {
      setDraft(initial)
      setSyncedHash(hash)
    }
  }, [initial, syncedHash])

  const isDirty =
    JSON.stringify(draft.chain) !== JSON.stringify(initial.chain) ||
    Object.keys(draft.keysTouched).length > 0

  function moveRow(idx: number, delta: -1 | 1): void {
    setDraft((d) => {
      const next = [...d.chain]
      const swap = idx + delta
      if (swap < 0 || swap >= next.length) return d
      ;[next[idx], next[swap]] = [next[swap], next[idx]]
      return { ...d, chain: next }
    })
  }

  function toggleRow(idx: number, enabled: boolean): void {
    setDraft((d) => {
      const next = [...d.chain]
      next[idx] = { ...next[idx], enabled }
      return { ...d, chain: next }
    })
  }

  function setKey(envKey: string, value: string): void {
    setDraft((d) => ({
      ...d,
      keys: { ...d.keys, [envKey]: value },
      keysTouched: { ...d.keysTouched, [envKey]: true },
    }))
  }

  function clearKey(envKey: string): void {
    setDraft((d) => ({
      ...d,
      keys: { ...d.keys, [envKey]: '' },
      keysTouched: { ...d.keysTouched, [envKey]: true },
    }))
  }

  async function onSave(): Promise<void> {
    const updates: Record<string, string | null> = {}
    const nextCsv = chainToCsv(draft.chain)
    const initialCsv = chainToCsv(initial.chain)
    if (nextCsv !== initialCsv) {
      updates.IMHUB_WEB_SEARCH_PROVIDERS = nextCsv || null
    }
    for (const [envKey, touched] of Object.entries(draft.keysTouched)) {
      if (!touched) continue
      const v = draft.keys[envKey] ?? ''
      updates[envKey] = v.trim() === '' ? null : v
    }
    if (Object.keys(updates).length === 0) return
    try {
      await updateEnv.mutateAsync({ updates })
      // Refetch both — env keys changed availability, chain order changed.
      void providersQuery.refetch()
      toast.success(t('search.savedToast'))
      setDraft((d) => ({ ...d, keys: {}, keysTouched: {} }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  function onDiscard(): void {
    setDraft(initial)
  }

  async function onTest(provider: string): Promise<void> {
    try {
      const result = await testProvider.mutateAsync({
        provider,
        // Short, harmless probe — the dispatcher only needs to
        // verify the upstream auth + transport.
        query: 'agim ping',
      })
      if (result.ok) {
        toast.success(
          t('search.testOk', { provider, hits: result.hits, ms: result.latencyMs }),
        )
      } else {
        toast.error(
          t('search.testFail', { provider, error: result.error ?? 'unknown error' }),
        )
      }
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('search.title')}</h1>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => {
            void envQuery.refetch()
            void providersQuery.refetch()
          }}
          disabled={envQuery.isFetching || providersQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {envQuery.isFetching || providersQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('search.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('search.subtitle')}</p>

      <ChainPreview live={live} />

      {envQuery.isLoading || providersQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <section className="flex flex-col gap-2">
          {draft.chain.map((entry, idx) => {
            const info = providers.find((p) => p.name === entry.name)
            return (
              <ProviderRow
                key={entry.name}
                info={info}
                entry={entry}
                idx={idx}
                count={draft.chain.length}
                keyValue={info?.envKey ? draft.keys[info.envKey] : undefined}
                keyTouched={info?.envKey ? !!draft.keysTouched[info.envKey] : false}
                onMove={(d) => moveRow(idx, d)}
                onToggle={(v) => toggleRow(idx, v)}
                onSetKey={(v) => info?.envKey && setKey(info.envKey, v)}
                onClearKey={() => info?.envKey && clearKey(info.envKey)}
                onTest={() => onTest(entry.name)}
                testing={testProvider.isPending}
              />
            )
          })}
        </section>
      )}

      {isDirty && (
        <div className="sticky bottom-2 flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-3 shadow">
          <Badge variant="info">{t('search.unsaved')}</Badge>
          <Button
            variant="ghost" size="sm" className="ml-auto"
            onClick={onDiscard}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" /> {t('search.discard')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateEnv.isPending}
          >
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {t('search.save')}
          </Button>
        </div>
      )}
    </div>
  )
}

function ChainPreview({ live }: { live: string[] }): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section className="rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Globe className="h-4 w-4 text-text-dim" />
        <span className="text-text-dim">{t('search.chainLabel')}</span>
        {live.length === 0 ? (
          <Badge variant="outline">{t('search.chainEmpty')}</Badge>
        ) : (
          <span className="font-mono text-xs">{live.join(' → ')}</span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-text-dim">{t('search.chainHint')}</p>
    </section>
  )
}

interface ProviderRowProps {
  info: SearchProviderInfo | undefined
  entry: ChainEntry
  idx: number
  count: number
  keyValue: string | undefined
  keyTouched: boolean
  onMove: (delta: -1 | 1) => void
  onToggle: (v: boolean) => void
  onSetKey: (v: string) => void
  onClearKey: () => void
  onTest: () => void
  testing: boolean
}

function ProviderRow(props: ProviderRowProps): JSX.Element {
  const { t } = useTranslation('settings')
  const { info, entry, idx, count, keyValue, keyTouched, onMove, onToggle,
    onSetKey, onClearKey, onTest, testing } = props
  const needsKey = !!info?.envKey
  const available = !!info?.available || (keyTouched && !!keyValue)
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            className="h-5 w-5 rounded text-text-dim hover:bg-surface-hover disabled:opacity-30"
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            aria-label={t('search.moveUp')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="h-5 w-5 rounded text-text-dim hover:bg-surface-hover disabled:opacity-30"
            onClick={() => onMove(1)}
            disabled={idx === count - 1}
            aria-label={t('search.moveDown')}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 accent-accent cursor-pointer"
          />
          <span className="font-mono text-sm">{entry.name}</span>
        </label>

        {!needsKey ? (
          <Badge variant="outline">{t('search.noKey')}</Badge>
        ) : available ? (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" /> {t('search.configured')}
          </Badge>
        ) : (
          <Badge variant="warning">
            <XCircle className="mr-1 h-3 w-3" /> {t('search.missingKey')}
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm" variant="ghost"
            onClick={onTest}
            disabled={testing || !entry.enabled}
            aria-label={t('search.testBtn')}
          >
            {testing
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <FlaskConical className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('search.testBtn')}</span>
          </Button>
        </div>
      </div>

      {needsKey && (
        <div className="mt-3 flex flex-col gap-1">
          <Label className="text-xs font-medium">
            <Key className="mr-1 inline h-3 w-3" />
            {info?.envKey}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={keyValue ?? ''}
              onChange={(e) => onSetKey(e.target.value)}
              placeholder={
                info?.available && !keyTouched
                  ? t('search.placeholderConfigured')
                  : t('search.placeholderEnter')
              }
              className="font-mono text-xs"
            />
            {info?.available && !keyTouched && (
              <Button
                size="sm" variant="ghost"
                onClick={onClearKey}
                aria-label={t('search.clearKey')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-text-dim">
            {t('search.keyHint', { envKey: info?.envKey })}
          </p>
        </div>
      )}
    </div>
  )
}
