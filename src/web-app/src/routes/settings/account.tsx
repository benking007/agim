/**
 * /settings/account — profile, points, API tokens, invites (admin), IM bind.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PointsBalance {
  remaining: number
  monthlyLimit: number
  bonus: number
  usedThisPeriod: number
}

interface InviteRow {
  id: string
  raw?: string
  usesLeft: number
  expiresAt: number | null
}

export default function SettingsAccountRoute(): JSX.Element {
  const { t } = useTranslation('settings')
  const user = useAuth((s) => s.user)
  const role = useAuth((s) => s.role)
  const clear = useAuth((s) => s.clear)
  const [points, setPoints] = useState<PointsBalance | null>(null)
  const [tokenRaw, setTokenRaw] = useState<string | null>(null)
  const [inviteRaw, setInviteRaw] = useState<string | null>(null)
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [bindCode, setBindCode] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const me = await fetch('/api/me/points', { credentials: 'same-origin' })
      if (me.ok) {
        const body = await me.json() as { balance?: PointsBalance }
        setPoints(body.balance ?? null)
      }
      if (role === 'admin') {
        const inv = await fetch('/api/admin/invites', { credentials: 'same-origin' })
        if (inv.ok) {
          const body = await inv.json() as { invites?: InviteRow[] }
          setInvites(body.invites ?? [])
        }
      }
    })()
  }, [role])

  async function createApiToken(): Promise<void> {
    const res = await fetch('/api/me/tokens', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'api' }),
    })
    const body = await res.json() as { raw?: string; error?: string }
    if (!res.ok || !body.raw) {
      toast.error(body.error || 'failed')
      return
    }
    setTokenRaw(body.raw)
    toast.success(t('account.tokenCreated', { defaultValue: '令牌已生成，请立即复制，之后无法再看明文。' }))
  }

  async function createInvite(): Promise<void> {
    const res = await fetch('/api/admin/invites', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uses: 1 }),
    })
    const body = await res.json() as { invite?: InviteRow & { raw?: string }; error?: string }
    if (!res.ok || !body.invite?.raw) {
      toast.error(body.error || 'failed')
      return
    }
    setInviteRaw(body.invite.raw)
    setInvites((prev) => [body.invite!, ...prev])
  }

  async function createBindCode(): Promise<void> {
    const res = await fetch('/api/me/im-bindings/code', { method: 'POST', credentials: 'same-origin' })
    const body = await res.json() as { code?: string; error?: string }
    if (!res.ok || !body.code) {
      toast.error(body.error || 'failed')
      return
    }
    setBindCode(body.code)
  }

  async function logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    clear()
    window.location.href = '/login'
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t('account.title', { defaultValue: '账号' })}</h1>
        <p className="text-sm text-text-muted">
          {user?.username ?? '—'} · {role === 'admin' ? 'admin' : 'user'}
        </p>
      </header>

      <section className="space-y-2 rounded-xl border border-border p-4">
        <h2 className="font-medium">{t('account.points', { defaultValue: '点数' })}</h2>
        <p className="text-sm text-text-muted">
          {points
            ? t('account.pointsDetail', {
              defaultValue: '剩余 {{remaining}} / 月额度 {{limit}}（已用 {{used}}，奖励 {{bonus}}）',
              remaining: points.remaining,
              limit: points.monthlyLimit,
              used: points.usedThisPeriod,
              bonus: points.bonus,
            })
            : t('account.pointsNone', { defaultValue: '登录后显示额度。' })}
        </p>
      </section>

      <section className="space-y-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">{t('account.apiToken', { defaultValue: 'API 令牌' })}</h2>
        <p className="text-sm text-text-muted">{t('account.apiTokenHint', { defaultValue: '给脚本或其他环境用。明文只显示一次。' })}</p>
        <Button type="button" onClick={() => { void createApiToken() }}>
          {t('account.createToken', { defaultValue: '生成令牌' })}
        </Button>
        {tokenRaw && (
          <Label className="block">
            <Input readOnly value={tokenRaw} />
          </Label>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">{t('account.imBind', { defaultValue: 'IM 绑定' })}</h2>
        <p className="text-sm text-text-muted">
          {t('account.imBindHint', { defaultValue: '在 Telegram / Discord 发送 /bind 下面的码。绑定后渠道为「IM类型:IM渠道id:注册id」，点数扣注册用户。未绑定也能继续用 Agim。' })}
        </p>
        <Button type="button" onClick={() => { void createBindCode() }}>
          {t('account.createBindCode', { defaultValue: '生成绑定码' })}
        </Button>
        {bindCode && <p className="font-mono text-lg">{bindCode}</p>}
      </section>

      {role === 'admin' && (
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="font-medium">{t('account.invites', { defaultValue: '邀请码' })}</h2>
          <Button type="button" onClick={() => { void createInvite() }}>
            {t('account.createInvite', { defaultValue: '派生邀请码' })}
          </Button>
          {inviteRaw && <p className="font-mono text-lg">{inviteRaw}</p>}
          <ul className="text-sm text-text-muted">
            {invites.map((i) => (
              <li key={i.id}>{i.id} · uses {i.usesLeft}</li>
            ))}
          </ul>
        </section>
      )}

      <Button type="button" variant="outline" onClick={() => { void logout() }}>
        {t('account.logout', { defaultValue: '退出登录' })}
      </Button>
    </div>
  )
}
