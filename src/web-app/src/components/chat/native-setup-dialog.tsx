import { type FormEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useLlmList, useLlmPresets, useLlmQuickEnable } from '@/hooks/use-llm-admin'
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
  resolvePresetCatalog,
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
  const quickEnable = useLlmQuickEnable()
  const llmList = useLlmList()
  const presetsQuery = useLlmPresets()
  const { presets: catalog, defaultPreset } = useMemo(
    () => resolvePresetCatalog(presetsQuery.data),
    [presetsQuery.data],
  )

  const [presetKey, setPresetKey] = useState<LlmPresetKey>('deepseek')
  const preset = useMemo(
    () => catalog.find((p) => p.key === presetKey) ?? defaultPreset,
    [presetKey, catalog, defaultPreset],
  )
  const existingNames = useMemo(
    () => (llmList.data?.backends ?? []).map((b) => b.name),
    [llmList.data],
  )

  const [name, setName] = useState(() => suggestLlmBackendName(DEFAULT_LLM_PRESET.baseName, []))
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LLM_PRESET.baseUrl)
  const [model, setModel] = useState(DEFAULT_LLM_PRESET.model)
  const [apiKey, setApiKey] = useState('')
  const isCustom = presetKey === 'custom'

  function applyPreset(next: LlmPresetKey): void {
    const p = catalog.find((item) => item.key === next) ?? defaultPreset
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestLlmBackendName(p.baseName, existingNames))
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!apiKey.trim()) {
      toast.error(t('chat.nativeSetupApiKeyRequired'))
      return
    }
    if (isCustom) {
      if (!name.trim()) {
        toast.error(t('llm.nameRequired', { ns: 'settings' }))
        return
      }
      if (!baseUrl.trim() || !/^https?:\/\//i.test(baseUrl.trim())) {
        toast.error(t('llm.baseUrlRequired', { ns: 'settings' }))
        return
      }
      if (!model.trim()) {
        toast.error(t('llm.modelRequired', { ns: 'settings' }))
        return
      }
    }
    try {
      await quickEnable.mutateAsync({
        preset: presetKey,
        apiKey: apiKey.trim(),
        // Presets fill name/model/baseUrl server-side; custom supplies them.
        ...(isCustom
          ? {
              name: name.trim(),
              model: model.trim(),
              baseUrl: baseUrl.trim(),
            }
          : {}),
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
      <DialogContent className="sm:max-w-lg">
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

          <div className="space-y-3">
            <div>
              <Label className="text-xs font-medium">{t('llm.preset', { ns: 'settings' })}</Label>
              <Select value={presetKey} onValueChange={(v) => applyPreset(v as LlmPresetKey)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {catalog.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {t(`llm.presets.${p.key}`, { ns: 'settings' })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                autoFocus
              />
              {!isCustom && preset.model && (
                <p className="mt-1 text-xs text-text-dim">
                  {presetKey === 'deepseek'
                    ? t('chat.nativeSetupDeepseekHint')
                    : presetKey === 'moonshot'
                      ? t('chat.nativeSetupKimiHint')
                      : presetKey === 'zhipu'
                        ? t('chat.nativeSetupZhipuHint')
                        : presetKey === 'mimo'
                          ? t('chat.nativeSetupMimoHint')
                          : t('llm.quick.presetHint', { ns: 'settings', model: preset.model })}
                </p>
              )}
            </div>

            {isCustom && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium">{t('llm.name', { ns: 'settings' })}</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('llm.namePlaceholder', { ns: 'settings' })}
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
                <div className="sm:col-span-2">
                  <Label className="text-xs font-medium">{t('llm.baseUrl', { ns: 'settings' })}</Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={t('llm.baseUrlPlaceholder', { ns: 'settings' })}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('chat.nativeSetupDialogCancel')}
            </Button>
            <Button type="submit" disabled={quickEnable.isPending}>
              {t('chat.nativeSetupDialogSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
