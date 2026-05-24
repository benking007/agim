/**
 * /skills/hot — read-only browse of skillhub.cn's hot list.
 *
 * Backed by /api/skills/remote/hot (server proxies upstream with a
 * 5-min cache + stale-while-error). agim never auto-runs an install:
 * the detail dialog surfaces three copy-pasteable commands and the
 * operator decides where to execute.
 *
 * Restored from v1's tasks.html in 2026-05; the v2 SPA had the
 * installed-skills view but had dropped the hot list during the
 * memory-tab port.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Copy,
  Download,
  ExternalLink,
  Flame,
  Loader2,
  RefreshCcw,
  Search,
  Star,
} from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSkillsRemoteHot } from '@/hooks/use-skills'
import type { RemoteSkill } from '@/types/api'
import { cn } from '@/lib/utils'

export default function SkillsHotRoute(): JSX.Element {
  const { t } = useTranslation(['skills', 'common'])
  const { data, isLoading, isFetching, refetch } = useSkillsRemoteHot()

  const skills: RemoteSkill[] = data?.skills ?? []
  const [q, setQ] = useState('')
  const [openSlug, setOpenSlug] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return skills
    return skills.filter((s) =>
      s.slug.toLowerCase().includes(needle)
      || (s.name || '').toLowerCase().includes(needle)
      || (s.description || '').toLowerCase().includes(needle)
      || (s.category || '').toLowerCase().includes(needle)
    )
  }, [skills, q])

  const openSkill = openSlug ? skills.find((s) => s.slug === openSlug) ?? null : null

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold inline-flex items-center gap-2">
            <Flame className="h-5 w-5 text-warning" />
            {t('hot.title')}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
            >
              <a
                href="https://skillhub.cn"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">{t('hot.openHub')}</span>
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label={t('actions.refresh', { ns: 'common' })}
            >
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
            </Button>
          </div>
        </div>
        <p className="text-sm text-text-dim">{t('hot.subtitle')}</p>
        {data && (
          <CacheMeta
            cached={!!data.cached}
            stale={!!data.stale}
            fetchedAt={data.fetchedAt}
          />
        )}
      </header>

      {skills.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative flex-1 min-w-[180px] max-w-md">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('actions.search', { ns: 'common' })}
              className="pl-7"
            />
          </div>
          <Badge variant="secondary" className="ml-auto">
            {filtered.length} / {skills.length}
          </Badge>
        </div>
      )}

      {isLoading ? (
        <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : skills.length === 0 ? (
        <EmptyState icon={<Flame />} title={t('hot.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((s) => (
            <li key={s.slug}>
              <button
                type="button"
                onClick={() => setOpenSlug(s.slug)}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 text-left',
                  'transition-colors hover:border-border-strong hover:bg-surface-hover',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">{s.name || s.slug}</span>
                  {s.version && (
                    <span className="text-text-muted text-xs font-mono">v{s.version}</span>
                  )}
                  {s.category && (
                    <Badge variant="outline">{s.category}</Badge>
                  )}
                  <div className="ml-auto flex items-center gap-3 text-xs text-text-dim tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3 w-3" />
                      {formatNum(s.stars)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Download className="h-3 w-3" />
                      {formatNum(s.installs)}
                    </span>
                  </div>
                </div>
                <code className="text-text-muted text-xs font-mono">{s.slug}</code>
                {s.description && (
                  <p className="line-clamp-2 text-sm text-text-dim">{s.description}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <RemoteSkillDialog
        skill={openSkill}
        onOpenChange={(open) => { if (!open) setOpenSlug(null) }}
      />
    </div>
  )
}

function CacheMeta({
  cached,
  stale,
  fetchedAt,
}: {
  cached: boolean
  stale: boolean
  fetchedAt: number
}): JSX.Element | null {
  const { t } = useTranslation('skills')
  const when = useMemo(() => {
    try {
      const d = new Date(fetchedAt)
      if (Number.isNaN(d.getTime())) return ''
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    } catch {
      return ''
    }
  }, [fetchedAt])
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span>{t('hot.updatedAt', { at: when })}</span>
      {cached && <Badge variant="outline">{t('hot.cached')}</Badge>}
      {stale && <Badge variant="warning">{t('hot.stale')}</Badge>}
    </div>
  )
}

interface RemoteSkillDialogProps {
  skill: RemoteSkill | null
  onOpenChange: (open: boolean) => void
}

function RemoteSkillDialog({ skill, onOpenChange }: RemoteSkillDialogProps): JSX.Element {
  const { t } = useTranslation('skills')

  // Three copy-pasteable install paths. agim never executes them itself
  // — the operator chooses CLI or IM.
  const commands = useMemo(() => {
    if (!skill) return []
    return [
      { key: 'cliInstall', cmd: `skillhub install ${skill.slug}` },
      { key: 'cliSearch',  cmd: `skillhub search ${skill.slug}` },
      { key: 'imAsk',      cmd: `请用 skillhub 安装 ${skill.slug} 技能` },
    ]
  }, [skill])

  return (
    <Dialog open={skill != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill?.name || skill?.slug || ''}</DialogTitle>
          {skill?.description && (
            <DialogDescription>{skill.description}</DialogDescription>
          )}
        </DialogHeader>

        {skill && (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-text-dim">slug</dt>
              <dd className="font-mono">{skill.slug}</dd>
              {skill.version && (
                <>
                  <dt className="text-text-dim">{t('hot.detail.version')}</dt>
                  <dd className="font-mono">v{skill.version}</dd>
                </>
              )}
              {skill.category && (
                <>
                  <dt className="text-text-dim">{t('hot.detail.category')}</dt>
                  <dd>{skill.category}</dd>
                </>
              )}
              <dt className="text-text-dim">{t('hot.detail.stars')}</dt>
              <dd className="tabular-nums">{formatNum(skill.stars)}</dd>
              <dt className="text-text-dim">{t('hot.detail.installs')}</dt>
              <dd className="tabular-nums">{formatNum(skill.installs)}</dd>
              {skill.downloads != null && (
                <>
                  <dt className="text-text-dim">{t('hot.detail.downloads')}</dt>
                  <dd className="tabular-nums">{formatNum(skill.downloads)}</dd>
                </>
              )}
            </dl>

            <div className="mt-4 border-t border-border pt-3">
              <h3 className="text-sm font-medium">{t('hot.detail.howInstall')}</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {commands.map((c) => (
                  <li key={c.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                    <span className="text-xs text-text-dim sm:w-40 sm:shrink-0">
                      {t(`hot.detail.label.${c.key}`)}
                    </span>
                    <code className="flex-1 rounded bg-surface-2 px-2 py-1 font-mono text-xs break-all">
                      {c.cmd}
                    </code>
                    <CopyButton text={c.cmd} />
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-text-muted">{t('hot.detail.hint')}</p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation('skills')
  const [copied, setCopied] = useState(false)
  async function onClick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success(t('hot.detail.copied'))
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      toast.error(String((err as Error)?.message ?? err))
    }
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void onClick()}
      className="shrink-0"
    >
      <Copy className="h-3 w-3" />
      {copied ? t('hot.detail.copied') : t('hot.detail.copy')}
    </Button>
  )
}

function formatNum(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString()
}
