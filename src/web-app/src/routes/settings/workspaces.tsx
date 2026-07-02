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

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Briefcase, Loader2, Pencil, Plus, RefreshCcw, Save, Trash2, X } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAgentsStatus } from '@/hooks/use-workspace'
import { useAdminAllowlist, useDeleteWorkspace, useUpsertWorkspace, useWorkspaces } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import type { KnownImUser, WorkspaceConfig } from '@/types/api'

interface DraftFields {
  id: string
  name: string
  agents: string[]
  members: string[]
  rate: string
  intervalSec: string
  burst: string
}

interface Choice {
  value: string
  label: string
  detail?: string
  badge?: string
  muted?: boolean
}

interface RatePreset {
  id: 'default' | 'strict' | 'busy'
  labelKey: string
  descriptionKey: string
  rate: string
  intervalSec: string
  burst: string
}

const EMPTY_DRAFT: DraftFields = {
  id: '', name: '',
  agents: [], members: [],
  rate: '', intervalSec: '', burst: '',
}

const RATE_PRESETS: RatePreset[] = [
  {
    id: 'default',
    labelKey: 'workspaces.form.ratePresets.default',
    descriptionKey: 'workspaces.form.ratePresetDescriptions.default',
    rate: '',
    intervalSec: '',
    burst: '',
  },
  {
    id: 'strict',
    labelKey: 'workspaces.form.ratePresets.strict',
    descriptionKey: 'workspaces.form.ratePresetDescriptions.strict',
    rate: '3',
    intervalSec: '60',
    burst: '5',
  },
  {
    id: 'busy',
    labelKey: 'workspaces.form.ratePresets.busy',
    descriptionKey: 'workspaces.form.ratePresetDescriptions.busy',
    rate: '30',
    intervalSec: '60',
    burst: '45',
  },
]

function toDraft(ws: WorkspaceConfig): DraftFields {
  return {
    id: ws.id,
    name: ws.name,
    agents: uniqueStrings(ws.agents),
    members: uniqueStrings(ws.members ?? []),
    rate:        ws.rateLimit ? String(ws.rateLimit.rate)        : '',
    intervalSec: ws.rateLimit ? String(ws.rateLimit.intervalSec) : '',
    burst:       ws.rateLimit ? String(ws.rateLimit.burst)       : '',
  }
}

function fromDraft(d: DraftFields): WorkspaceConfig {
  const cfg: WorkspaceConfig = {
    id:      d.id.trim(),
    name:    d.name.trim() || d.id.trim(),
    agents:  uniqueStrings(d.agents),
    members: uniqueStrings(d.members),
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

function isRatePresetActive(draft: DraftFields, preset: RatePreset): boolean {
  return draft.rate === preset.rate
    && draft.intervalSec === preset.intervalSec
    && draft.burst === preset.burst
}

export default function SettingsWorkspacesRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const list = useWorkspaces()
  const agentsQuery = useAgentsStatus()
  const adminsQuery = useAdminAllowlist()
  const upsert = useUpsertWorkspace()
  const removeWorkspace = useDeleteWorkspace()

  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceConfig | null>(null)

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

  async function onConfirmDelete(): Promise<void> {
    if (!deleteTarget) return
    try {
      await removeWorkspace.mutateAsync(deleteTarget.id)
      toast.success(t('workspaces.toast.deleted'))
      if (editing === deleteTarget.id) resetForm()
      setDeleteTarget(null)
    } catch (err) {
      toast.error(describeError(err, t).message)
      throw err
    }
  }

  function applyRatePreset(preset: RatePreset): void {
    setDraft((d) => ({
      ...d,
      rate: preset.rate,
      intervalSec: preset.intervalSec,
      burst: preset.burst,
    }))
  }

  const workspaces = list.data?.workspaces ?? []
  const hasOnlyDefault = workspaces.length <= 1
    && workspaces.every((w) => w.id === 'default')
  const agentChoices = useMemo<Choice[]>(() => {
    const status = agentsQuery.data ?? {}
    return Object.entries(status)
      .sort(([aName, aOnline], [bName, bOnline]) => {
        if (aOnline !== bOnline) return aOnline ? -1 : 1
        return aName.localeCompare(bName)
      })
      .map(([name, online]) => ({
        value: name,
        label: name,
        badge: online ? t('workspaces.form.agentOnline') : t('workspaces.form.agentOffline'),
        muted: !online,
      }))
  }, [agentsQuery.data, t])
  const memberChoices = useMemo<Choice[]>(() => {
    const m = new Map<string, Choice>()
    for (const u of adminsQuery.data?.knownUsers ?? []) {
      const key = imUserKey(u)
      m.set(key, {
        value: key,
        label: key,
        detail: t('workspaces.form.memberLastSeen', { time: formatSeenAt(u.lastSeenAt) }),
      })
    }
    for (const ws of workspaces) {
      for (const member of ws.members ?? []) {
        if (!member) continue
        if (!m.has(member)) {
          m.set(member, {
            value: member,
            label: member,
            detail: t('workspaces.form.memberFromScope', { scope: ws.id }),
          })
        }
      }
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [adminsQuery.data?.knownUsers, t, workspaces])

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
              <TableHead className="w-36" />
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
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => startEdit(ws)}
                    >
                      <Pencil className="h-3 w-3" />
                      {t('workspaces.edit')}
                    </Button>
                    {ws.id !== 'default' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(ws)}
                        disabled={removeWorkspace.isPending}
                        aria-label={t('workspaces.remove.ariaLabel', { id: ws.id })}
                      >
                        <Trash2 className="h-3 w-3" />
                        {t('workspaces.remove.label')}
                      </Button>
                    )}
                  </div>
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
          <MultiSelectField
            id="ws-agents"
            label={t('workspaces.form.agents')}
            hint={t('workspaces.form.agentsHint')}
            emptyText={t('workspaces.form.emptyAgents')}
            chooseLabel={t('workspaces.form.selectAgents')}
            customPlaceholder={t('workspaces.form.customAgentPlaceholder')}
            choices={agentChoices}
            value={draft.agents}
            loading={agentsQuery.isLoading}
            onChange={(agents) => setDraft((d) => ({ ...d, agents }))}
          />
          <MultiSelectField
            id="ws-members"
            label={t('workspaces.form.members')}
            hint={t('workspaces.form.membersHint')}
            emptyText={t('workspaces.form.emptyMembers')}
            chooseLabel={t('workspaces.form.selectMembers')}
            customPlaceholder={t('workspaces.form.customMemberPlaceholder')}
            choices={memberChoices}
            value={draft.members}
            loading={adminsQuery.isLoading || list.isLoading}
            onChange={(members) => setDraft((d) => ({ ...d, members }))}
          />
        </div>
        <div className="mt-3">
          <div className="text-xs font-medium text-text-dim">{t('workspaces.form.rateLimit')}</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {RATE_PRESETS.map((preset) => {
              const active = isRatePresetActive(draft, preset)
              return (
                <Button
                  key={preset.id}
                  type="button"
                  variant={active ? 'default' : 'secondary'}
                  size="sm"
                  className="h-auto flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
                  onClick={() => applyRatePreset(preset)}
                  aria-pressed={active}
                >
                  <span>{t(preset.labelKey)}</span>
                  <span className={cn('text-[10px] font-normal', active ? 'text-accent-fg/80' : 'text-text-muted')}>
                    {t(preset.descriptionKey)}
                  </span>
                </Button>
              )
            })}
          </div>
          <p className="mt-2 text-[10px] text-text-muted">{t('workspaces.form.ratePresetHint')}</p>
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

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('workspaces.remove.confirmTitle', { id: deleteTarget?.id ?? '' })}
        description={t('workspaces.remove.confirmDescription', { name: deleteTarget?.name ?? '' })}
        intent="danger"
        confirmLabel={t('workspaces.remove.confirm')}
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

