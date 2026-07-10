/**
 * /settings/viewer — long-message Viewer card + Baidu Maps AK card.
 *
 * Both cards are env-driven (~/.agim/.env), each with its own dirty /
 * Save / Discard state so a change to one doesn't force re-save of the
 * other. The Viewer card additionally surfaces cloudflared tunnel
 * status via `GET /api/viewer/tunnel`, with a manual Refresh button
 * since tunnel state is essentially static between operator actions.
 *
 * Env keys covered:
 *   * Viewer: AGIM_VIEWER_ENABLED / _PUBLIC_BASE_URL / _TUNNEL_MODE /
 *             _CHARS / _LINES / _CODE_LINES / _MAX_PASTES
 *   * Baidu:  AGIM_BAIDU_MAP_AK   (in SECRET_KEYS — masked unless
 *             reveal=1 is passed)
 *
 * AK validation: v1 mentioned "32-char AK starting with non-digit" as
 * a hint, but isn't strictly enforced (Baidu has refreshed AK formats
 * over the years). We surface a `pattern-looks-suspicious` warning
 * rather than blocking save.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CheckCircle2, Eye, EyeOff, ExternalLink, FileText, Globe2, Loader2,
  MapPin, RefreshCcw, Save, X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv, useViewerTunnel } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

/* ─────────────── Page wrapper ─────────────── */

export default function SettingsViewerRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const [reveal, setReveal] = useState(false)
  const envQuery = useEnv({ reveal })

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('viewerSettings.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setReveal((v) => !v)}
            disabled={envQuery.isFetching}
            aria-label={reveal ? t('viewerSettings.hide') : t('viewerSettings.reveal')}
          >
            {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            <span className="hidden sm:inline">
              {reveal ? t('viewerSettings.hide') : t('viewerSettings.reveal')}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void envQuery.refetch()}
            disabled={envQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {envQuery.isFetching
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('viewerSettings.subtitle')}</p>
      </header>

      {envQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <ViewerCard env={envQuery.data?.env ?? {}} />
          <BaiduCard env={envQuery.data?.env ?? {}} />
        </>
      )}
    </div>
  )
}

/* ─────────────── Viewer card ─────────────── */

interface ViewerDraft {
  enabled: boolean
  publicUrl: string
  tunnelMode: 'off' | 'quick'
  // v1.2.45 — remote-paste URL/Token are env-only advanced knobs.
  // Only the opt-out toggle stays in the UI.
  noDefaultRemote: boolean
  chars: string
  lines: string
  codeLines: string
  maxPastes: string
}

function viewerDraftFromEnv(env: Record<string, string>): ViewerDraft {
  return {
    enabled:    env.AGIM_VIEWER_ENABLED === '1' || env.AGIM_VIEWER_ENABLED?.toLowerCase() === 'true',
    publicUrl:  env.AGIM_VIEWER_PUBLIC_BASE_URL ?? '',
    tunnelMode: env.AGIM_VIEWER_TUNNEL_MODE === 'quick' ? 'quick' : 'off',
    noDefaultRemote: env.AGIM_VIEWER_NO_DEFAULT_REMOTE === '1' || env.AGIM_VIEWER_NO_DEFAULT_REMOTE?.toLowerCase() === 'true',
    chars:      env.AGIM_VIEWER_CHARS ?? '',
    lines:      env.AGIM_VIEWER_LINES ?? '',
    codeLines:  env.AGIM_VIEWER_CODE_LINES ?? '',
    maxPastes:  env.AGIM_VIEWER_MAX_PASTES ?? '',
  }
}

