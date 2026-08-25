/**
 * Portal skills — read-only list + per-skill enable switch.
 * Click a skill to preview SKILL.md in a modal. Injection rebuilds
 * asynchronously after a toggle.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { MarkdownView } from '@/components/chat/markdown-view'
import { useAgimSkill, useAgimSkillSetEnabled, useAgimSkillsList, type AgimSkillMeta } from '@/hooks/use-agim-skills'
import { cn } from '@/lib/utils'
import { PortalSwitch } from './portal-switch'

export function PortalSkillsPane(props: { dark: boolean }): JSX.Element {
  const { t } = useTranslation()
  const { dark } = props
  const listQuery = useAgimSkillsList()
  const toggle = useAgimSkillSetEnabled()
  const skills = listQuery.data?.skills ?? []
  const groups = useMemo(() => groupSkills(skills), [skills])
  const [previewName, setPreviewName] = useState<string | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="portal-skills-pane">
      <div className="shrink-0 space-y-1 px-4 py-3">
        <h2 className={cn('text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-900')}>
          {t('chat.portal.skillsTitle')}
        </h2>
        <p className="text-[11px] leading-relaxed text-zinc-400">{t('chat.portal.skillsHint')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {listQuery.isLoading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-xs text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('states.loading')}
          </div>
        ) : skills.length === 0 ? (
          <p className="px-1 py-6 text-xs text-zinc-400">{t('chat.portal.skillsEmpty')}</p>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.source}>
                <h3 className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                  {group.labelKey === 'builtin' && t('chat.portal.skillsBuiltin')}
                  {group.labelKey === 'user' && t('chat.portal.skillsUser')}
                  {group.labelKey === 'workspace' && t('chat.portal.skillsWorkspace')}
                  <span className="ml-1 font-medium normal-case tracking-normal">({group.items.length})</span>
                </h3>
                <ul className="space-y-1">
                  {group.items.map((skill) => {
                    const enabled = skill.enabled !== false
                    const busy = toggle.isPending && toggle.variables?.name === skill.name
                    return (
                      <li
                        key={skill.name}
                        className={cn(
                          'flex items-start gap-2 rounded-xl px-2 py-1.5',
                          dark ? 'bg-zinc-900/60' : 'bg-white',
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 cursor-pointer rounded-lg px-1 py-0.5 text-left hover:bg-zinc-500/5"
                          data-testid={`portal-skill-${skill.name}`}
                          aria-haspopup="dialog"
                          onClick={() => setPreviewName(skill.name)}
                        >
                          <p className={cn('truncate text-xs font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
                            {skill.name}
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-400">{skill.description}</p>
                        </button>
                        <PortalSwitch
                          checked={enabled}
                          disabled={busy}
                          label={enabled ? t('chat.portal.skillsOn') : t('chat.portal.skillsOff')}
                          onCheckedChange={(next) => {
                            toggle.mutate(
                              { name: skill.name, enabled: next },
                              { onError: () => toast.error(t('chat.portal.skillsToggleFailed')) },
                            )
                          }}
                        />
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
      <SkillPreviewDialog
        name={previewName}
        dark={dark}
        onClose={() => setPreviewName(null)}
      />
    </div>
  )
}

function SkillPreviewDialog(props: {
  name: string | null
  dark: boolean
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const { name, dark, onClose } = props
  const detail = useAgimSkill(name)
  const body = detail.data?.body ?? ''
  const meta = detail.data?.meta
  const sourceLabel = meta?.source === 'user'
    ? t('chat.portal.skillsUser')
    : meta?.source === 'workspace'
      ? t('chat.portal.skillsWorkspace')
      : t('chat.portal.skillsBuiltin')

  return (
    <Dialog open={Boolean(name)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="portal-skill-preview">
        <DialogHeader>
          <DialogTitle className="pr-8 font-mono text-base">{name}</DialogTitle>
          <DialogDescription>
            {t('chat.portal.skillsPreviewHint')}
            {meta ? ` · ${sourceLabel}` : ''}
          </DialogDescription>
        </DialogHeader>
        {meta?.description && (
          <p className="text-xs text-zinc-400">{meta.description}</p>
        )}
        {detail.isLoading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('chat.portal.skillsPreviewLoading')}
          </div>
        ) : detail.isError ? (
          <p className="py-6 text-xs text-red-500">{t('chat.portal.skillsPreviewFailed')}</p>
        ) : (
          <div
            className={cn(
              'max-h-[55dvh] overflow-auto rounded-lg border p-3',
              dark ? 'border-zinc-800 bg-zinc-950' : 'border-zinc-200 bg-zinc-50',
            )}
          >
            {body.trim()
              ? <MarkdownView content={body} className="text-sm" />
              : <p className="text-xs text-zinc-400">{t('chat.portal.skillsPreviewEmpty')}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function groupSkills(skills: AgimSkillMeta[]): Array<{
  source: AgimSkillMeta['source']
  labelKey: 'builtin' | 'user' | 'workspace'
  items: AgimSkillMeta[]
}> {
  const order: Array<AgimSkillMeta['source']> = ['user', 'workspace', 'builtin']
  return order
    .map((source) => ({
      source,
      labelKey: source,
      items: skills.filter((s) => s.source === source).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.items.length > 0)
}
