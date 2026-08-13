/**
 * /settings/security — central console for v1.2.66 security controls.
 *
 * Lays out:
 *   • Diagnostics card (read-only) — uid 0? env file perms? bwrap? allowlists configured?
 *   • Sender allowlist (AGIM_ALLOWED_USERS)
 *   • Native exec (AGIM_EXEC_SANDBOX, AGIM_EXEC_SANDBOX_NET, AGIM_EXEC_TIMEOUT_MS, AGIM_EXEC_MAX_OUTPUT)
 *   • Native web (AGIM_NATIVE_WEB_ALLOW_PRIVATE, AGIM_NATIVE_WEB_SSRF_WHITELIST, AGIM_NATIVE_WEB_TIMEOUT_MS)
 *   • Native fs  (AGIM_NATIVE_FS_RESTRICT, AGIM_NATIVE_FS_TIMEOUT_MS)
 *   • Delegation (AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN)
 *
 * All writes go through PUT /api/env (admin-gated). Most knobs are
 * hot-reloaded (read process.env per tool call); the exec sandbox +
 * sender allowlist apply at boot — service restart required.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAdminAllowlist, useEnv, useUpdateEnv } from '@/hooks/use-settings'
import { client } from '@/lib/api/client'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'
import type { KnownImUser } from '@/types/api'

interface Diagnostics {
  runningAsRoot: boolean | null
  envFile: { exists: boolean; mode: string | null; tooPermissive: boolean }
  bwrapAvailable: boolean
  senderAllowlistConfigured: boolean
  adminAllowlistConfigured: boolean
  platformBlacklist: string[]
  liveEnv: Record<string, string | null>
}

interface SenderChoice {
  value: string
  label: string
  detail?: string
}

type SenderMode = 'restricted' | 'open'

function envBool(v: string | undefined): boolean {
  if (v == null) return false
  const t = v.toLowerCase()
  return t === '1' || t === 'true' || t === 'yes' || t === 'on'
}

function parseSenderAllowlist(raw: string | undefined): { mode: SenderMode; members: string[]; explicitOpen: boolean } {
  const value = (raw ?? '').trim()
  if (value === '*') return { mode: 'open', members: [], explicitOpen: true }
  if (!value) return { mode: 'open', members: [], explicitOpen: false }
  return {
    mode: 'restricted',
    members: uniqueStrings(value.split(',')),
    explicitOpen: false,
  }
}

function serializeSenderAllowlist(mode: SenderMode, members: string[]): string | null {
  if (mode === 'open') return '*'
  const values = uniqueStrings(members)
  return values.length > 0 ? values.join(',') : null
}

function senderValueFingerprint(mode: SenderMode, members: string[]): string {
  return mode === 'open' ? '*' : uniqueStrings(members).join(',')
}

export default function SettingsSecurityRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const envQuery = useEnv()
  const updateEnv = useUpdateEnv()
  const adminsQuery = useAdminAllowlist()
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [senderMode, setSenderMode] = useState<SenderMode>('open')
  const [senderMembers, setSenderMembers] = useState<string[]>([])

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    setDiagLoading(true)
    try {
      const res = await client.get<{ diagnostics: Diagnostics }>('/api/security/diagnostics')
      setDiagnostics(res.diagnostics)
    } catch (err) {
      toast.error(describeError(err, t).message)
    } finally {
      setDiagLoading(false)
    }
  }, [t])

  useEffect(() => { void loadDiagnostics() }, [loadDiagnostics])

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
  const senderParsed = useMemo(() => parseSenderAllowlist(env.AGIM_ALLOWED_USERS), [env.AGIM_ALLOWED_USERS])
  const senderChoices = useMemo<SenderChoice[]>(() => {
    const choices = new Map<string, SenderChoice>()
    for (const u of adminsQuery.data?.knownUsers ?? []) {
      const key = imUserKey(u)
      choices.set(key, {
        value: key,
        label: key,
        detail: t('security.sender.lastSeen', { time: formatSeenAt(u.lastSeenAt) }),
      })
    }
    for (const member of senderMembers) {
      if (!choices.has(member)) {
        choices.set(member, {
          value: member,
          label: member,
          detail: t('security.sender.fromCurrentValue'),
        })
      }
    }
    return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [adminsQuery.data?.knownUsers, senderMembers, t])
  const senderDirty = senderMode === 'open'
    ? senderParsed.mode !== 'open' || !senderParsed.explicitOpen
    : senderValueFingerprint(senderMode, senderMembers)
      !== senderValueFingerprint(senderParsed.mode, senderParsed.members)

  useEffect(() => {
    setSenderMode(senderParsed.mode)
    setSenderMembers(senderParsed.members)
  }, [senderParsed.mode, senderParsed.members])

  async function saveSenderAllowlist(): Promise<void> {
    const next = serializeSenderAllowlist(senderMode, senderMembers)
    if (senderMode === 'restricted' && next === null) {
      toast.error(t('security.sender.emptyRestrictedToast'))
      return
    }
    await setValue('AGIM_ALLOWED_USERS', next)
  }

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
        <p className="text-sm text-text-dim">{t('security.subtitle')}</p>
      </header>

      <SecurityPosture
        diagnostics={diagnostics}
        env={env}
        loading={envQuery.isLoading || diagLoading}
        onSetValue={(key, value) => void setValue(key, value)}
      />

      {/* Sender allowlist */}
      <ControlCard
        id="sender-allowlist"
        title={t('security.sender.title')}
        description={t('security.sender.description')}
      >
        <SenderAllowlistEditor
          mode={senderMode}
          members={senderMembers}
          choices={senderChoices}
          loading={adminsQuery.isLoading}
          explicitOpen={senderParsed.explicitOpen}
          dirty={senderDirty}
          saving={updateEnv.isPending}
          onModeChange={setSenderMode}
          onMembersChange={setSenderMembers}
          onSave={() => void saveSenderAllowlist()}
        />
      </ControlCard>

      <DiagnosticsPanel diagnostics={diagnostics} loading={diagLoading} />

      {/* Exec sandbox */}
      <ControlCard
        title={t('security.exec.title')}
        description={t('security.exec.description')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledField label={t('security.exec.sandbox')}>
            <Select
              value={(env.AGIM_EXEC_SANDBOX ?? '').toLowerCase() === 'bwrap' ? 'bwrap' : '__none__'}
              onValueChange={(v) => void setValue('AGIM_EXEC_SANDBOX', v === '__none__' ? null : v)}
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
                    <span className="ml-2 text-xs text-text-muted">
                      ({t('security.exec.sandboxBwrapMissing')})
                    </span>
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>

          <LabeledField label={t('security.exec.sandboxNet')}>
            <Select
              value={(env.AGIM_EXEC_SANDBOX_NET ?? '').toLowerCase() === 'off' ? 'off' : 'on'}
              onValueChange={(v) => void setValue('AGIM_EXEC_SANDBOX_NET', v === 'off' ? 'off' : null)}
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
              defaultValue={env.AGIM_EXEC_TIMEOUT_MS ?? ''}
              placeholder="60000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('AGIM_EXEC_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>

          <LabeledField label={t('security.exec.maxOutput')}>
            <Input
              type="number"
              defaultValue={env.AGIM_EXEC_MAX_OUTPUT ?? ''}
              placeholder="32768"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('AGIM_EXEC_MAX_OUTPUT', v === '' ? null : v)
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
              value={envBool(env.AGIM_NATIVE_WEB_ALLOW_PRIVATE) ? '1' : '0'}
              onValueChange={(v) => void setValue('AGIM_NATIVE_WEB_ALLOW_PRIVATE', v === '1' ? '1' : null)}
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
              defaultValue={env.AGIM_NATIVE_WEB_TIMEOUT_MS ?? ''}
              placeholder="30000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('AGIM_NATIVE_WEB_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>

          <div className="sm:col-span-2">
            <LabeledField label={t('security.web.ssrfWhitelist')}>
              <Input
                defaultValue={env.AGIM_NATIVE_WEB_SSRF_WHITELIST ?? ''}
                placeholder={t('security.web.ssrfWhitelistPlaceholder')}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  void setValue('AGIM_NATIVE_WEB_SSRF_WHITELIST', v === '' ? null : v)
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
              value={(env.AGIM_NATIVE_FS_RESTRICT ?? '0') === '1' ? '1' : '0'}
              onValueChange={(v) => void setValue('AGIM_NATIVE_FS_RESTRICT', v === '1' ? '1' : null)}
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
              defaultValue={env.AGIM_NATIVE_FS_TIMEOUT_MS ?? ''}
              placeholder="60000"
              onBlur={(e) => {
                const v = e.target.value.trim()
                void setValue('AGIM_NATIVE_FS_TIMEOUT_MS', v === '' ? null : v)
              }}
            />
          </LabeledField>
        </div>
      </ControlCard>

      {/* Delegation cap */}
      <ControlCard
        title={t('security.delegation.title')}
        description={t('security.delegation.description')}
        envKey="AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN"
      >
        <Input
          type="number"
          defaultValue={env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN ?? ''}
          placeholder="2"
          onBlur={(e) => {
            const v = e.target.value.trim()
            void setValue('AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN', v === '' ? null : v)
          }}
        />
      </ControlCard>

      {/* IM platform blacklist */}
      <ControlCard
        title={t('security.platformBlacklist.title')}
        description={t('security.platformBlacklist.description')}
        envKey="AGIM_PLATFORM_BLACKLIST"
      >
        <Input
          defaultValue={env.AGIM_PLATFORM_BLACKLIST ?? ''}
          placeholder={t('security.platformBlacklist.placeholder')}
          onBlur={(e) => {
            const v = e.target.value.trim()
            void setValue('AGIM_PLATFORM_BLACKLIST', v === '' ? null : v)
          }}
        />
        {diagnostics?.platformBlacklist && diagnostics.platformBlacklist.length > 0 && (
          <p className="mt-2 text-[10px] text-text-muted">
            {t('security.platformBlacklist.currentLabel')}: {diagnostics.platformBlacklist.join(', ')}
          </p>
        )}
      </ControlCard>
    </div>
  )
}

