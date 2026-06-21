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

type PresetKey = 'deepseek' | 'moonshot' | 'zhipu' | 'openai' | 'anthropic' | 'custom'

interface PresetDef {
  key: PresetKey
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  baseName: string
}

const PRESETS: PresetDef[] = [
  {
    key: 'deepseek',
    provider: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    baseName: 'deepseek-native',
  },
  {
    key: 'moonshot',
    provider: 'openai-compat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    baseName: 'moonshot-native',
  },
  {
    key: 'zhipu',
    provider: 'openai-compat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-air',
    baseName: 'zhipu-native',
  },
  {
    key: 'openai',
    provider: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    baseName: 'openai-native',
  },
  {
    key: 'anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-20241022',
    baseName: 'anthropic-native',
  },
  {
    key: 'custom',
    provider: 'openai-compat',
    baseUrl: '',
    model: '',
    baseName: 'native-backend',
  },
]
const DEFAULT_PRESET: PresetDef = PRESETS[0] as PresetDef

export interface NativeSetupDialogProps {
  open: boolean
  reason?: string
  onOpenChange: (open: boolean) => void
  onConfigured?: () => void
}

function suggestName(base: string, existing: string[]): string {
  const used = new Set(existing.map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 200; i += 1) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
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

  const [presetKey, setPresetKey] = useState<PresetKey>('deepseek')
  const preset = useMemo(
    () => PRESETS.find((p) => p.key === presetKey) ?? DEFAULT_PRESET,
    [presetKey],
  )
  const existingNames = useMemo(
    () => (llmList.data?.backends ?? []).map((b) => b.name),
    [llmList.data],
  )

  const [name, setName] = useState(() => suggestName('deepseek-native', []))
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl)
  const [model, setModel] = useState(preset.model)
  const [apiKey, setApiKey] = useState('')

  function applyPreset(next: PresetKey): void {
    const p = PRESETS.find((item) => item.key === next) ?? DEFAULT_PRESET
    setPresetKey(next)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setName(suggestName(p.baseName, existingNames))
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
      toast.error(t('chat.nativeSetupApiKeyRequired', { defaultValue: '请填写 API Key' }))
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
      toast.success(t('chat.nativeSetupSaved', {
        defaultValue: 'LLM 配置已保存，正在重试切换 native…',
      }))
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
            {t('chat.nativeSetupDialogTitle', {
              defaultValue: '配置 Native Agent 所需 LLM',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('chat.nativeSetupDialogDesc', {
              defaultValue:
                '只要配置一个可用的 LLM backend（含 API Key），native 就可以使用。Role Bindings 属于可选高级配置。',
            })}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
          {reason && (
            <div className="rounded-md border border-warning/50 bg-warning-bg/40 p-3 text-xs text-warning">
              <div className="mb-1 font-medium">
                {t('chat.nativeSetupDialogReason', { defaultValue: '最近一次错误信息' })}
              </div>
              <div className="break-words">{reason}</div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs font-medium">{t('llm.preset', { ns: 'settings' })}</Label>
              <Select value={presetKey} onValueChange={(v) => applyPreset(v as PresetKey)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
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
              <Label className="text-xs font-medium">{t('llm.apiKeyOptional', { ns: 'settings' })}</Label>
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
            {t('chat.nativeSetupDialogRoleOptional', {
              defaultValue: 'Role Bindings 是可选增强项，不配置也不会阻塞 native。',
            })}
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.location.assign('/settings/llm')}
            >
              {t('chat.nativeSetupDialogAdvanced', { defaultValue: '打开完整 LLM 设置页' })}
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('chat.nativeSetupDialogCancel', { defaultValue: '稍后再配' })}
            </Button>
            <Button type="submit" disabled={addBackend.isPending}>
              {t('chat.nativeSetupDialogSave', { defaultValue: '保存并启用 native' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
