/**
 * /settings/email — SMTP credentials editor (matches v1 settings.html's
 * "📨 SMTP" card). Drives email delivery for `/remind email me@x.com …`.
 *
 * Six env keys, persisted to `~/.agim/.env`:
 *   * AGIM_SMTP_HOST / PORT / USER / PASS / FROM / SECURE
 *
 * AGIM_SMTP_PASS is in the backend's SECRET_KEYS set — masked unless
 * the Reveal toggle issues a `?reveal=1` fetch. Submitting a masked
 * string back is a no-op on the backend (it preserves the real value).
 *
 * Test button calls POST /api/messengers/email/test which runs
 * `nodemailer.verify()` against the live env (i.e. the operator must
 * Save first, then Test — same UX as v1).
 *
 * Disable button clears all six keys via a single PUT /api/env with
 * null values; the email adapter then logs `email.disabled` on the
 * next service restart.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CheckCircle2, Eye, EyeOff, Loader2, Mail, RefreshCcw,
  Save, Send, X, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv, useTestEmail } from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

const SMTP_KEYS = [
  'AGIM_SMTP_HOST',
  'AGIM_SMTP_PORT',
  'AGIM_SMTP_USER',
  'AGIM_SMTP_PASS',
  'AGIM_SMTP_FROM',
  'AGIM_SMTP_SECURE',
] as const

type SmtpKey = typeof SMTP_KEYS[number]
type SecureMode = 'auto' | 'true' | 'false'

interface Draft {
  AGIM_SMTP_HOST: string
  AGIM_SMTP_PORT: string
  AGIM_SMTP_USER: string
  AGIM_SMTP_PASS: string
  AGIM_SMTP_FROM: string
  AGIM_SMTP_SECURE: SecureMode
}

function emptyDraft(): Draft {
  return {
    AGIM_SMTP_HOST: '',
    AGIM_SMTP_PORT: '',
    AGIM_SMTP_USER: '',
    AGIM_SMTP_PASS: '',
    AGIM_SMTP_FROM: '',
    AGIM_SMTP_SECURE: 'auto',
  }
}

// R13: exported so the unit suite can lock the env-string → SecureMode
// mapping without spinning up Radix Select (whose trigger label isn't
// readable in jsdom). Mirrors the operator's mental model: anything
// that reads as "yes/true/on" maps to true; "no/false/off" to false;
// blank / unknown to auto (defer to port-based heuristic at send time).
export function normalizeSecure(raw: string | undefined): SecureMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes')   return 'true'
  if (v === '0' || v === 'false' || v === 'no')   return 'false'
  return 'auto'
}

function draftFromEnv(env: Record<string, string>): Draft {
  return {
    AGIM_SMTP_HOST:   env.AGIM_SMTP_HOST   ?? '',
    AGIM_SMTP_PORT:   env.AGIM_SMTP_PORT   ?? '',
    AGIM_SMTP_USER:   env.AGIM_SMTP_USER   ?? '',
    AGIM_SMTP_PASS:   env.AGIM_SMTP_PASS   ?? '',
    AGIM_SMTP_FROM:   env.AGIM_SMTP_FROM   ?? '',
    AGIM_SMTP_SECURE: normalizeSecure(env.AGIM_SMTP_SECURE),
  }
}

/** Detect the backend's secret-mask format: `ab****yz` (3+ `*` between
 *  surrounding chars). PUT /api/env preserves the real value when it
 *  sees this pattern, so client edits that just echo the mask are a
 *  no-op — we skip them in the dirty check + the submit body. */
function isMasked(s: string): boolean {
  return /\*{3,}/.test(s)
}

