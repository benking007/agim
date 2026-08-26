/**
 * Portal automation — cron tasks + run history.
 * Model/artifacts are stored in the prompt prefix (no extra API fields).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAgentsStatus } from '@/hooks/use-workspace'
import { useJobs } from '@/hooks/use-jobs'
import {
  useCreateSchedule, useDeleteSchedule, useSchedules, useUpdateSchedule,
} from '@/hooks/use-schedules'
import { useLlmList } from '@/hooks/use-llm-admin'
import {
  cronDailyAt, cronEveryMinutes, parseScheduleCron, parseSchedulePrompt, wrapSchedulePrompt,
} from '@/lib/schedule-prompt'
import { cn } from '@/lib/utils'
import type { Job, Schedule } from '@/types/api'
import { PortalSwitch } from './portal-switch'
import { PortalWorkspacePicker } from './portal-workspace-picker'

type EditorState = { mode: 'create' } | { mode: 'edit'; row: Schedule }

export function PortalAutomationPane(props: {
  dark: boolean
  defaultAgent: string
}): JSX.Element {
  const { t } = useTranslation()
  const { dark, defaultAgent } = props
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const schedulesQuery = useSchedules({})
  const jobsQuery = useJobs({ limit: 80, offset: 0, mine: true })
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const schedules = schedulesQuery.data?.schedules ?? []
  const runs = useMemo(
    () => (jobsQuery.data?.jobs ?? []).filter((job) => isScheduleJob(job)),
    [jobsQuery.data?.jobs],
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="portal-automation-pane">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <h2 className={cn('min-w-0 flex-1 text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-900')}>
          {t('chat.portal.automationTitle')}
        </h2>
        <button
          type="button"
          onClick={() => setEditor({ mode: 'create' })}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold',
            dark ? 'bg-zinc-800 text-teal-400 hover:bg-zinc-700' : 'bg-zinc-100 text-teal-600 hover:bg-zinc-200',
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('chat.portal.automationNew')}
        </button>
      </div>
      <div className={cn('flex shrink-0 gap-1 border-b px-3', dark ? 'border-zinc-800' : 'border-zinc-200')}>
        <TabButton dark={dark} active={tab === 'tasks'} onClick={() => setTab('tasks')}>
          {t('chat.portal.automationTabTasks')}
        </TabButton>
        <TabButton dark={dark} active={tab === 'runs'} onClick={() => setTab('runs')}>
          {t('chat.portal.automationTabRuns')}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tab === 'tasks' ? (
          schedulesQuery.isLoading ? (
            <Loading dark={dark} />
          ) : schedules.length === 0 ? (
            <p className="px-1 py-6 text-xs text-zinc-400">{t('chat.portal.automationEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {schedules.map((row) => {
                const parsed = parseSchedulePrompt(row.prompt)
                const enabled = Boolean(row.enabled)
                return (
                  <li
                    key={row.id}
                    className={cn('rounded-xl px-3 py-2.5', dark ? 'bg-zinc-900/60' : 'bg-white')}
                    data-testid={`portal-schedule-${row.id}`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-xs font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
                          {row.name}
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-400">
                          {row.agent}
                          {row.agent === 'agim' && parsed.meta.model ? ` · ${parsed.meta.model}` : ''}
                          {row.agent !== 'agim' ? ` · ${t('chat.portal.automationCliModel')}` : ''}
                          {' · '}
                          <code>{row.cron}</code>
                        </p>
                        {parsed.meta.artifacts && (
                          <p className="mt-1 truncate text-[11px] text-teal-500/90">
                            {t('chat.portal.automationRunArtifacts')}: {parsed.meta.artifacts}
                          </p>
                        )}
                        <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{parsed.body}</p>
                      </div>
                      <PortalSwitch
                        checked={enabled}
                        disabled={update.isPending}
                        label={t('chat.portal.automationEnabled')}
                        onCheckedChange={(next) => {
                          update.mutate({ id: row.id, body: { enabled: next } })
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setEditor({ mode: 'edit', row })}
                        className={cn('rounded-md p-1', dark ? 'text-zinc-500 hover:bg-zinc-800' : 'text-zinc-400 hover:bg-zinc-100')}
                        aria-label={t('chat.portal.automationEdit')}
                        data-testid={`portal-schedule-edit-${row.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove.mutate(row.id)}
                        className={cn('rounded-md p-1', dark ? 'text-zinc-500 hover:bg-zinc-800' : 'text-zinc-400 hover:bg-zinc-100')}
                        aria-label={t('chat.portal.automationDelete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )
        ) : jobsQuery.isLoading ? (
          <Loading dark={dark} />
        ) : runs.length === 0 ? (
          <p className="px-1 py-6 text-xs text-zinc-400">{t('chat.portal.automationRunsEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((job) => {
              const parsed = parseSchedulePrompt(job.prompt)
              return (
                <li
                  key={job.id}
                  className={cn('rounded-xl px-3 py-2.5', dark ? 'bg-zinc-900/60' : 'bg-white')}
                  data-testid={`portal-schedule-run-${job.id}`}
                >
                  <p className={cn('text-xs font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
                    #{job.id} · {job.agent} · {job.status}
                  </p>
                  {parsed.meta.artifacts && (
                    <p className="mt-1 truncate text-[11px] text-teal-500/90">
                      {t('chat.portal.automationRunArtifacts')}: {parsed.meta.artifacts}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{parsed.body}</p>
                  {job.result && (
                    <p className="mt-1 line-clamp-3 text-[11px] text-zinc-500">{job.result}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <ScheduleEditorDialog
        editor={editor}
        onOpenChange={(open) => { if (!open) setEditor(null) }}
        defaultAgent={defaultAgent}
      />
    </div>
  )
}

function isScheduleJob(job: Job): boolean {
  return job.prompt.startsWith('<!-- agim:schedule')
}

function TabButton(props: {
  dark: boolean
  active: boolean
  onClick: () => void
  children: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'border-b-2 px-3 py-2 text-xs font-semibold',
        props.active
          ? 'border-teal-500 text-teal-500'
          : (props.dark ? 'border-transparent text-zinc-500 hover:text-zinc-300' : 'border-transparent text-zinc-400 hover:text-zinc-700'),
      )}
    >
      {props.children}
    </button>
  )
}

function Loading(_props: { dark: boolean }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-xs text-zinc-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {t('states.loading')}
    </div>
  )
}

function ScheduleEditorDialog(props: {
  editor: EditorState | null
  onOpenChange: (open: boolean) => void
  defaultAgent: string
}): JSX.Element {
  const { t } = useTranslation()
  const { editor, onOpenChange, defaultAgent } = props
  const open = editor !== null
  const editing = editor?.mode === 'edit' ? editor.row : null
  const agentsQuery = useAgentsStatus()
  const llm = useLlmList()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const agentNames = Object.keys(agentsQuery.data ?? {}).sort()
  const backends = llm.data?.backends ?? []
  const [name, setName] = useState('')
  const [agent, setAgent] = useState(defaultAgent || 'agim')
  const [model, setModel] = useState('')
  const [mode, setMode] = useState<'interval' | 'daily'>('daily')
  const [minutes, setMinutes] = useState('30')
  const [time, setTime] = useState('09:00')
  const [prompt, setPrompt] = useState('')
  const [artifacts, setArtifacts] = useState('PROJECTS/schedule-output')
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    if (editing) {
      const parsed = parseSchedulePrompt(editing.prompt)
      const cronUi = parseScheduleCron(editing.cron)
      setName(editing.name)
      setAgent(editing.agent || defaultAgent || 'agim')
      setModel(parsed.meta.model || '')
      setMode(cronUi.mode)
      setMinutes(cronUi.minutes)
      setTime(cronUi.time)
      setPrompt(parsed.body)
      setArtifacts(parsed.meta.artifacts || '')
      return
    }
    setName('')
    setAgent(defaultAgent || 'agim')
    setModel('')
    setMode('daily')
    setMinutes('30')
    setTime('09:00')
    setPrompt('')
    setArtifacts('PROJECTS/schedule-output')
  }, [open, editing, defaultAgent])

  const isAgim = agent === 'agim' || agent === 'native'
  const selectedModel = model || backends[0]?.name || ''
  const pending = create.isPending || update.isPending

  function submit(): void {
    const cron = mode === 'interval' ? cronEveryMinutes(Number(minutes) || 30) : cronDailyAt(time)
    const wrapped = wrapSchedulePrompt(prompt.trim(), {
      model: isAgim ? selectedModel : undefined,
      artifacts,
    })
    if (editing) {
      update.mutate(
        { id: editing.id, body: { name: name.trim(), agent, cron, prompt: wrapped } },
        {
          onSuccess: () => onOpenChange(false),
          onError: (err) => toast.error(err.message),
        },
      )
      return
    }
    create.mutate(
      { name: name.trim(), agent, cron, prompt: wrapped, enabled: true },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => toast.error(err.message),
      },
    )
  }

  function handleOpenChange(next: boolean): void {
    if (!next && pickerOpen) return
    if (!next) setPickerOpen(false)
    onOpenChange(next)
  }

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => { if (pickerOpen) e.preventDefault() }}
        onFocusOutside={(e) => { if (pickerOpen) e.preventDefault() }}
        onInteractOutside={(e) => { if (pickerOpen) e.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? t('chat.portal.automationEdit') : t('chat.portal.automationNew')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t('chat.portal.automationName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('chat.portal.automationAgent')}>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(agentNames.length ? agentNames : [defaultAgent || 'agim']).map((id) => (
                  <SelectItem key={id} value={id}>{id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {isAgim ? (
            <Field label={t('chat.portal.automationModel')}>
              {backends.length === 0 ? (
                <p className="text-xs text-zinc-400">{t('chat.portal.automationNoModel')}</p>
              ) : (
                <Select value={selectedModel} onValueChange={setModel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {backends.map((b) => (
                      <SelectItem key={b.name} value={b.name}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[11px] text-zinc-400">{t('chat.portal.automationModelHint')}</p>
            </Field>
          ) : (
            <p className="text-[11px] text-zinc-400">{t('chat.portal.automationModelHint')}</p>
          )}
          <Field label={t('chat.portal.automationCron')}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('interval')}
                className={cn('rounded-md px-2 py-1 text-xs', mode === 'interval' ? 'bg-teal-500/15 text-teal-600' : 'text-zinc-400')}
              >
                {t('chat.portal.automationEveryN')}
              </button>
              <button
                type="button"
                onClick={() => setMode('daily')}
                className={cn('rounded-md px-2 py-1 text-xs', mode === 'daily' ? 'bg-teal-500/15 text-teal-600' : 'text-zinc-400')}
              >
                {t('chat.portal.automationDaily')}
              </button>
            </div>
            {mode === 'interval' ? (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={59}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  className="w-20"
                />
                <span className="text-xs text-zinc-400">{t('chat.portal.automationMinutes')}</span>
              </div>
            ) : (
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-2 w-36" />
            )}
          </Field>
          <Field label={t('chat.portal.automationPrompt')}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
          </Field>
          <Field label={t('chat.portal.automationArtifacts')}>
            <div className="flex gap-2">
              <Input
                data-testid="automation-artifacts-input"
                value={artifacts}
                onChange={(e) => setArtifacts(e.target.value)}
                placeholder={t('chat.portal.automationArtifactsPlaceholder')}
              />
              <Button
                type="button"
                variant="outline"
                data-testid="automation-artifacts-browse"
                className="shrink-0 gap-1.5"
                onClick={() => setPickerOpen(true)}
              >
                <Folder className="h-4 w-4" />
                {t('chat.portal.automationArtifactsBrowse')}
              </Button>
            </div>
            <p className="text-[11px] text-zinc-400">{t('chat.portal.automationArtifactsHint')}</p>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>{t('actions.cancel')}</Button>
          <Button
            onClick={submit}
            disabled={!name.trim() || !prompt.trim() || pending || (isAgim && !selectedModel)}
          >
            {pending
              ? t('states.saving')
              : editing ? t('chat.portal.automationSave') : t('chat.portal.automationCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <PortalWorkspacePicker
      open={pickerOpen}
      agentId={agent}
      pathKind="relative"
      initialPath={artifacts}
      onOpenChange={setPickerOpen}
      onPicked={(dir) => setArtifacts(dir.path)}
    />
    </>
  )
}

function Field(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  )
}
