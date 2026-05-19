/**
 * /skills/installed — read-only browse of SKILL.md files the host
 * agents pick up. Search + category filter; row click opens a
 * detail Dialog with the raw SKILL.md content.
 *
 * Moved from /memory/skills in 2026-05 so skills sit at the top
 * level. The render logic is unchanged from the previous home —
 * only the `useTranslation` namespace and i18n key prefix shifted.
 *
 * No markdown rendering for now: we'd need marked + DOMPurify to
 * safely render arbitrary skill content, and the raw text is what
 * the host agent reads anyway.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Loader2, RefreshCcw, Search } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSkills, useSkillDetail } from '@/hooks/use-skills'
import type { SkillMeta } from '@/types/api'
import { cn } from '@/lib/utils'

export default function SkillsInstalledRoute(): JSX.Element {
  const { t } = useTranslation(['skills', 'common'])
  const { data, isLoading, isFetching, refetch } = useSkills()
  const skills = data?.skills ?? []
  const sources = data?.sources

  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [openSlug, setOpenSlug] = useState<string | null>(null)

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const s of skills) set.add(s.category)
    return Array.from(set).sort()
  }, [skills])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return skills.filter((s) => {
      if (cat && s.category !== cat) return false
      if (!needle) return true
      return (
        s.slug.toLowerCase().includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle)
      )
    })
  }, [skills, q, cat])

  const grouped = useMemo(() => {
    const m = new Map<string, SkillMeta[]>()
    for (const s of filtered) {
      const arr = m.get(s.category) ?? []
      arr.push(s)
      m.set(s.category, arr)
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('installed.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('installed.subtitle')}</p>
      </header>

      {sources && (
        <div className="rounded-md border border-border bg-surface p-3 text-xs text-text-dim">
          <div className="font-medium text-text mb-1">{t('installed.sources.title')}</div>
          <div className="font-mono">
            <div>{t('installed.sources.claude')}: <span className="text-text">{sources.claude}</span></div>
            <div>{t('installed.sources.opencode')}: <span className="text-text">{sources.opencode}</span></div>
          </div>
        </div>
      )}

      {skills.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative flex-1 min-w-[180px] max-w-md">
            <Label htmlFor="skill-search" className="text-xs text-text-dim">
              {t('installed.filter.search')}
            </Label>
            <Search className="pointer-events-none absolute left-2 bottom-2 h-4 w-4 text-text-muted" />
            <Input
              id="skill-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-7 mt-1"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="skill-cat" className="text-xs text-text-dim">
              {t('installed.filter.category')}
            </Label>
            <Select
              value={cat ?? '__any__'}
              onValueChange={(v) => setCat(v === '__any__' ? null : v)}
            >
              <SelectTrigger id="skill-cat" className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">{t('installed.filter.categoryAny')}</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="h-48 w-full rounded-md bg-surface-2 animate-pulse" />
      ) : skills.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={t('installed.empty.title')}
          description={t('installed.empty.description')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([category, list]) => (
            <section key={category}>
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-text-dim">
                {category} · {list.length}
              </h2>
              <ul className="flex flex-col gap-2">
                {list.map((s) => (
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
                        <span className="font-medium text-text">{s.name}</span>
                        <span className="text-text-muted text-xs font-mono">{s.slug}</span>
                        <div className="ml-auto flex gap-1">
                          {s.agents.map((a) => (
                            <Badge key={a} variant="secondary">
                              {t(`installed.agentTag.${a}`, { defaultValue: a })}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <p className="line-clamp-2 text-sm text-text-dim">{s.description}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <SkillDetailDialog
        slug={openSlug}
        onOpenChange={(open) => { if (!open) setOpenSlug(null) }}
      />
    </div>
  )
}

interface SkillDetailDialogProps {
  slug: string | null
  onOpenChange: (open: boolean) => void
}

function SkillDetailDialog({ slug, onOpenChange }: SkillDetailDialogProps): JSX.Element {
  const { t } = useTranslation('skills')
  const { data, isLoading, isError } = useSkillDetail(slug)
  return (
    <Dialog open={slug != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{data?.name ?? slug ?? ''}</DialogTitle>
          {data && <DialogDescription>{data.description}</DialogDescription>}
        </DialogHeader>
        {isLoading ? (
          <div className="text-sm text-text-dim">{t('installed.detail.loading')}</div>
        ) : isError ? (
          <div className="text-sm text-danger">{t('installed.detail.loadFailed')}</div>
        ) : data ? (
          <>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-text-dim">{t('installed.detail.agentsLabel')}</dt>
              <dd className="flex gap-1">
                {data.agents.map((a) => (
                  <Badge key={a} variant="secondary">
                    {t(`installed.agentTag.${a}`, { defaultValue: a })}
                  </Badge>
                ))}
              </dd>
              <dt className="text-text-dim">slug</dt>
              <dd className="font-mono">{data.slug}</dd>
            </dl>
            <pre
              className={cn(
                'mt-2 max-h-[60dvh] overflow-auto',
                'rounded-md bg-surface-2 px-3 py-2',
                'font-mono text-xs leading-5 text-text',
                'whitespace-pre-wrap break-words',
              )}
            >
              {data.content}
            </pre>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