export default function SettingsEmailRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])

  const [reveal, setReveal] = useState(false)
  const envQuery = useEnv({ reveal })
  const updateEnv = useUpdateEnv()
  const testMut = useTestEmail()

  const env = envQuery.data?.env ?? {}

  const [draft, setDraft] = useState<Draft>(emptyDraft)
  // Sync draft from server whenever a fresh env arrives (initial load
  // + reveal toggle + post-save refetch). Local edits that diverge stay
  // until the user Saves or Discards.
  useEffect(() => {
    if (!envQuery.data) return
    setDraft(draftFromEnv(envQuery.data.env))
  }, [envQuery.data])

  const isConfigured = !!(env.AGIM_SMTP_HOST && env.AGIM_SMTP_USER && env.AGIM_SMTP_PASS)

  const isDirty = useMemo(() => {
    if (!envQuery.data) return false
    const current = draftFromEnv(env)
    for (const k of SMTP_KEYS) {
      // PASS: ignore "user just echoed the mask back" as no-change.
      if (k === 'AGIM_SMTP_PASS' && draft[k] && isMasked(draft[k]) && draft[k] === current[k]) continue
      if (draft[k] !== current[k]) return true
    }
    return false
  }, [draft, env, envQuery.data])

  function setField<K extends SmtpKey>(key: K, value: Draft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function onDiscard(): void {
    if (!envQuery.data) return
    setDraft(draftFromEnv(env))
  }

  async function onSave(): Promise<void> {
    if (!envQuery.data) return
    const current = draftFromEnv(env)
    const updates: Record<string, string | null> = {}
    for (const k of SMTP_KEYS) {
      const next = draft[k]
      const cur = current[k]
      if (next === cur) continue
      // Don't ship a masked PASS as the new value — backend's
      // isMasked-detect already skips it server-side, but keep the
      // wire honest.
      if (k === 'AGIM_SMTP_PASS' && isMasked(next)) continue
      // Empty string → null (explicit unset) for non-PASS fields.
      // For PASS, an empty string also means "clear" (Disable button uses
      // the same path).
      updates[k] = next === '' ? null : next
    }
    if (Object.keys(updates).length === 0) {
      toast.info(t('email.toast.noChanges'))
      return
    }
    try {
      await updateEnv.mutateAsync({ updates })
      toast.success(t('email.toast.saved'))
      // refetch handled by hook's onSuccess; draft will re-sync via
      // the dataUpdatedAt effect on the next paint.
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function onDisable(): Promise<void> {
    if (!envQuery.data) return
    const updates: Record<string, string | null> = {}
    for (const k of SMTP_KEYS) updates[k] = null
    try {
      await updateEnv.mutateAsync({ updates })
      setDraft(emptyDraft())
      toast.success(t('email.toast.disabled'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function onTest(): Promise<void> {
    try {
      const res = await testMut.mutateAsync()
      toast.success(res.message)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  const testIcon =
    testMut.isPending  ? <Loader2 className="h-4 w-4 animate-spin" />
    : testMut.isError   ? <XCircle className="h-4 w-4 text-danger" />
    : testMut.isSuccess ? <CheckCircle2 className="h-4 w-4 text-success" />
    :                     <Send className="h-4 w-4" />

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('email.title')}</h1>
          {isConfigured
            ? <Badge variant="success">{t('email.statusOn')}</Badge>
            : <Badge variant="outline">{t('email.statusOff')}</Badge>}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void envQuery.refetch()}
            disabled={envQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {envQuery.isFetching
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('email.subtitle')}</p>
      </header>

      {envQuery.isLoading ? (
        <div className="h-64 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <section className="rounded-md border border-border bg-surface">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Mail className="h-4 w-4 text-text-dim" />
            <h2 className="text-sm font-semibold">{t('email.cardTitle')}</h2>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setReveal((v) => !v)}
              disabled={envQuery.isFetching}
              aria-label={reveal ? t('email.hide') : t('email.reveal')}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              <span className="hidden sm:inline">{reveal ? t('email.hide') : t('email.reveal')}</span>
            </Button>
          </header>

          <div className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2">
            <Field label={t('email.host')} hint={t('email.hostHint')}>
              <Input
                value={draft.AGIM_SMTP_HOST}
                onChange={(e) => setField('AGIM_SMTP_HOST', e.target.value)}
                placeholder="smtp.gmail.com"
                autoComplete="off"
              />
            </Field>
            <Field label={t('email.port')} hint={t('email.portHint')}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={draft.AGIM_SMTP_PORT}
                onChange={(e) => setField('AGIM_SMTP_PORT', e.target.value)}
                placeholder="465"
                autoComplete="off"
              />
            </Field>
            <Field label={t('email.user')} hint={t('email.userHint')}>
              <Input
                value={draft.AGIM_SMTP_USER}
                onChange={(e) => setField('AGIM_SMTP_USER', e.target.value)}
                placeholder="you@example.com"
                autoComplete="off"
              />
            </Field>
            <Field label={t('email.pass')} hint={t('email.passHint')}>
              <Input
                type={reveal ? 'text' : 'password'}
                value={draft.AGIM_SMTP_PASS}
                onChange={(e) => setField('AGIM_SMTP_PASS', e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className={cn(isMasked(draft.AGIM_SMTP_PASS) && 'font-mono text-text-muted')}
              />
            </Field>
            <Field label={t('email.from')} hint={t('email.fromHint')}>
              <Input
                value={draft.AGIM_SMTP_FROM}
                onChange={(e) => setField('AGIM_SMTP_FROM', e.target.value)}
                placeholder=""
                autoComplete="off"
              />
            </Field>
            <Field label={t('email.secure')} hint={t('email.secureHint')}>
              <Select
                value={draft.AGIM_SMTP_SECURE}
                onValueChange={(v) => setField('AGIM_SMTP_SECURE', v as SecureMode)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('email.secureAuto')}</SelectItem>
                  <SelectItem value="true">{t('email.secureTrue')}</SelectItem>
                  <SelectItem value="false">{t('email.secureFalse')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onTest()}
              disabled={!isConfigured || testMut.isPending}
              title={!isConfigured ? t('email.testNeedsConfigured') : undefined}
            >
              {testIcon}
              {t('email.testBtn')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onDisable()}
              disabled={!isConfigured || updateEnv.isPending}
              className="text-danger hover:text-danger"
            >
              <X className="h-4 w-4" />
              {t('email.disableBtn')}
            </Button>
            <span className="ml-auto" />
            {isDirty && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDiscard}
                  disabled={updateEnv.isPending}
                >
                  {t('email.discard')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void onSave()}
                  disabled={updateEnv.isPending}
                >
                  {updateEnv.isPending
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Save className="h-4 w-4" />}
                  {updateEnv.isPending ? t('email.saving') : t('email.saveBtn')}
                </Button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-text-dim">{hint}</p>}
    </div>
  )
}
