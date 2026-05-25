/**
 * /settings/security — central console for v1.2.66 security controls.
 *
 * Lays out:
 *   • Diagnostics card (read-only) — uid 0? env file perms? bwrap? allowlists configured?
 *   • Sender allowlist (IMHUB_ALLOWED_USERS)
 *   • Native exec (IMHUB_EXEC_SANDBOX, IMHUB_EXEC_SANDBOX_NET, IMHUB_EXEC_TIMEOUT_MS, IMHUB_EXEC_MAX_OUTPUT)
 *   • Native web (IMHUB_NATIVE_WEB_ALLOW_PRIVATE, IMHUB_NATIVE_WEB_SSRF_WHITELIST, IMHUB_NATIVE_WEB_TIMEOUT_MS)
 *   • Native fs  (IMHUB_NATIVE_FS_RESTRICT, IMHUB_NATIVE_FS_TIMEOUT_MS)
 *   • Delegation (IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN)
 *
 * All writes go through PUT /api/env (admin-gated). Most knobs are
 * hot-reloaded (read process.env per tool call); the exec sandbox +
 * sender allowlist apply at boot — service restart required.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw, ShieldAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEnv, useUpdateEnv } from '@/hooks/use-settings'
import { client } from '@/lib/api/client'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

interface Diagnostics {
  runningAsRoot: boolean | null
  envFile: { exists: boolean; mode: string | null; tooPermissive: boolean }
  bwrapAvailable: boolean
  senderAllowlistConfigured: boolean
  adminAllowlistConfigured: boolean
  platformBlacklist: string[]
  liveEnv: Record<string, string | null>
}

function envBool(v: string | undefined): boolean {
  if (v == null) return false
  const t = v.toLowerCase()
  return t === '1' || t === 'true' || t === 'yes' || t === 'on'
}

export default function SettingsSecurityRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv()
  const updateEnv = useUpdateEnv()
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)

  async function loadDiagnostics(): Promise<void> {
    setDiagLoading(true)
    try {
      const res = await client.get<{ diagnostics: Diagnostics }>('/api/security/diagnostics')
      setDiagnostics(res.diagnostics)
    } catch (err) {
      toast.error(describeError(err, t).message)
    } finally {
      setDiagLoading(false)
    }
  }

  useEffect(() => { void loadDiagnostics() }, [])

  async function setValue(key: string, value: string | null): Promise<void> {
    try {
      await updateEnv.mutateAsync({ updates: { [key]: value } })
      toast.success(t('security.savingToast'))
      await loadDiagnostics()
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  const env = envQuery.data?.env ?? {}

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('security.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => { void envQuery.refetch(); void loadDiagnostics() }}
            disabled={envQuery.isFetching || diagLoading}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {envQuery.isFetching || diagLoading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCcw className="h-4 w-4" />
            }
          </Button>
        </div>
        <p className="text-sm text-muted">{t('security.subtitle')}</p>
      </header>

      {/* Diagnostics card */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4" />
          {t('security.diagnostics.title')}
        </h2>
        {diagnostics ? (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <DiagRow
              label={t('security.diagnostics.runningAsRoot')}
              ok={diagnostics.runningAsRoot === false}
              text={diagnostics.runningAsRoot === true ? t('security.diagnostics.runningAsRootHelp') : 'OK'}
            />
            <DiagRow
              label={t('security.diagnostics.envFilePerms')}
              ok={diagnostics.envFile.exists && !diagnostics.envFile.tooPermissive}
              text={
                !diagnostics.envFile.exists
                  ? '—'
                  : diagnostics.envFile.tooPermissive
                    ? `${diagnostics.envFile.mode} — ${t('security.diagnostics.envFilePermsLax')}`
                    : t('security.diagnostics.envFilePermsOk')
              }
            />
            <DiagRow
              label={t('security.diagnostics.bwrapAvailable')}
              ok={diagnostics.bwrapAvailable}
              text={diagnostics.bwrapAvailable ? '/usr/bin/bwrap' : t('security.diagnostics.bwrapMissing')}
            />
            <DiagRow
              label={t('security.diagnostics.senderAllowlist')}
              ok={diagnostics.senderAllowlistConfigured}
              text={diagnostics.senderAllowlistConfigured
                ? t('security.diagnostics.senderAllowlistOn')
                : t('security.diagnostics.senderAllowlistOff')
              }
            />
            <DiagRow
              label={t('security.diagnostics.adminAllowlist')}
              ok={diagnostics.adminAllowlistConfigured}
              text={diagnostics.adminAllowlistConfigured
                ? t('security.diagnostics.adminAllowlistOn')
                : t('security.diagnostics.adminAllowlistOff')
              }
            />
            <DiagRow
              label={t('security.diagnosticsPlatformBlacklist')}
              ok={diagnostics.platformBlacklist.length === 0}
              text={diagnostics.platformBlacklist.length === 0
                ? '—'
                : diagnostics.platformBlacklist.join(', ')
              }
            />
          </ul>
        ) : (
          <p className="text-sm text-muted">…</p>
        )}
      </section>

      {/* Sender allowlist */}
      <ControlCard
        title={t('security.sender.title')}
        description={t('security.sender.description')}
        envKey="IMHUB_ALLOWED_USERS"
      >
        <Input
          defaultValue={env.IMHUB_ALLOWED_USERS ?? ''}
          placeholder={t('security.sender.placeholder')}
          onBlur={(e) => {
            const v = e.target.value.trim()
            void setValue('IMHUB_ALLOWED_USERS', v === '' ? null : v)
          }}
        />
      </ControlCard>

      {/* Exec sandbox */}
      <ControlCard
        title={t('security.exec.title')}
        description={t('security.exec.description')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledField label={t('security.exec.sandbox')}>
            <Select
              value={(env.IMHUB_EXEC_SANDBOX ?? '').toLowerCase() === 'bwrap' ? 'bwrap' : '__none__'}
              onValueChange={(v) => void setValue('IMHUB_EXEC_SANDBOX', v === '__none__' ? null : v)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('security.exec.sandboxNone')}</SelectItem>
                <SelectItem
                  value="bwrap"
                  disabled={!diagnostics?.bwrapAvailable}
                >
                  {t('security.exec.sandboxBwrap')}
                  {!diagnostics?.bwrapAvailable && (
                    <span className="ml-2 text-xs text-muted">
                      ({t('security.exec.sandboxBwrapMissing')})
                    </span>
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          <LabeledField label={t('security.exec.sandboxNet')}>
            <Select
              value={(env.IMHUB_EXEC_SANDBOX_NET ?? '').toLowerCase() === 'off' ? 'off' : 'on'}
              onValueChange={(v) => void setValue('IMHUB_EXEC_SANDBOX_NET', v === 'off' ? 'off' : null)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="on">{t('security.exec.sandboxNetOn')}</SelectItem>
                <SelectItem value="off">{t('security.exec.sandboxNetOff')}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          <LabeledField label={t('security.exec.timeoutMs')}>
            <Input
              type="number"
              defaultValue={env.IMHUB_EXEC_TIMEOUT_MS ?? ''}
              placeholder="60000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('IMHUB_EXEC_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>

          <LabeledField label={t('security.exec.maxOutput')}>
            <Input
              type="number"
              defaultValue={env.IMHUB_EXEC_MAX_OUTPUT ?? ''}
              placeholder="32768"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('IMHUB_EXEC_MAX_OUTPUT', v === '' ? null : v)
              }}
            />
          </LabeledField>
        </div>
      </ControlCard>

      {/* Web SSRF */}
      <ControlCard
        title={t('security.web.title')}
        description={t('security.web.description')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledField label={t('security.web.allowPrivate')} hint={t('security.web.allowPrivateHelp')}>
            <Select
              value={envBool(env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE) ? '1' : '0'}
              onValueChange={(v) => void setValue('IMHUB_NATIVE_WEB_ALLOW_PRIVATE', v === '1' ? '1' : null)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">OFF</SelectItem>
                <SelectItem value="1">ON</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          <LabeledField label={t('security.web.timeoutMs')}>
            <Input
              type="number"
              defaultValue={env.IMHUB_NATIVE_WEB_TIMEOUT_MS ?? ''}
              placeholder="30000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('IMHUB_NATIVE_WEB_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>

          <div className="sm:col-span-2">
            <LabeledField label={t('security.web.ssrfWhitelist')}>
              <Input
                defaultValue={env.IMHUB_NATIVE_WEB_SSRF_WHITELIST ?? ''}
                placeholder={t('security.web.ssrfWhitelistPlaceholder')}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  void setValue('IMHUB_NATIVE_WEB_SSRF_WHITELIST', v === '' ? null : v)
                }}
              />
            </LabeledField>
          </div>
        </div>
      </ControlCard>

      {/* FS */}
      <ControlCard
        title={t('security.fs.title')}
        description={t('security.fs.description')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledField label={t('security.fs.restrict')}>
            <Select
              value={(env.IMHUB_NATIVE_FS_RESTRICT ?? '1') === '0' ? '0' : '1'}
              onValueChange={(v) => void setValue('IMHUB_NATIVE_FS_RESTRICT', v === '0' ? '0' : null)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t('security.fs.restrictOn')}</SelectItem>
                <SelectItem value="0">{t('security.fs.restrictOff')}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          <LabeledField label={t('security.fs.timeoutMs')}>
            <Input
              type="number"
              defaultValue={env.IMHUB_NATIVE_FS_TIMEOUT_MS ?? ''}
              placeholder="60000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('IMHUB_NATIVE_FS_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>
        </div>
      </ControlCard>

      {/* Delegation cap */}
      <ControlCard
        title={t('security.delegation.title')}
        description={t('security.delegation.description')}
        envKey="IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN"
      >
        <Input
          type="number"
          defaultValue={env.IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN ?? ''}
          placeholder="2"
          onBlur={(e) => {
            const v = e.target.value.trim()
            void setValue('IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN', v === '' ? null : v)
          }}
        />
      </ControlCard>

      {/* IM platform blacklist */}
      <ControlCard
        title={t('security.platformBlacklist.title')}
        description={t('security.platformBlacklist.description')}
        envKey="IMHUB_PLATFORM_BLACKLIST"
      >
        <Input
          defaultValue={env.IMHUB_PLATFORM_BLACKLIST ?? ''}
          placeholder={t('security.platformBlacklist.placeholder')}
          onBlur={(e) => {
            const v = e.target.value.trim()
            void setValue('IMHUB_PLATFORM_BLACKLIST', v === '' ? null : v)
          }}
        />
        {diagnostics?.platformBlacklist && diagnostics.platformBlacklist.length > 0 && (
          <p className="mt-2 text-[10px] text-muted">
            {t('security.platformBlacklist.currentLabel')}: {diagnostics.platformBlacklist.join(', ')}
          </p>
        )}
      </ControlCard>
    </div>
  )
}

function DiagRow({ label, ok, text }: { label: string; ok: boolean; text: string }): JSX.Element {
  return (
    <li className="flex items-start gap-2">
      {ok
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      }
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className={cn('text-xs', ok ? 'text-muted' : 'text-warning')}>{text}</div>
      </div>
    </li>
  )
}

function ControlCard({
  title, description, envKey, children,
}: { title: string; description: string; envKey?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {envKey && <Badge variant="outline" className="font-mono text-[10px]">{envKey}</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted">{description}</p>
      {children}
    </section>
  )
}

function LabeledField({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted">{hint}</p>}
    </div>
  )
}
