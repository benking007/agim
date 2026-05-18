/**
 * ConfirmDialog — unified secondary-confirmation for destructive /
 * irreversible actions: delete fact, cancel job, revoke approval,
 * drop reminder, prune memos, etc.
 *
 * Why a wrapper: the v1 web admin had 3+ near-duplicate confirm
 * patterns (alert(), inline ▼ "Are you sure?" links, raw Dialog
 * uses). They each phrased the title / button differently and the
 * destructive variant was inconsistent. This component is the single
 * legal way to ask "are you sure" in v2.
 *
 * Controlled-only: caller owns the `open` state. That makes it
 * trivial to compose into a row action menu (open the dialog when
 * user clicks "Delete" in a DropdownMenu) without needing a
 * uncontrolled / `asChild` Trigger.
 *
 * `intent="danger"` swaps the confirm button to the destructive
 * variant. `intent="default"` (the implicit fallback) keeps the
 * primary blue — for non-destructive confirms like "Submit anyway?"
 *
 * Async confirm: the `onConfirm` callback may return a Promise; the
 * confirm button shows a busy state and stays disabled until the
 * promise settles. On error the dialog stays open so the caller can
 * surface the error via toast.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export type ConfirmDialogIntent = 'default' | 'danger'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Label for the confirm button. Defaults to t('common.actions.confirm'). */
  confirmLabel?: React.ReactNode
  /** Label for the cancel button. Defaults to t('common.actions.cancel'). */
  cancelLabel?: React.ReactNode
  /** Default: "default". `danger` styles the confirm button as destructive. */
  intent?: ConfirmDialogIntent
  /** Called when the user clicks confirm. May return a Promise; the
   *  button shows busy state until the promise settles. The dialog
   *  closes on success; on rejection it stays open. */
  onConfirm: () => void | Promise<void>
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  intent = 'default',
  onConfirm,
}: ConfirmDialogProps): JSX.Element {
  const { t } = useTranslation('common')
  const [busy, setBusy] = React.useState(false)

  const handleConfirm = React.useCallback(async () => {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // Keep dialog open; caller surfaces the failure via toast.
    } finally {
      setBusy(false)
    }
  }, [onConfirm, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {cancelLabel ?? t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant={intent === 'danger' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? t('states.saving') : (confirmLabel ?? t('actions.confirm'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
ConfirmDialog.displayName = 'ConfirmDialog'

export { ConfirmDialog }
