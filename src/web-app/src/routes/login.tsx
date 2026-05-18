/**
 * /login — token-based sign-in.
 *
 * The agim backend's auth model is simple: the operator copies a
 * token from `~/.agim/tokens.json` (or runs `agim token list`) and
 * pastes it here. POST /api/auth/login validates it (timing-safe
 * SHA-256 compare) and returns `{ok, tokenId}`. We additionally
 * stash the raw token in localStorage so future fetches attach
 * Authorization: Bearer.
 *
 * Mobile-aware:
 *   * Single full-width form; no chrome.
 *   * `inputMode="text"` + `autoComplete="off"` — never autofill a
 *     token from password managers.
 *   * Submit button uses `size="lg"` to clear the 44×44 hit target
 *     even with the keyboard up.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { api } from '@/lib/api/endpoints'
import { describeError } from '@/lib/api/errors'
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

/** Sanitize the `next` query param: only allow same-origin paths so a
 *  rogue `?next=https://evil.com/` can't redirect off-domain after
 *  login. Falls back to `/` for anything else. */
function safeNext(raw: string | null): string {
  if (!raw) return '/'
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith('/') && !decoded.startsWith('//')) return decoded
  } catch {
    /* malformed encoding */
  }
  return '/'
}

export default function LoginRoute(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setToken = useAuth((s) => s.setToken)
  const [token, setLocalToken] = useState('')

  const next = safeNext(params.get('next'))

  const login = useMutation({
    mutationFn: (raw: string) => api.login({ token: raw }),
    onSuccess: () => {
      // POST returned ok — token validates server-side. Persist + go.
      setToken(token.trim())
      toast.success(t('states.saved'))
      navigate(next, { replace: true })
    },
    onError: (err) => {
      const { message } = describeError(err, t)
      toast.error(message)
    },
  })

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const v = token.trim()
    if (!v) return
    login.mutate(v)
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
            {t('login.intro', {
              defaultValue:
                'Paste your access token from ~/.agim/tokens.json or `agim token list`.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="token">
                {t('login.tokenLabel', { defaultValue: 'Access token' })}
              </Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setLocalToken(e.target.value)}
                placeholder="agim_••••••••"
                autoComplete="off"
                autoFocus
                required
              />
            </div>
            <Button
              type="submit"
              size="lg"
              disabled={login.isPending || token.trim().length === 0}
            >
              {login.isPending
                ? t('states.loading')
                : t('login.submit', { defaultValue: 'Sign in' })}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="block text-xs text-text-muted">
          {t('login.hint', {
            defaultValue:
              'Loopback (127.0.0.1) requests bypass this check; you only see this page when accessing agim from another host or with IMHUB_TRUST_LOOPBACK=off.',
          })}
        </CardFooter>
      </Card>
    </div>
  )
}