function ViewerCard({ env }: { env: Record<string, string> }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const updateEnv = useUpdateEnv()
  const tunnelQuery = useViewerTunnel()

  const [draft, setDraft] = useState<ViewerDraft>(() => viewerDraftFromEnv(env))
  const current = useMemo(() => viewerDraftFromEnv(env), [env])
  const currentJson = JSON.stringify(current)

  // Sync only when derived server values change, not when an equivalent env
  // object is recreated during an unrelated render or refetch.
  useEffect(() => {
    setDraft(JSON.parse(currentJson) as ViewerDraft)
  }, [currentJson])
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(current),
    [draft, current],
  )

  function setField<K extends keyof ViewerDraft>(k: K, v: ViewerDraft[K]): void {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  async function onSave(): Promise<void> {
    const updates: Record<string, string | null> = {}
    if (draft.enabled !== current.enabled) {
      updates.AGIM_VIEWER_ENABLED = draft.enabled ? '1' : '0'
    }
    if (draft.publicUrl !== current.publicUrl) {
      updates.AGIM_VIEWER_PUBLIC_BASE_URL = draft.publicUrl.trim() || null
    }
    if (draft.tunnelMode !== current.tunnelMode) {
      updates.AGIM_VIEWER_TUNNEL_MODE = draft.tunnelMode
    }
    if (draft.chars !== current.chars) {
      updates.AGIM_VIEWER_CHARS = draft.chars.trim() || null
    }
    if (draft.lines !== current.lines) {
      updates.AGIM_VIEWER_LINES = draft.lines.trim() || null
    }
    if (draft.codeLines !== current.codeLines) {
      updates.AGIM_VIEWER_CODE_LINES = draft.codeLines.trim() || null
    }
    if (draft.maxPastes !== current.maxPastes) {
      updates.AGIM_VIEWER_MAX_PASTES = draft.maxPastes.trim() || null
    }
    if (draft.noDefaultRemote !== current.noDefaultRemote) {
      updates.AGIM_VIEWER_NO_DEFAULT_REMOTE = draft.noDefaultRemote ? '1' : null
    }
    if (Object.keys(updates).length === 0) return
    try {
      await updateEnv.mutateAsync({ updates })
      toast.success(t('viewerSettings.toast.saved'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onDiscard(): void {
    setDraft(current)
  }

  const tunnel = tunnelQuery.data
  const effectivePublicUrl = tunnel?.effectivePublicUrl

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <FileText className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('viewerSettings.viewer.title')}</h2>
        {draft.enabled
          ? <Badge variant="success">{t('viewerSettings.viewer.on')}</Badge>
          : <Badge variant="outline">{t('viewerSettings.viewer.off')}</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('viewerSettings.viewer.subtitle')}</p>

      {/* Enable toggle */}
      <div className="flex items-center gap-3 px-4 py-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => {
              const on = e.target.checked
              setDraft((d) => ({
                ...d,
                enabled: on,
                // Opt-out only applies when viewer is on; clear when disabling.
                noDefaultRemote: on ? d.noDefaultRemote : false,
              }))
            }}
            className="h-4 w-4 accent-accent cursor-pointer"
          />
          <span className="font-medium">{t('viewerSettings.viewer.enableLabel')}</span>
        </label>
      </div>

      {/* Public URL + tunnel mode */}
      <div className="grid grid-cols-1 gap-3 px-4 pb-3 sm:grid-cols-2">
        <Field label={t('viewerSettings.viewer.publicUrl')} hint={t('viewerSettings.viewer.publicUrlHint')}>
          <Input
            value={draft.publicUrl}
            onChange={(e) => setField('publicUrl', e.target.value)}
            placeholder="https://agim.example.com"
            className="font-mono text-xs"
          />
        </Field>
        <Field label={t('viewerSettings.viewer.tunnelMode')} hint={t('viewerSettings.viewer.tunnelHint')}>
          <Select
            value={draft.tunnelMode}
            onValueChange={(v) => setField('tunnelMode', v as 'off' | 'quick')}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t('viewerSettings.viewer.tunnelOff')}</SelectItem>
              <SelectItem value="quick">{t('viewerSettings.viewer.tunnelQuick')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {/* v1.2.45 — only the opt-out toggle is in the UI. The
            community default endpoint (viewer.iclaw.host) is the
            implicit fallback when neither public base URL nor tunnel
            is set; operators who need to point at a different paste
            server use the AGIM_VIEWER_REMOTE_PASTE_URL env var
            (documented in docs/viewer-modes.md). */}
        <Field
          label={t('viewerSettings.viewer.noDefaultRemote')}
          hint={t('viewerSettings.viewer.noDefaultRemoteHint')}
        >
          <label className={cn(
            'inline-flex items-center gap-2 text-xs',
            !draft.enabled && 'opacity-50 cursor-not-allowed',
          )}>
            <input
              type="checkbox"
              checked={draft.noDefaultRemote}
              disabled={!draft.enabled}
              onChange={(e) => setField('noDefaultRemote', e.target.checked)}
              className="h-4 w-4 accent-accent cursor-pointer disabled:cursor-not-allowed"
            />
            <span>{t('viewerSettings.viewer.noDefaultRemoteLabel')}</span>
          </label>
        </Field>
      </div>

      {/* Tunnel status panel (only when quick mode is selected) */}
      {draft.tunnelMode === 'quick' && (
        <div className="mx-4 mb-3 rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-1 flex items-center gap-2">
            <Globe2 className="h-4 w-4 text-text-dim" />
            <span className="text-xs font-medium uppercase tracking-wide text-text-dim">
              {t('viewerSettings.viewer.tunnelStatus')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => void tunnelQuery.refetch()}
              disabled={tunnelQuery.isFetching}
              aria-label={t('viewerSettings.viewer.refreshTunnel')}
            >
              {tunnelQuery.isFetching
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <RefreshCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{t('viewerSettings.viewer.refreshTunnel')}</span>
            </Button>
          </div>
          {tunnel ? (
            <div className="flex flex-col gap-1 text-xs">
              <Row label={t('viewerSettings.viewer.tunnelRunning')}>
                {tunnel.tunnel.running ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <CheckCircle2 className="h-3 w-3" />
                    {t('viewerSettings.viewer.yes')}
                  </span>
                ) : (
                  <span className="text-text-dim">{t('viewerSettings.viewer.no')}</span>
                )}
              </Row>
              <Row label={t('viewerSettings.viewer.tunnelUrl')}>
                {tunnel.tunnel.url ? (
                  <a
                    href={tunnel.tunnel.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 break-all font-mono text-info hover:underline"
                  >
                    {tunnel.tunnel.url}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : <span className="text-text-muted">—</span>}
              </Row>
              <Row label={t('viewerSettings.viewer.effectiveUrl')}>
                {effectivePublicUrl ? (
                  <span className="break-all font-mono text-text">{effectivePublicUrl}</span>
                ) : <span className="text-text-muted">—</span>}
              </Row>
              <Row label={t('viewerSettings.viewer.binary')}>
                {tunnel.tunnel.binaryFound ? (
                  <span className="font-mono text-text">{tunnel.tunnel.binaryPath}</span>
                ) : (
                  <span className="text-warning">{t('viewerSettings.viewer.binaryMissing')}</span>
                )}
              </Row>
              {tunnel.tunnel.lastError && (
                <Row label={t('viewerSettings.viewer.lastError')}>
                  <span className="break-words text-danger">{tunnel.tunnel.lastError}</span>
                </Row>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-dim">{t('viewerSettings.viewer.tunnelLoading')}</p>
          )}
        </div>
      )}

      {/* Thresholds */}
      <h3 className="border-t border-border px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-text-dim">
        {t('viewerSettings.viewer.thresholds')}
      </h3>
      <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-4">
        <Field label={t('viewerSettings.viewer.chars')} hint={t('viewerSettings.viewer.charsHint')}>
          <NumberInput value={draft.chars} onChange={(v) => setField('chars', v)} min={100} max={10000} placeholder="500" />
        </Field>
        <Field label={t('viewerSettings.viewer.lines')} hint={t('viewerSettings.viewer.linesHint')}>
          <NumberInput value={draft.lines} onChange={(v) => setField('lines', v)} min={5} max={200} placeholder="12" />
        </Field>
        <Field label={t('viewerSettings.viewer.codeLines')} hint={t('viewerSettings.viewer.codeLinesHint')}>
          <NumberInput value={draft.codeLines} onChange={(v) => setField('codeLines', v)} min={5} max={200} placeholder="10" />
        </Field>
        <Field label={t('viewerSettings.viewer.maxPastes')} hint={t('viewerSettings.viewer.maxPastesHint')}>
          <NumberInput value={draft.maxPastes} onChange={(v) => setField('maxPastes', v)} min={100} max={1000000} placeholder="10000" />
        </Field>
      </div>

      {/* Save bar */}
      {isDirty && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Badge variant="info">{t('viewerSettings.dirtyHint')}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onDiscard}
            disabled={updateEnv.isPending}
          >
            <X className="h-4 w-4" />
            {t('viewerSettings.discard')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateEnv.isPending}
          >
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {updateEnv.isPending ? t('viewerSettings.saving') : t('viewerSettings.save')}
          </Button>
        </div>
      )}
    </section>
  )
}

/* ─────────────── Baidu Maps card ─────────────── */

function isMasked(s: string): boolean {
  return /\*{3,}/.test(s)
}

function BaiduCard({ env }: { env: Record<string, string> }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const updateEnv = useUpdateEnv()

  const currentAk = env.AGIM_BAIDU_MAP_AK ?? ''
  const [draftAk, setDraftAk] = useState(currentAk)
  const [syncedHash, setSyncedHash] = useState('')

  useEffect(() => {
    if (currentAk !== syncedHash) {
      setDraftAk(currentAk)
      setSyncedHash(currentAk)
    }
  }, [currentAk, syncedHash])

  const isConfigured = !!currentAk
  // Treat masked echo as no-change. Operator either typed something
  // new, or cleared. AK validity = looks-suspicious warning.
  const isDirty = draftAk !== currentAk && !(isMasked(draftAk) && draftAk === currentAk)
  const suspicious = draftAk.length > 0 && !isMasked(draftAk) && draftAk.length !== 32

  async function onSave(): Promise<void> {
    if (!isDirty) return
    if (isMasked(draftAk)) return // server would skip anyway; be explicit
    try {
      await updateEnv.mutateAsync({
        updates: { AGIM_BAIDU_MAP_AK: draftAk.trim() || null },
      })
      toast.success(t('viewerSettings.baidu.toast.saved'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function onClear(): Promise<void> {
    try {
      await updateEnv.mutateAsync({ updates: { AGIM_BAIDU_MAP_AK: null } })
      setDraftAk('')
      toast.success(t('viewerSettings.baidu.toast.cleared'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MapPin className="h-4 w-4 text-text-dim" />
        <h2 className="text-sm font-semibold">{t('viewerSettings.baidu.title')}</h2>
        {isConfigured
          ? <Badge variant="success">{t('viewerSettings.baidu.configured')}</Badge>
          : <Badge variant="outline">{t('viewerSettings.baidu.empty')}</Badge>}
      </header>
      <p className="px-4 pt-2 text-xs text-text-dim">{t('viewerSettings.baidu.subtitle')}</p>

      <div className="px-4 py-3">
        <Label htmlFor="baidu-ak" className="text-xs font-medium">AGIM_BAIDU_MAP_AK</Label>
        <Input
          id="baidu-ak"
          value={draftAk}
          onChange={(e) => setDraftAk(e.target.value)}
          placeholder={t('viewerSettings.baidu.placeholder')}
          autoComplete="off"
          className={cn('mt-1 font-mono text-xs', isMasked(draftAk) && 'text-text-muted')}
        />
        {suspicious && (
          <p className="mt-1 text-[11px] text-warning">
            {t('viewerSettings.baidu.suspicious', { length: draftAk.length })}
          </p>
        )}
        <p className="mt-1 text-[11px] text-text-dim">{t('viewerSettings.baidu.hint')}</p>
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onClear()}
          disabled={!isConfigured || updateEnv.isPending}
          className="text-danger hover:text-danger"
        >
          <X className="h-4 w-4" />
          {t('viewerSettings.baidu.clear')}
        </Button>
        <span className="ml-auto" />
        {isDirty && (
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={updateEnv.isPending || isMasked(draftAk)}
          >
            {updateEnv.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Save className="h-4 w-4" />}
            {updateEnv.isPending ? t('viewerSettings.saving') : t('viewerSettings.save')}
          </Button>
        )}
      </div>
    </section>
  )
}

/* ─────────────── Helpers ─────────────── */

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-text-dim">{hint}</p>}
    </div>
  )
}

interface RowProps {
  label: string
  children: React.ReactNode
}

function Row({ label, children }: RowProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="shrink-0 font-medium text-text-dim">{label}:</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

interface NumberInputProps {
  value: string
  onChange: (v: string) => void
  min?: number
  max?: number
  placeholder?: string
}

function NumberInput({ value, onChange, min, max, placeholder }: NumberInputProps): JSX.Element {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}
