/**
 * /settings/account — profile, points, API tokens, invites (admin).
 * IM connect stays on Settings → Messengers; this page does not bind channels.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { signOut } from '@/lib/sign-out'
import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PointsBalance {
  userId?: string
  remaining: number
  monthlyLimit: number
  bonus: number
  usedThisPeriod: number
  unlimited?: boolean
}

interface AccountUser {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled?: boolean
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
  const [points, setPoints] = useState<PointsBalance | null>(null)
  const [tokenRaw, setTokenRaw] = useState<string | null>(null)
  const [inviteRaw, setInviteRaw] = useState<string | null>(null)
  const [invites, setInvites] = useState<InviteRow[]>([])
  const [members, setMembers] = useState<AccountUser[]>([])
  const [balances, setBalances] = useState<Record<string, PointsBalance>>({})
  const [grantAmt, setGrantAmt] = useState<Record<string, string>>({})
  const [grantingId, setGrantingId] = useState<string | null>(null)

  async function loadAdminQuota(): Promise<void> {
    const [usersRes, pointsRes] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'same-origin' }),
      fetch('/api/admin/points', { credentials: 'same-origin' }),
    ])
    if (usersRes.ok) {
      const body = await usersRes.json() as { users?: AccountUser[] }
      setMembers((body.users ?? []).filter((u) => u.role !== 'admin'))
    }
    if (pointsRes.ok) {
      const body = await pointsRes.json() as { balances?: PointsBalance[] }
      const next: Record<string, PointsBalance> = {}
      for (const row of body.balances ?? []) {
        if (row.userId) next[row.userId] = row
      }
      setBalances(next)
    }
  }

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
        await loadAdminQuota()
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
    const invite = body.invite
    if (!res.ok || !invite?.raw) {
      toast.error(body.error || 'failed')
      return
    }
    setInviteRaw(invite.raw)
    setInvites((prev) => [invite, ...prev])
  }

  async function grantBonus(userId: string, username: string): Promise<void> {
    const amount = Math.floor(Number(grantAmt[userId]))
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('account.addQuotaInvalid', { defaultValue: '请输入大于 0 的点数。' }))
      return
    }
    setGrantingId(userId)
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/points`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addBonus: amount }),
      })
      const body = await res.json() as { balance?: PointsBalance; error?: string; message?: string }
      const granted = body.balance
      if (!res.ok || !granted) {
        toast.error(body.message || body.error || 'failed')
        return
      }
      setBalances((prev) => ({ ...prev, [userId]: granted }))
      setGrantAmt((prev) => ({ ...prev, [userId]: '' }))
      toast.success(t('account.addQuotaDone', {
        defaultValue: '已增加 {{amount}} 点给 {{username}}',
        amount,
        username,
      }))
    } finally {
      setGrantingId(null)
    }
  }

  async function logout(): Promise<void> {
    await signOut()
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
          {!points
            ? t('account.pointsNone', { defaultValue: '登录后显示额度。' })
            : points.unlimited
              ? t('account.pointsUnlimited', {
                defaultValue: '不限（本月已用 {{used}}）',
                used: points.usedThisPeriod,
              })
              : t('account.pointsDetail', {
                defaultValue: '剩余 {{remaining}} / 月额度 {{limit}}（已用 {{used}}，奖励 {{bonus}}）',
                remaining: points.remaining,
                limit: points.monthlyLimit,
                used: points.usedThisPeriod,
                bonus: points.bonus,
              })}
        </p>
      </section>

      {role === 'admin' && (
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="font-medium">{t('account.userQuota', { defaultValue: '用户额度' })}</h2>
          <p className="text-sm text-text-muted">
            {t('account.userQuotaHint', { defaultValue: '给非管理员增加使用额度。管理员本人不限额。' })}
          </p>
          {members.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t('account.userQuotaEmpty', { defaultValue: '还没有普通用户。先发邀请码让他们注册。' })}
            </p>
          ) : (
            <ul className="space-y-3">
              {members.map((member) => {
                const bal = balances[member.id]
                return (
                  <li key={member.id} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium">{member.username}</p>
                      <p className="text-sm text-text-muted">
                        {bal
                          ? t('account.pointsDetail', {
                            defaultValue: '剩余 {{remaining}} / 月额度 {{limit}}（已用 {{used}}，奖励 {{bonus}}）',
                            remaining: bal.remaining,
                            limit: bal.monthlyLimit,
                            used: bal.usedThisPeriod,
                            bonus: bal.bonus,
                          })
                          : '—'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        className="w-32"
                        placeholder={t('account.addQuotaPlaceholder', { defaultValue: '点数' })}
                        value={grantAmt[member.id] ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setGrantAmt((prev) => ({ ...prev, [member.id]: value }))
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={grantingId === member.id}
                        onClick={() => { void grantBonus(member.id, member.username) }}
                      >
                        {t('account.addQuota', { defaultValue: '增加额度' })}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-border p-4">
        <h2 className="font-medium">{t('account.apiToken', { defaultValue: 'API 令牌' })}</h2>
        <p className="text-sm text-text-muted">
          {t('account.apiTokenHint', {
            defaultValue: '网页用账号密码登录。令牌只给脚本、CLI 或其他程序调本机 API（Authorization: Bearer 或 X-Agim-Token），不是登录密码。明文只显示一次。',
          })}
        </p>
        <Button type="button" onClick={() => { void createApiToken() }}>
          {t('account.createToken', { defaultValue: '生成令牌' })}
        </Button>
        {tokenRaw && (
          <Label className="block">
            <Input readOnly value={tokenRaw} />
          </Label>
        )}
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
