/**
 * /register — first user becomes admin; later users need an invite + captcha.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function safeNext(raw: string | null): string {
  if (!raw) return '/'
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith('/') && !decoded.startsWith('//')) return decoded
  } catch { /* ignore */ }
  return '/'
}

interface CaptchaState {
  id: string
  svg: string
}

async function loadCaptcha(): Promise<CaptchaState | null> {
  const res = await fetch('/api/auth/captcha', { credentials: 'same-origin' })
  if (!res.ok) return null
  return res.json() as Promise<CaptchaState>
}

export default function RegisterRoute(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setUser = useAuth((s) => s.setUser)
  const hydrate = useAuth((s) => s.hydrate)
  const hasUsers = useAuth((s) => s.hasUsers)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [challenge, setChallenge] = useState<CaptchaState | null>(null)
  const [pending, setPending] = useState(false)

  const next = safeNext(params.get('next'))
  const first = hasUsers === false

  useEffect(() => {
    void hydrate()
    void loadCaptcha().then(setChallenge)
  }, [hydrate])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setPending(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          invite: first ? undefined : invite,
          captchaId: challenge?.id,
          captcha,
        }),
      })
      const body = await res.json() as { user?: { id: string; username: string; displayName: string; role: 'admin' | 'user' }; error?: string }
      if (!res.ok) {
        setChallenge(await loadCaptcha())
        toast.error(body.error || t('login.registerFailed', { defaultValue: '注册失败' }))
        return
      }
      if (body.user) setUser(body.user)
      toast.success(t('states.saved'))
      navigate(next, { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-8 pt-safe">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">
            {first
              ? t('login.createAdmin', { defaultValue: '创建管理员账号' })
              : t('login.registerTitle', { defaultValue: '注册' })}
          </CardTitle>
          <CardDescription>
            {first
              ? t('login.firstHint', { defaultValue: '这是本机第一个账号，将自动成为管理员。' })
              : t('login.inviteHint', { defaultValue: '需要管理员发放的邀请码。' })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => { void onSubmit(e) }} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">{t('login.username', { defaultValue: '用户名' })}</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('login.password', { defaultValue: '密码（至少 8 位）' })}</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
            </div>
            {!first && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite">{t('login.invite', { defaultValue: '邀请码' })}</Label>
                <Input id="invite" value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="AGIM-XXXX-XXXX" required />
              </div>
            )}
            {challenge && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="captcha">{t('login.captcha', { defaultValue: '验证码' })}</Label>
                <div className="flex items-center gap-3">
                  <div dangerouslySetInnerHTML={{ __html: challenge.svg }} />
                  <Button type="button" variant="outline" onClick={() => { void loadCaptcha().then(setChallenge) }}>
                    {t('login.refreshCaptcha', { defaultValue: '换一张' })}
                  </Button>
                </div>
                <Input id="captcha" value={captcha} onChange={(e) => setCaptcha(e.target.value)} autoComplete="off" required />
              </div>
            )}
            <Button type="submit" size="lg" disabled={pending || !username || password.length < 8 || !captcha || (!first && !invite)}>
              {pending ? t('states.loading') : t('login.registerSubmit', { defaultValue: '注册并登录' })}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="block text-xs text-text-muted">
          <Link className="text-accent underline" to={`/login?next=${encodeURIComponent(next)}`}>
            {t('login.goLogin', { defaultValue: '已有账号？去登录' })}
          </Link>
        </CardFooter>
      </Card>
    </div>
  )
}
