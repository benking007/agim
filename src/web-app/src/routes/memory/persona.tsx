/**
 * /memory/persona — view + edit the per-user persona summary +
 * trigger the consolidation pass.
 *
 * Layout: status strip (last consolidate run + button) on top, then
 * the persona editor (textarea + Save + Delete). The editor enters
 * an "unsaved changes" state when the textarea diverges from the
 * server-rendered summary; Save flips back to clean.
 *
 * Consolidate flow:
 *   * Trigger button POSTs /api/memory/consolidate; the backend
 *     replies 202 with a jobId.
 *   * /api/memory/consolidate/status is polled every 3s by the
 *     hook so the operator sees phase transitions live (running →
 *     done / failed) without manual refresh.
 *   * On `done`, the persona query is invalidated — the new
 *     summary appears in the textarea automatically.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Brain, CheckCircle, Loader2, Play, RefreshCcw, Trash2, XCircle } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  useMemoryPersona,
  useUpdatePersona,
  useDeletePersona,
  useConsolidateStatus,
  useTriggerConsolidate,
} from '@/hooks/use-memory'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import type { ConsolidateJob } from '@/types/api'

export default function MemoryPersonaRoute(): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])
  const [params] = useSearchParams()
  const userKey = params.get('user') ?? ''

  if (!userKey) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={<Brain />}
          title={t('noUserSelected.title')}
          description={t('noUserSelected.description')}
        />
      </div>
    )
  }

  return <PersonaEditor userKey={userKey} />
}

interface PersonaEditorProps {
  userKey: string
}

function PersonaEditor({ userKey }: PersonaEditorProps): JSX.Element {
  const { t } = useTranslation(['memory', 'common'])
  const personaQuery = useMemoryPersona(userKey)
  const persona = personaQuery.data

  const consolidate = useTriggerConsolidate()
  const status = useConsolidateStatus()
  const latestJob = status.data?.jobs[0]

  const updatePersona = useUpdatePersona()
  const deletePersona = useDeletePersona()
  const [confirmDelete, setConfirmDelete] = useState(false)

  /** Editor state — initialised from the server summary; tracks
   *  dirtiness via reference comparison after each save. */
  const [draft, setDraft] = useState(persona?.summary ?? '')
  useEffect(() => {
    setDraft(persona?.summary ?? '')
  }, [persona?.summary])
  const dirty = draft !== (persona?.summary ?? '')

  async function onSave(): Promise<void> {
    const trimmed = draft.trim()
    if (!trimmed) return
    try {
      await updatePersona.mutateAsync({ user_key: userKey, body: { summary: trimmed } })
      toast.success(t('persona.saved'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  async function onConfirmDelete(): Promise<void> {
    try {
      await deletePersona.mutateAsync(userKey)
      toast.success(t('common:actions.delete'))
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
      throw err
    }
  }

  async function onTrigger(): Promise<void> {
    try {
      await consolidate.mutateAsync()
    } catch (err) {
      const { message } = describeError(err, t)
      toast.error(message)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('persona.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => personaQuery.refetch()}
            disabled={personaQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {personaQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('persona.subtitle')}</p>
      </header>

      {/* Consolidate strip */}
      <div className="rounded-md border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-sm text-text">{t('persona.consolidate.trigger')}</span>
          <ConsolidateBadge job={latestJob} />
          <Button
            variant="default"
            size="sm"
            onClick={() => void onTrigger()}
            disabled={consolidate.isPending || latestJob?.phase === 'running'}
            className="ml-auto"
          >
            {consolidate.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Play className="h-4 w-4" />}
            {consolidate.isPending
              ? t('persona.consolidate.triggering')
              : t('persona.consolidate.trigger')}
          </Button>
        </div>
        {latestJob?.phase === 'done' && (latestJob.result.users != null || latestJob.result.updated != null) && (
          <p className="mt-2 text-xs text-text-dim">
            {t('persona.consolidate.result', {
              users:   latestJob.result.users ?? 0,
              updated: latestJob.result.updated ?? 0,
            })}
          </p>
        )}
        {latestJob?.phase === 'failed' && latestJob.result.error && (
          <p className="mt-2 text-xs text-danger">{latestJob.result.error}</p>
        )}
      </div>

      {/* Editor */}
      {personaQuery.isLoading ? (
        <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : !persona ? (
        <>
          <EmptyState
            icon={<Brain />}
            title={t('persona.empty.title')}
            description={t('persona.empty.description')}
          />
          {/* Even with no persona, the operator can still type one in
              and save — the upsert handler creates a new row. */}
          <PersonaTextarea
            draft={draft}
            onChange={setDraft}
            onSave={() => void onSave()}
            saving={updatePersona.isPending}
            dirty={dirty}
            canDelete={false}
            onDelete={() => setConfirmDelete(true)}
          />
        </>
      ) : (
        <>
          {persona.updated_at > 0 && (
            <div className="text-xs text-text-dim">
              {t('persona.updated', { at: formatEpoch(persona.updated_at) })}
            </div>
          )}
          <PersonaTextarea
            draft={draft}
            onChange={setDraft}
            onSave={() => void onSave()}
            saving={updatePersona.isPending}
            dirty={dirty}
            canDelete
            onDelete={() => setConfirmDelete(true)}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('persona.confirmDelete')}
        description={t('persona.confirmDeleteDesc')}
        intent="danger"
        confirmLabel={t('persona.delete')}
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

interface PersonaTextareaProps {
  draft: string
  onChange: (next: string) => void
  onSave: () => void
  saving: boolean
  dirty: boolean
  canDelete: boolean
  onDelete: () => void
}

function PersonaTextarea({
  draft, onChange, onSave, saving, dirty, canDelete, onDelete,
}: PersonaTextareaProps): JSX.Element {
  const { t } = useTranslation('memory')
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="persona-editor" className="text-sm text-text-dim">
        {t('persona.editorLabel')}
      </Label>
      <textarea
        id="persona-editor"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        className={cn(
          'w-full resize-y rounded-md border bg-bg px-3 py-2',
          'font-mono text-sm leading-6',
          'focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg',
          dirty ? 'border-accent' : 'border-border',
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        {canDelete && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
            {t('persona.delete')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={!dirty || saving || draft.trim().length === 0}
          onClick={onSave}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('persona.save')}
        </Button>
      </div>
    </div>
  )
}

interface ConsolidateBadgeProps {
  job: ConsolidateJob | undefined
}

function ConsolidateBadge({ job }: ConsolidateBadgeProps): JSX.Element | null {
  const { t } = useTranslation('memory')
  if (!job) return null
  if (job.phase === 'running') {
    return (
      <Badge variant="info">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('persona.consolidate.running')}
      </Badge>
    )
  }
  if (job.phase === 'done') {
    return (
      <Badge variant="success">
        <CheckCircle className="h-3 w-3" />
        {t('persona.consolidate.lastRun', { at: formatEpoch(job.finishedAt ?? job.startedAt) })}
      </Badge>
    )
  }
  return (
    <Badge variant="danger">
      <XCircle className="h-3 w-3" />
      {t('persona.consolidate.doneFailed')}
    </Badge>
  )
}

function formatEpoch(ms: number): string {
  try {
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return String(ms)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ms)
  }
}
