/**
 * Composer-docked Subagent detail sheet.
 *
 * Portals into `[data-agim-composer-sheet-root]` so horizontal centering
 * matches the chat content column (not the full viewport — avoids sidebar
 * skew). Expands upward above the input with max-height + internal scroll.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Bot,
  Expand,
  Loader2,
  Minimize2,
  X,
} from 'lucide-react'

import { MarkdownView } from '@/components/chat/markdown-view'
import { api } from '@/lib/api/endpoints'
import { loadTabThreadId } from '@/lib/web-sessions'
import type { Job } from '@/types/api'
import type { ChatActivityStep } from '@/hooks/use-chat'
import { resolveSubagentJobId, isSubagentLive } from '@/lib/activity-subagent'
import { cn } from '@/lib/utils'

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
  const [expanded, setExpanded] = useState(false)
  const [sheetRoot, setSheetRoot] = useState<HTMLElement | null>(null)

  const jobId = step ? resolveSubagentJobId(step) : undefined
  const live = step ? isSubagentLive(step) : false
  const portalColumn = sheetRoot?.getAttribute('data-agim-sheet-column') === 'portal'
  const docked = !!sheetRoot

  useEffect(() => {
    if (!open) {
      setExpanded(false)
      return
    }
    setSheetRoot(document.querySelector<HTMLElement>('[data-agim-composer-sheet-root]'))
  }, [open])

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
        let threadId: string | undefined
        try {
          threadId = loadTabThreadId() || undefined
        } catch { /* ignore */ }
        const res = await api.getJob(jobId, threadId ? { threadId } : undefined)
        if (cancelled) return
        setJob(res.job)
        setLoading(false)
        const stillRunning = res.job.status === 'pending' || res.job.status === 'running' || live
        if (stillRunning) {
          timer = setTimeout(() => { void load() }, 1200)
        }
      } catch (err) {
        if (cancelled) return
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
        // Auth errors will not clear on retry — stop polling.
        const msg = err instanceof Error ? err.message : String(err)
        if (/admin role required|AUTH_ADMIN_REQUIRED|403/i.test(msg)) return
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
  const failText = job?.error || (step?.status === 'error' ? step.preview : undefined)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={sheetRoot ?? undefined}>
        <DialogPrimitive.Overlay
          className={cn(
            docked ? 'absolute inset-0' : 'fixed inset-0',
            'z-50 bg-black/30 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            // Center on the content column (sheet root), same as max-w-3xl / 750px stream.
            docked ? 'absolute' : 'fixed',
            'left-1/2 z-50 -translate-x-1/2',
            'bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))]',
            portalColumn
              ? 'w-[calc(100%-2rem)] max-w-[750px]'
              : 'w-[calc(100%-1.5rem)] max-w-3xl sm:w-[calc(100%-2rem)]',
            'flex flex-col overflow-hidden',
            expanded
              ? 'max-h-[min(88dvh,820px)]'
              : 'max-h-[min(62dvh,560px)]',
            'rounded-2xl border shadow-2xl',
            'duration-200',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:slide-in-from-bottom-4',
            dark
              ? 'border-zinc-800 bg-zinc-950 text-zinc-100'
              : 'border-border bg-surface text-text',
          )}
        >
          <header className={cn(
            'flex shrink-0 items-center gap-2 border-b px-4 py-3',
            dark ? 'border-zinc-800' : 'border-border/70',
          )}
          >
            <Bot className={cn('h-4 w-4 shrink-0', dark ? 'text-teal-400' : 'text-accent')} />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold leading-tight tracking-tight">
                {t('chat.subagentDetailTitle', {
                  agent: step?.label ?? '—',
                  defaultValue: 'Subagent · {{agent}}',
                })}
              </DialogPrimitive.Title>
              <p className={cn('truncate text-[11px]', dark ? 'text-zinc-500' : 'text-text-muted')}>
                {jobId != null
                  ? t('chat.subagentDetailJob', {
                      jobId,
                      defaultValue: 'Job #{{jobId}}',
                    })
                  : t('chat.subagentDetailNoJob', {
                      defaultValue: 'No job id on this step yet.',
                    })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                'rounded-md p-1.5 transition',
                dark
                  ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                  : 'text-text-dim hover:bg-surface-2 hover:text-text',
              )}
              aria-label={expanded
                ? t('chat.subagentSheetCollapse', { defaultValue: 'Collapse sheet' })
                : t('chat.subagentSheetExpand', { defaultValue: 'Expand sheet' })}
              title={expanded
                ? t('chat.subagentSheetCollapse', { defaultValue: 'Collapse sheet' })
                : t('chat.subagentSheetExpand', { defaultValue: 'Expand sheet' })}
            >
              {expanded
                ? <Minimize2 className="h-4 w-4" />
                : <Expand className="h-4 w-4" />}
            </button>
            <DialogPrimitive.Close
              className={cn(
                'rounded-md p-1.5 transition',
                dark
                  ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                  : 'text-text-dim hover:bg-surface-2 hover:text-text',
              )}
              aria-label={t('actions.close', { defaultValue: 'Close' })}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
            <section className="space-y-1.5">
              <h3 className={cn(
                'text-[11px] font-semibold uppercase tracking-wide',
                dark ? 'text-zinc-500' : 'text-text-muted',
              )}
              >
                {t('chat.subagentPromptHeading', { defaultValue: 'Parent prompt' })}
              </h3>
              {prompt ? (
                <div
                  data-testid="subagent-prompt-markdown"
                  className={cn(
                    'min-w-0 break-words rounded-xl px-3 py-2.5 text-sm leading-relaxed',
                    dark ? 'bg-zinc-900 text-zinc-200' : 'bg-surface-2 text-text',
                  )}
                >
                  <MarkdownView
                    content={prompt}
                    className={cn(
                      'break-words text-sm leading-relaxed',
                      dark ? 'text-zinc-200' : 'text-text',
                    )}
                  />
                </div>
              ) : (
                <pre className={cn(
                  'whitespace-pre-wrap break-words rounded-xl px-3 py-2.5 font-mono text-[12px] leading-relaxed',
                  dark ? 'bg-zinc-900 text-zinc-300' : 'bg-surface-2 text-text-dim',
                )}
                >
                  {loading
                    ? t('chat.subagentLoading', { defaultValue: 'Loading…' })
                    : t('chat.subagentPromptEmpty', { defaultValue: 'Prompt not available yet.' })}
                </pre>
              )}
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
                  'whitespace-pre-wrap break-words rounded-xl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-danger',
                  dark ? 'bg-zinc-900' : 'bg-surface-2',
                )}
                >
                  {failText}
                </pre>
              ) : result ? (
                <div
                  data-testid="subagent-result-markdown"
                  className={cn(
                    'min-w-0 break-words rounded-xl px-3 py-2.5 text-sm leading-relaxed',
                    dark ? 'bg-zinc-900 text-zinc-200' : 'bg-surface-2 text-text',
                  )}
                >
                  <MarkdownView
                    content={result}
                    className={cn(
                      'break-words text-sm leading-relaxed',
                      dark ? 'text-zinc-200' : 'text-text',
                    )}
                  />
                </div>
              ) : (
                <pre className={cn(
                  'whitespace-pre-wrap break-words rounded-xl px-3 py-2.5 font-mono text-[12px] leading-relaxed',
                  dark ? 'bg-zinc-900 text-zinc-300' : 'bg-surface-2 text-text-dim',
                )}
                >
                  {live
                    ? t('chat.subagentResultRunning', { defaultValue: 'Subagent still running…' })
                    : (loading
                        ? t('chat.subagentLoading', { defaultValue: 'Loading…' })
                        : t('chat.subagentResultEmpty', { defaultValue: 'No result recorded.' }))}
                </pre>
              )}
              {error && (
                <p className="text-xs text-danger">{error}</p>
              )}
            </section>
            {step?.reflects && step.reflects.length > 0 && (
              <section className="space-y-1.5">
                <h3 className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide',
                  dark ? 'text-zinc-500' : 'text-text-muted',
                )}
                >
                  {t('chat.subagentReflectHeading', { defaultValue: 'Step reflect' })}
                </h3>
                <ul className="space-y-1">
                  {step.reflects.map((rec) => (
                    <li
                      key={`${rec.at}-${rec.next}`}
                      className={cn(
                        'rounded-xl px-3 py-2 text-sm leading-relaxed',
                        dark ? 'bg-zinc-900 text-zinc-200' : 'bg-surface-2 text-text',
                      )}
                    >
                      <span className="mr-1.5 text-[10px] uppercase tracking-wide text-teal-600">
                        {rec.stance}
                      </span>
                      {rec.next}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