function SecurityPosture({
  diagnostics,
  env,
  loading,
  onSetValue,
}: {
  diagnostics: Diagnostics | null
  env: Record<string, string | undefined>
  loading: boolean
  onSetValue: (key: string, value: string | null) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const sender = parseSenderAllowlist(env.AGIM_ALLOWED_USERS)
  const issues = useMemo(() => {
    const rows: Array<{
      id: string
      level: 'danger' | 'warn'
      title: string
      detail: string
      action?: JSX.Element
    }> = []

    if (envBool(env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS)) {
      rows.push({
        id: 'skip-permissions',
        level: 'danger',
        title: t('security.posture.issue.skipPermissions.title'),
        detail: t('security.posture.issue.skipPermissions.detail'),
        action: (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs text-danger"
            onClick={() => onSetValue('AGIM_DANGEROUSLY_SKIP_PERMISSIONS', '0')}
          >
            {t('security.posture.issue.skipPermissions.action')}
          </Button>
        ),
      })
    }

    if (sender.mode === 'open') {
      rows.push({
        id: 'sender-open',
        level: 'warn',
        title: sender.explicitOpen
          ? t('security.posture.issue.senderOpenExplicit.title')
          : t('security.posture.issue.senderOpenImplicit.title'),
        detail: sender.explicitOpen
          ? t('security.posture.issue.senderOpenExplicit.detail')
          : t('security.posture.issue.senderOpenImplicit.detail'),
        action: (
          <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" asChild>
            <a href="#sender-allowlist">{t('security.posture.issue.senderOpenImplicit.action')}</a>
          </Button>
        ),
      })
    }

    if (diagnostics && !diagnostics.adminAllowlistConfigured) {
      rows.push({
        id: 'admin-empty',
        level: 'warn',
        title: t('security.posture.issue.adminEmpty.title'),
        detail: t('security.posture.issue.adminEmpty.detail'),
        action: (
          <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" asChild>
            <Link to="/settings/admins">{t('security.posture.issue.adminEmpty.action')}</Link>
          </Button>
        ),
      })
    }

    if (diagnostics?.envFile.exists && diagnostics.envFile.tooPermissive) {
      rows.push({
        id: 'env-perms',
        level: 'warn',
        title: t('security.posture.issue.envPerms.title'),
        detail: t('security.posture.issue.envPerms.detail', { mode: diagnostics.envFile.mode ?? '---' }),
      })
    }

    if (diagnostics?.runningAsRoot === true) {
      rows.push({
        id: 'root',
        level: 'warn',
        title: t('security.posture.issue.root.title'),
        detail: t('security.posture.issue.root.detail'),
      })
    }

    if (envBool(env.AGIM_NATIVE_WEB_ALLOW_PRIVATE)) {
      rows.push({
        id: 'private-web',
        level: 'warn',
        title: t('security.posture.issue.privateWeb.title'),
        detail: t('security.posture.issue.privateWeb.detail'),
        action: (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => onSetValue('AGIM_NATIVE_WEB_ALLOW_PRIVATE', null)}
          >
            {t('security.posture.issue.privateWeb.action')}
          </Button>
        ),
      })
    }

    if (!envBool(env.AGIM_NATIVE_FS_RESTRICT)) {
      rows.push({
        id: 'fs-open',
        level: 'warn',
        title: t('security.posture.issue.fsOpen.title'),
        detail: t('security.posture.issue.fsOpen.detail'),
        action: (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => onSetValue('AGIM_NATIVE_FS_RESTRICT', '1')}
          >
            {t('security.posture.issue.fsOpen.action')}
          </Button>
        ),
      })
    }

    const sandboxOff = (env.AGIM_EXEC_SANDBOX ?? '').toLowerCase() === 'off'
    if (
      env.AGIM_NATIVE_FS_RESTRICT === '0'
      && diagnostics?.bwrapAvailable
      && !sandboxOff
    ) {
      rows.push({
        id: 'fs-write-unconfined',
        level: 'danger',
        title: t('security.posture.issue.fsWriteUnconfined.title'),
        detail: t('security.posture.issue.fsWriteUnconfined.detail'),
        action: (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => onSetValue('AGIM_NATIVE_FS_RESTRICT', null)}
          >
            {t('security.posture.issue.fsWriteUnconfined.action')}
          </Button>
        ),
      })
    }

    return rows
  }, [diagnostics, env, onSetValue, sender.explicitOpen, sender.mode, t])

  const dangerCount = issues.filter((issue) => issue.level === 'danger').length
  const ready = !loading && issues.length === 0

  return (
    <section className={cn(
      'rounded-md border p-4 shadow-sm',
      dangerCount > 0 ? 'border-danger/60 bg-danger-bg/30' : 'border-border bg-surface',
    )}>
      <div className="flex flex-wrap items-center gap-2">
        {ready ? <ShieldCheck className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-warning" />}
        <h2 className="text-sm font-semibold">{t('security.posture.title')}</h2>
        <Badge variant={ready ? 'success' : dangerCount > 0 ? 'danger' : 'warning'}>
          {loading
            ? t('security.posture.loading')
            : ready
              ? t('security.posture.ready')
              : t('security.posture.needsAction', { count: issues.length })}
        </Badge>
        <p className="basis-full text-xs text-text-dim sm:basis-auto sm:ml-2">
          {ready ? t('security.posture.readyDetail') : t('security.posture.detail')}
        </p>
      </div>

      {loading ? (
        <div className="mt-3 h-10 rounded-md bg-surface-2 animate-pulse" />
      ) : issues.length > 0 ? (
        <ul className="mt-3 grid gap-3 md:grid-cols-3">
          {issues.slice(0, 5).map((issue) => (
            <li
              key={issue.id}
              className={cn(
                'min-w-0 rounded-md border border-l-2 p-3',
                issue.level === 'danger'
                  ? 'border-danger/40 border-l-danger bg-danger-bg/45'
                  : 'border-warning/40 border-l-warning bg-warning-bg/55',
              )}
            >
              <div className="text-sm font-medium">{issue.title}</div>
              <div className="mt-0.5 text-xs text-text-dim">{issue.detail}</div>
              {issue.action && (
                <div className="mt-1">
                  {issue.action}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function DiagnosticsPanel({
  diagnostics,
  loading,
}: {
  diagnostics: Diagnostics | null
  loading: boolean
}): JSX.Element {
  const { t } = useTranslation('settings')

  return (
    <details className="rounded-md border border-border bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-text-dim" />
        <span>{t('security.diagnostics.title')}</span>
        <span className="text-xs font-normal text-text-muted">{t('security.diagnostics.summary')}</span>
        <Badge variant="outline" className="ml-auto">{t('security.diagnostics.advanced')}</Badge>
      </summary>
      <div className="border-t border-border bg-surface-2/35 px-3 py-3">
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
          <p className="text-sm text-text-dim">{loading ? t('security.posture.loading') : '…'}</p>
        )}
      </div>
    </details>
  )
}

function SenderAllowlistEditor({
  mode,
  members,
  choices,
  loading,
  explicitOpen,
  dirty,
  saving,
  onModeChange,
  onMembersChange,
  onSave,
}: {
  mode: SenderMode
  members: string[]
  choices: SenderChoice[]
  loading: boolean
  explicitOpen: boolean
  dirty: boolean
  saving: boolean
  onModeChange: (mode: SenderMode) => void
  onMembersChange: (members: string[]) => void
  onSave: () => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const [custom, setCustom] = useState('')
  const selected = uniqueStrings(members)
  const selectedSet = useMemo(() => new Set(selected), [selected])

  function toggle(value: string): void {
    if (selectedSet.has(value)) {
      onMembersChange(selected.filter((item) => item !== value))
    } else {
      onMembersChange([...selected, value])
    }
  }

  function addCustom(): void {
    const parsed = uniqueStrings(custom.split(','))
    if (parsed.length === 0) return
    onMembersChange(uniqueStrings([...selected, ...parsed]))
    setCustom('')
    onModeChange('restricted')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'restricted' ? 'default' : 'secondary'}
          onClick={() => onModeChange('restricted')}
          aria-pressed={mode === 'restricted'}
        >
          {t('security.sender.modeRestricted')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'open' ? 'default' : 'secondary'}
          onClick={() => onModeChange('open')}
          aria-pressed={mode === 'open'}
        >
          {t('security.sender.modeOpen')}
        </Button>
        {mode === 'open' && (
          <Badge variant={explicitOpen ? 'outline' : 'warning'}>
            {explicitOpen ? t('security.sender.openExplicit') : t('security.sender.openImplicit')}
          </Badge>
        )}
      </div>

      {mode === 'restricted' ? (
        <div className="rounded-md border border-border bg-surface-2 p-2">
          <div className="flex min-h-8 flex-wrap items-center gap-1.5">
            {selected.length === 0 ? (
              <span className="px-1 text-xs text-text-muted">{t('security.sender.emptyMembers')}</span>
            ) : selected.map((item) => (
              <Badge key={item} variant="secondary" className="normal-case tracking-normal">
                <span className="font-mono">{item}</span>
                <button
                  type="button"
                  className="ml-1 rounded-full text-text-dim hover:text-text"
                  onClick={() => onMembersChange(selected.filter((value) => value !== item))}
                  aria-label={t('security.sender.removeMember', { value: item })}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {t('security.sender.chooseMembers')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-80 overflow-y-auto">
                <DropdownMenuLabel>{t('security.sender.chooseMembers')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {choices.length === 0 ? (
                  <div className="px-2 py-2 text-sm text-text-muted">{t('security.sender.noChoices')}</div>
                ) : choices.map((choice) => (
                  <DropdownMenuCheckboxItem
                    key={choice.value}
                    checked={selectedSet.has(choice.value)}
                    onCheckedChange={() => toggle(choice.value)}
                    onSelect={(event) => event.preventDefault()}
                    className="items-start gap-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{choice.label}</span>
                      {choice.detail && (
                        <span className="mt-0.5 block truncate text-xs text-text-muted">{choice.detail}</span>
                      )}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex min-w-[220px] flex-1 gap-2">
              <Input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustom()
                  }
                }}
                placeholder={t('security.sender.placeholder')}
                className="h-7 font-mono text-xs"
              />
              <Button type="button" variant="secondary" size="sm" onClick={addCustom} disabled={!custom.trim()}>
                {t('security.sender.addCustom')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{t('security.sender.openHint')}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saving || !dirty || (mode === 'restricted' && selected.length === 0)}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {t('security.sender.save')}
        </Button>
        <span className="text-[10px] text-text-muted">
          {dirty ? t('security.sender.unsaved') : t('security.sender.saved')}
        </span>
      </div>
    </div>
  )
}

function DiagRow({ label, ok, text }: { label: string; ok: boolean; text: string }): JSX.Element {
  return (
    <li className="flex items-start gap-2 rounded-md border border-border bg-surface p-3">
      {ok
        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      }
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className={cn('text-xs', ok ? 'text-text-muted' : 'text-warning')}>{text}</div>
      </div>
    </li>
  )
}

function ControlCard({
  id, title, description, envKey, children,
}: { id?: string; title: string; description: string; envKey?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section id={id} className="rounded-md border border-border bg-surface p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {envKey && <Badge variant="outline" className="font-mono text-[10px]">{envKey}</Badge>}
      </div>
      <p className="mb-3 text-xs text-text-dim">{description}</p>
      {children}
    </section>
  )
}

function LabeledField({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-text-dim">{label}</div>
      {children}
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  )
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function imUserKey(user: KnownImUser): string {
  return `${user.platform}:${user.userId}`
}

function formatSeenAt(value: string): string {
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return value
  return dt.toLocaleString()
}