function MultiSelectField({
  id,
  label,
  hint,
  emptyText,
  chooseLabel,
  customPlaceholder,
  choices,
  value,
  loading,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  emptyText: string
  chooseLabel: string
  customPlaceholder: string
  choices: Choice[]
  value: string[]
  loading?: boolean
  onChange: (next: string[]) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const [custom, setCustom] = useState('')
  const selected = uniqueStrings(value)
  const selectedSet = useMemo(() => new Set(selected), [selected])

  function toggle(nextValue: string): void {
    if (selectedSet.has(nextValue)) {
      onChange(selected.filter((v) => v !== nextValue))
    } else {
      onChange([...selected, nextValue])
    }
  }

  function remove(nextValue: string): void {
    onChange(selected.filter((v) => v !== nextValue))
  }

  function addCustom(): void {
    const parsed = uniqueStrings(custom.split(','))
    if (parsed.length === 0) return
    onChange(uniqueStrings([...selected, ...parsed]))
    setCustom('')
  }

  return (
    <div className="flex flex-col gap-1 sm:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label id={`${id}-label`} className="text-xs text-text-dim">
          {label}
        </Label>
        <Badge variant="secondary">{t('workspaces.form.selectedCount', { count: selected.length })}</Badge>
      </div>

      <div className="rounded-md border border-border bg-surface-2 p-2">
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {selected.length === 0 ? (
            <span className="px-1 text-xs text-text-muted">{emptyText}</span>
          ) : selected.map((item) => (
            <Badge key={item} variant="secondary" className="normal-case tracking-normal">
              <span className="font-mono">{item}</span>
              <button
                type="button"
                className="ml-1 rounded-full text-text-dim hover:text-text"
                onClick={() => remove(item)}
                aria-label={t('workspaces.form.removeSelected', { value: item })}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {chooseLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-80 overflow-y-auto">
              <DropdownMenuLabel>{chooseLabel}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {choices.length === 0 ? (
                <div className="px-2 py-2 text-sm text-text-muted">{t('workspaces.form.noChoices')}</div>
              ) : choices.map((choice) => (
                <DropdownMenuCheckboxItem
                  key={choice.value}
                  checked={selectedSet.has(choice.value)}
                  onCheckedChange={() => toggle(choice.value)}
                  onSelect={(event) => event.preventDefault()}
                  className={cn('items-start gap-2', choice.muted && 'text-text-muted')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{choice.label}</span>
                    {choice.detail && (
                      <span className="mt-0.5 block truncate text-xs text-text-muted">{choice.detail}</span>
                    )}
                  </span>
                  {choice.badge && (
                    <Badge variant={choice.muted ? 'outline' : 'success'}>{choice.badge}</Badge>
                  )}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex min-w-[220px] flex-1 gap-2">
            <Input
              id={id}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustom()
                }
              }}
              placeholder={customPlaceholder}
              className="h-7 font-mono text-xs"
              aria-labelledby={`${id}-label`}
            />
            <Button type="button" variant="secondary" size="sm" onClick={addCustom} disabled={!custom.trim()}>
              {t('workspaces.form.addCustom')}
            </Button>
          </div>
        </div>
      </div>
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
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

function uniqueStrings(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function imUserKey(user: KnownImUser): string {
  return `${user.platform}:${user.userId}`
}

function formatSeenAt(value: string): string {
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return value
  return dt.toLocaleString()
}
