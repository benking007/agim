/**
 * Modal: Subagent parent prompt + execution result (fetched via GET /api/jobs/:id).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2 } from 'lucide-react'

import { api } from '@/lib/api/endpoints'
import type { Job } from '@/types/api'
import type { ChatActivityStep } from '@/hooks/use-chat'
import { resolveSubagentJobId, isSubagentLive } from '@/lib/activity-subagent'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface SubagentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  step: ChatActivityStep | null
  dark?: boolean
}

export function SubagentDetailDialog({
  open,
  onOpenChange,
  step,
  dark = false,
}: SubagentDetailDialogProps): JSX.Element {
  const { t } = useTranslation()
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const jobId = step ? resolveSubagentJobId(step) : undefined
  const live = step ? isSubagentLive(step) : false

  useEffect(() => {
    if (!open || !step || jobId == null) {
      setJob(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.getJob(jobId)
        if (cancelled) return
        setJob(res.job)
        setLoading(false)
        // Poll while the Subagent (or job) is still running.
        const stillRunning = res.job.status === 'pending' || res.job.status === 'running' || live
        if (stillRunning) {
          timer = setTimeout(() => { void load() }, 1200)
        }
      } catch (err) {
        if (cancelled) return
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
        if (live) timer = setTimeout(() => { void load() }, 2000)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, step, jobId, live])

  const prompt = job?.prompt
    || (live ? step?.preview : undefined)
    || ''
  const result = job?.result
    || (job?.error ? undefined : undefined)
  const failText = job?.error || (step?.status === 'error' ? step.preview : undefined)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-2xl', dark && 'border-zinc-800 bg-zinc-950 text-zinc-100')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className={cn('h-4 w-4', dark ? 'text-teal-400' : 'text-accent')} />
            {t('chat.subagentDetailTitle', {
              agent: step?.label ?? '—',
              defaultValue: 'Subagent · {{agent}}',
            })}
          </DialogTitle>
          <DialogDescription className={dark ? 'text-zinc-500' : undefined}>
            {jobId != null
              ? t('chat.subagentDetailJob', {
                  jobId,
                  defaultValue: 'Job #{{jobId}}',
                })
              : t('chat.subagentDetailNoJob', {
                  defaultValue: 'No job id on this step yet.',
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-1.5">
            <h3 className={cn(
              'text-[11px] font-semibold uppercase tracking-wide',
              dark ? 'text-zinc-500' : 'text-text-muted',
            )}
            >
              {t('chat.subagentPromptHeading', { defaultValue: 'Parent prompt' })}
            </h3>
            <pre className={cn(
              'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed',
              dark ? 'bg-zinc-900 text-zinc-300' : 'bg-surface-2 text-text-dim',
            )}
            >
              {prompt
                || (loading
                  ? t('chat.subagentLoading', { defaultValue: 'Loading…' })
                  : t('chat.subagentPromptEmpty', { defaultValue: 'Prompt not available yet.' }))}
            </pre>
          </section>

          <section className="space-y-1.5">
            <h3 className={cn(
              'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide',
              dark ? 'text-zinc-500' : 'text-text-muted',
            )}
            >
              {t('chat.subagentResultHeading', { defaultValue: 'Result' })}
              {live && <Loader2 className="h-3 w-3 animate-spin text-teal-500" />}
            </h3>
            {failText ? (
              <pre className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed text-danger',
                dark ? 'bg-zinc-900' : 'bg-surface-2',
              )}
              >
                {failText}
              </pre>
            ) : (
              <pre className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed',
                dark ? 'bg-zinc-900 text-zinc-300' : 'bg-surface-2 text-text-dim',
              )}
              >
                {result
                  || (live
                    ? t('chat.subagentResultRunning', { defaultValue: 'Subagent still running…' })
                    : (loading
                        ? t('chat.subagentLoading', { defaultValue: 'Loading…' })
                        : t('chat.subagentResultEmpty', { defaultValue: 'No result recorded.' })))}
              </pre>
            )}
            {error && (
              <p className="text-xs text-danger">{error}</p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
