/**
 * /upgrade-legacy — after the first admin is created, pick one old
 * web session to keep. Skip discards old tokens and their sessions.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { followNext } from '@/lib/full-navigation'
import { Button } from '@/components/ui/button'

interface LegacySession {
  id: string
  title: string
  updatedAt: number
  turns: number
  agent?: string
}

interface LegacyTokenGroup {
  id: string
  label: string
  createdAt: number
  sessions: LegacySession[]
}

interface Preview {
  pending: boolean
  tokens: LegacyTokenGroup[]
  local: { sessions: LegacySession[] }
}

function safeNext(raw: string | null): string {
  if (!raw) return '/'
  try {
    const decoded = decodeURIComponent(raw)
    if (decoded.startsWith('/') && !decoded.startsWith('//')) return decoded
  } catch { /* ignore */ }
  return '/'
}

function sessionLabel(row: LegacySession): string {
  const turns = row.turns > 0 ? ` · ${row.turns}` : ''
  const agent = row.agent ? ` · ${row.agent}` : ''
  return `${row.title}${turns}${agent}`
}

export default function UpgradeLegacyRoute(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const next = safeNext(params.get('next'))

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/auth/legacy-upgrade', { credentials: 'same-origin' })
      if (!res.ok) {
        followNext(next, (to, options) => navigate(to, options))
        return
      }
      const body = await res.json() as Preview
      if (!body.pending) {
        followNext(next, (to, options) => navigate(to, options))
        return
      }
      setPreview(body)
    })()
  }, [navigate, next])

  async function finish(body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/legacy-upgrade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json() as { error?: string; message?: string }
      if (!res.ok) {
        toast.error(json.message || json.error || 'failed')
        return
      }
      followNext(next, (to, options) => navigate(to, options))
    } finally {
      setBusy(false)
    }
  }

  if (!preview) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg px-4">
        <p className="text-sm text-text-muted">{t('legacyUpgrade.loading')}</p>
      </div>
    )
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-8">
      <div className="w-full max-w-xl space-y-5 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">
        <header>
          <h1 className="text-xl font-semibold">{t('legacyUpgrade.title')}</h1>
          <p className="mt-2 text-sm text-text-muted">{t('legacyUpgrade.hint')}</p>
        </header>

        {preview.local.sessions.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('legacyUpgrade.local')}</h2>
            <ul className="space-y-2">
              {preview.local.sessions.map((row) => (
                <li key={row.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <input
                      type="radio"
                      name="legacy-session"
                      checked={picked === row.id}
                      onChange={() => { setPicked(row.id) }}
                    />
                    <span>{sessionLabel(row)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {preview.tokens.map((token) => (
          <section key={token.id} className="space-y-2">
            <h2 className="text-sm font-medium">
              {t('legacyUpgrade.token', { label: token.label })}
            </h2>
            {token.sessions.length === 0 ? (
              <p className="text-sm text-text-muted">{t('legacyUpgrade.noSessions')}</p>
            ) : (
              <ul className="space-y-2">
                {token.sessions.map((row) => (
                  <li key={row.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="legacy-session"
                        checked={picked === row.id}
                        onChange={() => { setPicked(row.id) }}
                      />
                      <span>{sessionLabel(row)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy || !picked}
            onClick={() => { if (picked) void finish({ threadId: picked }) }}
          >
            {t('legacyUpgrade.inherit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => { void finish({ skip: true }) }}
          >
            {t('legacyUpgrade.skip')}
          </Button>
        </div>
        <p className="text-xs text-text-muted">{t('legacyUpgrade.skipHint')}</p>
      </div>
    </div>
  )
}
