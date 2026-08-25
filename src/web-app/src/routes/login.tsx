/**
 * /login — username/password (plus captcha after failed tries) or
 * first-run redirect to /register.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
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

export default function LoginRoute(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setUser = useAuth((s) => s.setUser)
  const hydrate = useAuth((s) => s.hydrate)
  const hasUsers = useAuth((s) => s.hasUsers)
  const signedIn = useAuth((s) => s.signedIn)
  const ready = useAuth((s) => s.ready)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [challenge, setChallenge] = useState<CaptchaState | null>(null)
  const [needCaptcha, setNeedCaptcha] = useState(false)
  const [pending, setPending] = useState(false)

  const next = safeNext(params.get('next'))

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (signedIn || !ready) return
    if (hasUsers === false) navigate(`/register?next=${encodeURIComponent(next)}`, { replace: true })
  }, [hasUsers, navigate, next, ready, signedIn])

  if (ready && signedIn) {
    return <Navigate to={next} replace />
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setPending(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          captchaId: challenge?.id,
          captcha,
        }),
      })
      const body = await res.json() as { user?: { id: string; username: string; displayName: string; role: 'admin' | 'user' }; code?: string; error?: string }
      if (!res.ok) {
        if (body.code === 'AUTH_CAPTCHA') {
          setNeedCaptcha(true)
          setChallenge(await loadCaptcha())
        }
        toast.error(body.error || t('login.failed', { defaultValue: '登录失败' }))
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
            <span className="mr-2">🤖</span>
            {t('appName')}
          </CardTitle>
          <CardDescription>
            {t('login.intro', { defaultValue: '使用用户名和密码登录。' })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => { void onSubmit(e) }} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">{t('login.username', { defaultValue: '用户名' })}</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('login.password', { defaultValue: '密码' })}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {needCaptcha && challenge && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="captcha">{t('login.captcha', { defaultValue: '验证码' })}</Label>
                <div className="flex items-center justify-between gap-3">
                  <img
                    alt="captcha"
                    width={160}
                    height={48}
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(challenge.svg)}`}
                  />
                  <Button type="button" variant="outline" onClick={() => { void loadCaptcha().then(setChallenge) }}>
                    {t('login.refreshCaptcha', { defaultValue: '换一张' })}
                  </Button>
                </div>
                <Input
                  id="captcha"
                  value={captcha}
                  onChange={(e) => setCaptcha(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
            )}
            <Button type="submit" size="lg" disabled={pending || !username || !password}>
              {pending ? t('states.loading') : t('login.submit', { defaultValue: '登录' })}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="block text-xs text-text-muted">
          <Link className="text-accent underline" to={`/register?next=${encodeURIComponent(next)}`}>
            {hasUsers === false
              ? t('login.goRegisterFirst')
              : t('login.goRegister')}
          </Link>
        </CardFooter>
      </Card>
    </div>
  )
}
