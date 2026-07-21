/**
 * Modal wrapper around SettingsLlmPanel — opened from the composer
 * model chip so operators can change APIs without leaving chat.
 *
 * SettingsLlmPanel is lazy-loaded so the chat entry chunk stays under
 * the SPA bundle budget.
 */

import { Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const SettingsLlmPanel = lazy(async () => {
  const mod = await import('@/routes/settings/llm')
  return { default: mod.SettingsLlmPanel }
})

export interface LlmSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LlmSettingsDialog({
  open,
  onOpenChange,
}: LlmSettingsDialogProps): JSX.Element {
  const { t } = useTranslation(['common', 'settings'])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('llm.title', { ns: 'settings' })}</DialogTitle>
          <DialogDescription>
            {t('chat.statusBar.llmDialogDesc', {
              defaultValue: 'Configure Agim Agent model APIs without leaving the chat.',
            })}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <Suspense
            fallback={(
              <div className="flex h-40 items-center justify-center text-text-dim">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
          >
            <SettingsLlmPanel embedded className="gap-4" />
          </Suspense>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
