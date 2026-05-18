/**
 * /settings/workspaces — multi-tenant workspace registry editor.
 *
 * Lists every workspace (id / name / agent whitelist count / member
 * count / rate-limit) and provides an inline form to add new ones
 * or upsert existing. The backend's POST handler is upsert-by-id, so
 * editing means "click Edit on a row → form pre-fills → tweak → Save"
 * — same endpoint, same semantics as Add.
 *
 * Open vs gated workspaces:
 *   * `members: []` (empty array) means the workspace is open to any
 *     user. The backend treats `undefined` and `[]` identically; we
 *     normalise to `[]` for the round-trip.
 *   * `agents: []` means "allow every registered agent".
 *
 * Rate-limit fields are optional triple (rate / intervalSec / burst).
 * Leaving them blank submits `rateLimit: undefined` and the backend
 * falls back to defaults.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Briefcase, Loader2, Pencil, RefreshCcw, Save } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpsertWorkspace, useWorkspaces } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import type { WorkspaceConfig } from '@/types/api'

interface DraftFields {
  id: string
  name: string
  agents: string         // comma-separated
  members: string        // comma-separated
  rate: string
  intervalSec: string
  burst: string
}

const EMPTY_DRAFT: DraftFields = {
  id: '', name: '',
  agents: '', members: '',
  rate: '', intervalSec: '', burst: '',
}

function toDraft(ws: WorkspaceConfig): DraftFields {
  return {
    id: ws.id,
    name: ws.name,
    agents: ws.agents.join(', '),
    members: (ws.members ?? []).join(', '),
    rate:        ws.rateLimit ? String(ws.rateLimit.rate)        : '',
    intervalSec: ws.rateLimit ? String(ws.rateLimit.intervalSec) : '',
    burst:       ws.rateLimit ? String(ws.rateLimit.burst)       : '',
  }
}

function fromDraft(d: DraftFields): WorkspaceConfig {
  const splitCsv = (s: string): string[] =>
    s.split(',').map((x) => x.trim()).filter(Boolean)
  const cfg: WorkspaceConfig = {
    id:      d.id.trim(),
    name:    d.name.trim() || d.id.trim(),
    agents:  splitCsv(d.agents),
    members: splitCsv(d.members),
  }
  // Rate limit only when all three fields parse as positive numbers.
  const rate    = Number(d.rate)
  const ivl     = Number(d.intervalSec)
  const burst   = Number(d.burst)
  if (Number.isFinite(rate) && rate > 0
   && Number.isFinite(ivl)  && ivl > 0
   && Number.isFinite(burst) && burst > 0) {
    cfg.rateLimit = { rate, intervalSec: ivl, burst }
  }
  return cfg
}

export default function SettingsWorkspacesRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const list = useWorkspaces()
  const upsert = useUpsertWorkspace()

  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    if (draft.id || draft.name) return
    // Keep the form blank on first paint; pre-fill happens via Edit.
  }, [draft.id, draft.name])

  function startEdit(ws: WorkspaceConfig): void {
    setDraft(toDraft(ws))
    setEditing(ws.id)
  }

  function resetForm(): void {
    setDraft(EMPTY_DRAFT)
    setEditing(null)
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const cfg = fromDraft(draft)
    if (!cfg.id) return
    try {
      await upsert.mutateAsync(cfg)
      toast.success(t('workspaces.toast.saved'))
      resetForm()
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  const workspaces = list.data?.workspaces ?? []
  const hasOnlyDefault = workspaces.length <= 1
    && workspaces.every((w) => w.id === 'default')

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('workspaces.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {list.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('workspaces.subtitle')}</p>
      </header>

      {list.isLoading ? (
        <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
      ) : hasOnlyDefault ? (
        <EmptyState
          icon={<Briefcase />}
          title={t('workspaces.empty.title')}
          description={t('workspaces.empty.description')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">{t('workspaces.col.id')}</TableHead>
              <TableHead>{t('workspaces.col.name')}</TableHead>
              <TableHead>{t('workspaces.col.agents')}</TableHead>
              <TableHead>{t('workspaces.col.members')}</TableHead>
              <TableHead>{t('workspaces.col.rateLimit')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((ws) => (
              <TableRow key={ws.id}>
                <TableCell className="font-mono text-xs">{ws.id}</TableCell>
                <TableCell className="font-medium">{ws.name}</TableCell>
                <TableCell>
                  {ws.agents.length === 0 ? (
                    <span className="text-text-muted text-xs">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {ws.agents.map((a) => (
                        <Badge key={a} variant="secondary">{a}</Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {(ws.members ?? []).length === 0 ? (
                    <span className="text-text-muted text-xs">{t('workspaces.membersOpen')}</span>
                  ) : (
                    <span className="text-text-dim text-xs">
                      {t('workspaces.membersCount', { count: ws.members!.length })}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-text-dim">
                  {ws.rateLimit
                    ? t('workspaces.rateLimitFormat', {
                        rate: ws.rateLimit.rate,
                        intervalSec: ws.rateLimit.intervalSec,
                        burst: ws.rateLimit.burst,
                      })
                    : '—'}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(ws)}
                  >
                    <Pencil className="h-3 w-3" />
                    {t('workspaces.edit')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Form */}
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="rounded-md border border-border bg-surface p-4"
      >
        <div className="mb-1 text-sm font-medium">{t('workspaces.form.title')}</div>
        {editing && (
          <p className="mb-3 text-xs text-text-dim">{t('workspaces.form.subtitleEdit')}</p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            id="ws-id"
            label={t('workspaces.form.id')}
            hint={t('workspaces.form.idHint')}
            value={draft.id}
            onChange={(v) => setDraft((d) => ({ ...d, id: v }))}
            placeholder="team-foo"
            mono
          />
          <FormField
            id="ws-name"
            label={t('workspaces.form.name')}
            value={draft.name}
            onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
            placeholder="Team Foo"
          />
          <FormField
            id="ws-agents"
            label={t('workspaces.form.agents')}
            hint={t('workspaces.form.agentsHint')}
            value={draft.agents}
            onChange={(v) => setDraft((d) => ({ ...d, agents: v }))}
            placeholder="claude-code, codex"
            mono
          />
          <FormField
            id="ws-members"
            label={t('workspaces.form.members')}
            hint={t('workspaces.form.membersHint')}
            value={draft.members}
            onChange={(v) => setDraft((d) => ({ ...d, members: v }))}
            placeholder="wechat:wxid_abc, telegram:12345"
            mono
          />
        </div>
        <div className="mt-3">
          <div className="text-xs font-medium text-text-dim">{t('workspaces.form.rateLimit')}</div>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <FormField
              id="ws-rate"
              label={t('workspaces.form.rate')}
              value={draft.rate}
              onChange={(v) => setDraft((d) => ({ ...d, rate: v }))}
              placeholder="10"
              mono
            />
            <FormField
              id="ws-ivl"
              label={t('workspaces.form.intervalSec')}
              value={draft.intervalSec}
              onChange={(v) => setDraft((d) => ({ ...d, intervalSec: v }))}
              placeholder="60"
              mono
            />
            <FormField
              id="ws-burst"
              label={t('workspaces.form.burst')}
              value={draft.burst}
              onChange={(v) => setDraft((d) => ({ ...d, burst: v }))}
              placeholder="15"
              mono
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={resetForm}
            disabled={upsert.isPending}
          >
            {t('workspaces.form.reset')}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="ml-auto"
            disabled={upsert.isPending || !draft.id.trim()}
          >
            {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('workspaces.form.submit')}
          </Button>
        </div>
      </form>
    </div>
  )
}

interface FormFieldProps {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}

function FormField({ id, label, hint, value, onChange, placeholder, mono }: FormFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-text-dim">{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? 'font-mono text-xs' : ''}
      />
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </div>
  )
}
