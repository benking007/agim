import { type FormEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useLlmAddBackend, useLlmList } from '@/hooks/use-llm-admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DEFAULT_LLM_PRESET,
  LLM_PRESETS,
  suggestLlmBackendName,
  type LlmPresetKey,
} from '@/lib/llm-presets'

export interface NativeSetupDialogProps {
  open: boolean
  reason?: string
  onOpenChange: (open: boolean) => void
  onConfigured?: () => void
}

export function NativeSetupDialog({
  open,
  reason,
  onOpenChange,
  onConfigured,
}: NativeSetupDialogProps): JSX.Element {
  const { t } = useTranslation(['common', 'settings'])
  const addBackend = useLlmAddBackend()
  const llmList = useLlmList()

  const [presetKey, setPresetKey] = useState<LlmPresetKey>('deepseek')
  const preset = useMemo(
    () => LLM_PRESETS.find((p) => p.key === presetKey) ?? DEFAULT_LLM_PRESET,
    [presetKey],
  )
  const existingNames = useMemo(
    () => (llmList.data?.backends ?? []).map((b) => b.name),
    [llmList.data],
  )

  const [name, setName] = useState(() => suggestLlmBackendName('deepseek-agim', []))
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl)
  const [model, setModel] = useState(preset.model)
  const [apiKey, setApiKey] = useState('')

  function applyPreset(next: LlmPresetKey): void {
    const p = LLM_PRESETS.find((item) => item.key === next) ?? DEFAULT_LLM_PRESET
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) { toast.error(t('llm.nameRequired', { ns: 'settings' })); return }
    if (!baseUrl.trim()) { toast.error(t('llm.baseUrlRequired', { ns: 'settings' })); return }
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      toast.error(t('llm.baseUrlRequired', { ns: 'settings' }))
      return
    }
    if (!model.trim()) { toast.error(t('llm.modelRequired', { ns: 'settings' })); return }
    if (!apiKey.trim()) {
      toast.error(t('chat.nativeSetupApiKeyRequired'))
      return
    }
    try {
      await addBackend.mutateAsync({
        name: name.trim(),
        provider: preset.provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      })
      toast.success(t('chat.nativeSetupSaved'))
      setApiKey('')
      onOpenChange(false)
      onConfigured?.()
    } catch (err) {
      toast.error((err as Error)?.message ?? String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('chat.nativeSetupDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('chat.nativeSetupDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
          {reason && (
            <div className="rounded-md border border-warning/50 bg-warning-bg/40 p-3 text-xs text-warning">
              <div className="mb-1 font-medium">
                {t('chat.nativeSetupDialogReason')}
              </div>
              <div className="break-words">{reason}</div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs font-medium">{t('llm.preset', { ns: 'settings' })}</Label>
              <Select value={presetKey} onValueChange={(v) => applyPreset(v as LlmPresetKey)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LLM_PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {t(`llm.presets.${p.key}`, { ns: 'settings' })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.name', { ns: 'settings' })}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('llm.namePlaceholder', { ns: 'settings' })}
                className="font-mono text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">{t('llm.baseUrl', { ns: 'settings' })}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={t('llm.baseUrlPlaceholder', { ns: 'settings' })}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.model', { ns: 'settings' })}</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('llm.modelPlaceholder', { ns: 'settings' })}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('llm.apiKey', { ns: 'settings' })}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('llm.apiKeyPlaceholder', { ns: 'settings' })}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          </div>

          <p className="text-xs text-text-dim">
            {t('chat.nativeSetupDialogRoleOptional')}
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.location.assign('/settings/llm')}
            >
              {t('chat.nativeSetupDialogAdvanced')}
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('chat.nativeSetupDialogCancel')}
            </Button>
            <Button type="submit" disabled={addBackend.isPending}>
              {t('chat.nativeSetupDialogSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
