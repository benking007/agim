/**
 * Claim an IM channel for the signed-in user by pasting the platform + app/user id.
 * Already-bound identities are rebound — no IM slash commands, no extra unbind step.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

export interface ImBindingRow {
  platform: string
  imUserId: string
  userId: string
  createdAt: number
}

const PLATFORMS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'feishu', label: '飞书' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'wechat', label: '微信' },
] as const

export function ImChannelBindCard(): JSX.Element {
  const { t } = useTranslation('settings')
  const [bindings, setBindings] = useState<ImBindingRow[]>([])
  const [platform, setPlatform] = useState('telegram')
  const [imUserId, setImUserId] = useState('')
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const res = await fetch('/api/me/im-bindings', { credentials: 'same-origin' })
    if (!res.ok) return
    const body = await res.json() as { bindings?: ImBindingRow[] }
    setBindings(body.bindings ?? [])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function claim(): Promise<void> {
    const id = imUserId.trim()
    if (!id) {
      toast.error(t('account.imBindNeedId', { defaultValue: '请填写 IM 渠道 id（appid / open_id / 用户 id）。' }))
      return
    }
    setPending(true)
    try {
      const res = await fetch('/api/me/im-bindings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, imUserId: id }),
      })
      const body = await res.json() as {
        ok?: boolean
        binding?: ImBindingRow
        replacedUserId?: string | null
        error?: string
        message?: string
      }
      if (!res.ok || !body.ok || !body.binding) {
        toast.error(body.error || body.message || 'failed')
        return
      }
      setImUserId('')
      if (body.replacedUserId) {
        toast.success(t('account.imBindReplaced', {
          defaultValue: '已从上一账号解绑，并挂到当前登录用户。',
        }))
      } else {
        toast.success(t('account.imBindOk', { defaultValue: '已绑定到当前登录用户。' }))
      }
      await refresh()
    } finally {
      setPending(false)
    }
  }

  async function unbind(row: ImBindingRow): Promise<void> {
    const res = await fetch('/api/me/im-bindings', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: row.platform, imUserId: row.imUserId }),
    })
    if (!res.ok) {
      toast.error('failed')
      return
    }
    toast.success(t('account.imUnbindOk', { defaultValue: '已解绑。' }))
    await refresh()
  }

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-medium">{t('account.imBind', { defaultValue: 'IM 渠道' })}</h2>
      <p className="text-sm text-text-muted">
        {t('account.imBindHint', {
          defaultValue: '在后台填入该 IM 的渠道 id（Telegram 用户 id、飞书 open_id、钉钉 staffId、微信/Discord 账号 id 等）。若该 id 已绑到别人，会先解绑再挂到当前登录用户。不必去 IM 里发命令或先手动解绑。',
        })}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Label className="space-y-1">
          <span className="text-xs text-text-muted">{t('account.imPlatform', { defaultValue: '平台' })}</span>
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <Label className="min-w-[12rem] flex-1 space-y-1">
          <span className="text-xs text-text-muted">{t('account.imAppId', { defaultValue: '渠道 id / appid' })}</span>
          <Input
            value={imUserId}
            onChange={(e) => setImUserId(e.target.value)}
            placeholder="12345"
            autoComplete="off"
          />
        </Label>
        <Button type="button" disabled={pending} onClick={() => { void claim() }}>
          {t('account.imBindAction', { defaultValue: '绑定到当前账号' })}
        </Button>
      </div>
      {bindings.length > 0 && (
        <ul className="space-y-1 text-sm text-text-muted">
          {bindings.map((row) => (
            <li key={`${row.platform}:${row.imUserId}`} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{row.platform}:{row.imUserId}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => { void unbind(row) }}>
                {t('account.imUnbind', { defaultValue: '解绑' })}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
