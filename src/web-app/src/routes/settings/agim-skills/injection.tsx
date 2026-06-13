/**
 * /settings/agim-skills/injection — operator-facing editor for the
 * tier-1 system-prompt skill block.
 *
 * v1.2.151 — Background: every agim turn injects an auto-generated
 * skill block at the top of the system prompt so the LLM knows which
 * skills it can call. The block is computed from the loader's bucket
 * + cluster rules. When operators want to nudge it (pin a skill,
 * hide a noisy one, add a routing hint about a custom env), they
 * authoring text here writes a single Markdown file
 * (`~/.agim/skill-injection-override.md`) that REPLACES the auto
 * block at injection time. Empty file == auto behaviour.
 *
 * UI:
 *  · Left/top:  Auto-generated block (read-only preview).
 *  · Right/bottom: Operator override (editable textarea).
 *  · Buttons: Save / Clear / Refresh / Copy-auto-into-override.
 *  · Counters: char count for both panes + warning at ≥10k chars.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Copy, Loader2, RefreshCcw, Save, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  useSkillInjection, useSkillInjectionSave, useSkillInjectionDelete,
} from '@/hooks/use-agim-skills'

const TOKEN_WARN_CHARS = 10_000

export function Component(): JSX.Element {
  return <InjectionEditorRoute />
}

export default function InjectionEditorRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const query = useSkillInjection()
  const save = useSkillInjectionSave()
  const del = useSkillInjectionDelete()

  // Local draft state; sync from server on first load + after a save.
  const [draft, setDraft] = useState('')
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (query.data && !touched) {
      setDraft(query.data.override ?? '')
    }
  }, [query.data, touched])

  const auto = query.data?.auto ?? ''
  const maxChars = query.data?.maxOverrideChars ?? 40_000
  const overrideActive = query.data?.overrideActive ?? false
  const overridePath = query.data?.overridePath ?? '~/.agim/skill-injection-override.md'

  const draftLen = draft.length
  const overLimit = draftLen > maxChars

  async function onSave(): Promise<void> {
    if (overLimit) {
      toast.error(t('skillInjection.overLimitToast', { len: draftLen, max: maxChars }))
      return
    }
    try {
      const r = await save.mutateAsync(draft)
      toast.success(r.deleted ? t('skillInjection.clearedToast') : t('skillInjection.savedToast'))
      setTouched(false)
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  async function onClear(): Promise<void> {
    if (!confirm(t('skillInjection.confirmClear'))) return
    try {
      await del.mutateAsync()
      setDraft('')
      setTouched(false)
      toast.success(t('skillInjection.clearedToast'))
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  async function onRefresh(): Promise<void> {
    await query.refetch()
    if (!touched) setDraft(query.data?.override ?? '')
    toast.info(t('skillInjection.refreshedToast'))
  }

  function onCopyAuto(): void {
    setDraft(auto)
    setTouched(true)
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('skillInjection.title')}</h1>
        {overrideActive
          ? <Badge variant="success">{t('skillInjection.overrideActive')}</Badge>
          : <Badge variant="outline">{t('skillInjection.overrideInactive')}</Badge>}
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void onRefresh()}
          disabled={query.isFetching}
        >
          {query.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('common:refresh', { defaultValue: 'Refresh' })}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('skillInjection.subtitle')}</p>
      <p className="text-xs text-text-dim font-mono break-all">{overridePath}</p>

      {/* Auto preview */}
      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">{t('skillInjection.autoLabel')}</Label>
          <Badge variant="outline">{auto.length.toLocaleString()} chars</Badge>
          {auto.length >= TOKEN_WARN_CHARS && (
            <Badge variant="warning">{t('skillInjection.largeWarn')}</Badge>
          )}
          <Button
            variant="ghost" size="sm" className="ml-auto"
            onClick={onCopyAuto}
            disabled={query.isLoading}
          >
            <Copy className="h-4 w-4" />
            <span className="hidden sm:inline">{t('skillInjection.copyToOverride')}</span>
          </Button>
        </div>
        <textarea
          readOnly
          value={query.isLoading ? '...' : auto}
          className="h-64 w-full resize-y rounded border border-border bg-surface-2 p-2 font-mono text-xs"
          aria-label={t('skillInjection.autoLabel')}
        />
      </section>

      {/* Override editor */}
      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">{t('skillInjection.overrideLabel')}</Label>
          <Badge variant={overLimit ? 'danger' : 'outline'}>
            {draftLen.toLocaleString()} / {maxChars.toLocaleString()} chars
          </Badge>
          {draftLen >= TOKEN_WARN_CHARS && !overLimit && (
            <Badge variant="warning">{t('skillInjection.largeWarn')}</Badge>
          )}
        </div>
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setTouched(true) }}
          placeholder={t('skillInjection.overridePlaceholder')}
          className="h-72 w-full resize-y rounded border border-border bg-surface-2 p-2 font-mono text-xs"
          aria-label={t('skillInjection.overrideLabel')}
        />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={() => void onSave()}
            disabled={save.isPending || overLimit}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('skillInjection.save')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void onClear()}
            disabled={del.isPending || (!overrideActive && draft.length === 0)}
          >
            {del.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {t('skillInjection.clear')}
          </Button>
          <span className="text-xs text-text-dim">{t('skillInjection.hint')}</span>
        </div>
      </section>
    </div>
  )
}
