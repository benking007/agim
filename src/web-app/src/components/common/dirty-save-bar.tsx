/**
 * DirtySaveBar — the "you have unsaved changes" row that lives at the
 * bottom of every settings card. Pre-R11 each of /settings/{agents,
 * email, viewer, service, memory/vector-backend-form} hand-rolled its
 * own copy, drifting on:
 *   * `sticky bottom-0` vs not
 *   * Discard button `variant` ('ghost' / 'secondary')
 *   * Save icon order / spinner / `disabled` semantics
 *
 * One component, one set of i18n keys, one a11y posture.
 *
 * The component is a *render fragment*, not a layout wrapper — the
 * caller decides where in the form tree it sits. `sticky` is opt-in
 * because page-level dirty bars want it; in-card bars usually don't.
 *
 * When `dirty === false` the component renders nothing (no fragment),
 * so callers can `{<DirtySaveBar … />}` inline without conditional
 * branches.
 */

import { Loader2, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface DirtySaveBarProps {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  /** Block Save while still dirty — e.g. a field is invalid. The
   *  Discard button stays enabled so the user can bail out. */
  saveDisabled?: boolean
  /** Pin to the viewport bottom. Defaults to false (in-card). */
  sticky?: boolean
  /** Override the default "unsaved changes" badge text. Pass the
   *  already-translated string. */
  hint?: string
  /** Replace the default Badge entirely with custom content (e.g. a
   *  warning Badge for the restart-required case in `/settings/service`
   *  Ports). When set, `hint` is ignored. */
  hintNode?: React.ReactNode
  /** Override the default "Save" / "Saving…" labels. Pre-translated. */
  saveLabel?: string
  savingLabel?: string
  /** Override the default "Discard" label. */
  discardLabel?: string
  /** Forwarded to the wrapper. Use for additional spacing / border. */
  className?: string
}

export function DirtySaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  saveDisabled = false,
  sticky = false,
  hint,
  hintNode,
  saveLabel,
  savingLabel,
  discardLabel,
  className,
}: DirtySaveBarProps): JSX.Element | null {
  const { t } = useTranslation('common')
  if (!dirty) return null
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-t border-border bg-surface px-4 py-2',
        sticky && 'sticky bottom-0 z-10 shadow-md',
        className,
      )}
      role="region"
      aria-label={t('actions.unsavedChanges', { defaultValue: 'Unsaved changes' })}
    >
      {hintNode ?? (
        <Badge variant="info">
          {hint ?? t('actions.unsavedChanges', { defaultValue: 'Unsaved changes' })}
        </Badge>
      )}
      <span className="ml-auto" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onDiscard}
        disabled={saving}
      >
        <X className="h-4 w-4" />
        {discardLabel ?? t('actions.discard', { defaultValue: 'Discard' })}
      </Button>
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || saveDisabled}
      >
        {saving
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Save className="h-4 w-4" />}
        {saving
          ? (savingLabel ?? t('actions.saving', { defaultValue: 'Saving…' }))
          : (saveLabel ?? t('actions.save', { defaultValue: 'Save' }))}
      </Button>
    </div>
  )
}
