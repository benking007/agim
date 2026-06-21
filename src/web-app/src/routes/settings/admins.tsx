/**
 * /settings/admins — manage IM administrators via known IM users.
 *
 * Candidate users are auto-discovered from real inbound IM messages.
 * Operators grant admin from the discovered list (no manual userId typing).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RefreshCcw, Shield, Trash2, UserPlus, Users } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  useAddAdmin,
  useAdminAllowlist,
  useRemoveAdmin,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import type { AdminEntry, KnownImUser } from '@/types/api'

function formatSeenAt(value: string): string {
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return value
  return dt.toLocaleString()
}

export default function SettingsAdminsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useAdminAllowlist()
  const data = listQuery.data

  const addAdmin = useAddAdmin()
  const removeAdmin = useRemoveAdmin()

  const [removeTarget, setRemoveTarget] = useState<AdminEntry | null>(null)
  const adminKeys = useMemo(
    () => new Set((data?.admins ?? []).map((row) => `${row.platform}:${row.userId}`)),
    [data?.admins],
  )

  async function onPromote(user: KnownImUser): Promise<void> {
    try {
      await addAdmin.mutateAsync({ platform: user.platform, userId: user.userId })
      toast.success(t('admins.toast.added'))
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  async function onConfirmRemove(): Promise<void> {
    if (!removeTarget) return
    try {
      await removeAdmin.mutateAsync(removeTarget)
      toast.success(t('admins.toast.removed'))
    } catch (err) {
      toast.error(describeError(err, t).message)
      throw err
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('admins.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {listQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('admins.subtitle')}</p>
      </header>

      {data && (
        <div className="flex flex-wrap items-center gap-2">
          {data.configured ? (
            <Badge variant="success">{t('admins.configured')}</Badge>
          ) : (
            <Badge variant="warning">{t('admins.notConfigured')}</Badge>
          )}
          <Badge variant="info">{t('admins.known.count', { count: data.knownUsers.length })}</Badge>
        </div>
      )}

      {listQuery.isLoading ? (
        <div className="h-32 rounded-md bg-surface-2 animate-pulse" />
      ) : data && data.admins.length === 0 ? (
        <EmptyState icon={<Shield />} title={t('admins.empty')} />
      ) : data ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">{t('admins.col.platform')}</TableHead>
              <TableHead>{t('admins.col.userId')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.admins.map((a) => (
              <TableRow key={`${a.platform}:${a.userId}`}>
                <TableCell className="font-mono">{a.platform}</TableCell>
                <TableCell className="font-mono text-xs">{a.userId}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveTarget(a)}
                    disabled={removeAdmin.isPending}
                    aria-label={t('admins.remove.label')}
                  >
                    <Trash2 className="h-3 w-3" />
                    <span className="sr-only sm:not-sr-only sm:ml-1">{t('admins.remove.label')}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <section className="rounded-md border border-border bg-surface p-4">
        <div className="mb-3 flex flex-col gap-1">
          <div className="text-sm font-medium">{t('admins.known.title')}</div>
          <div className="text-xs text-text-dim">{t('admins.known.hint')}</div>
        </div>
        {listQuery.isLoading ? (
          <div className="h-20 rounded-md bg-surface-2 animate-pulse" />
        ) : data && data.knownUsers.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t('admins.known.empty')}
            description={t('admins.known.emptyHint')}
          />
        ) : data ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">{t('admins.col.platform')}</TableHead>
                <TableHead>{t('admins.col.userId')}</TableHead>
                <TableHead className="w-48">{t('admins.known.col.lastSeen')}</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.knownUsers.map((u) => {
                const key = `${u.platform}:${u.userId}`
                const alreadyAdmin = adminKeys.has(key)
                return (
                  <TableRow key={key}>
                    <TableCell className="font-mono">{u.platform}</TableCell>
                    <TableCell className="font-mono text-xs">{u.userId}</TableCell>
                    <TableCell className="text-xs text-text-dim">{formatSeenAt(u.lastSeenAt)}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant={alreadyAdmin ? 'ghost' : 'outline'}
                        disabled={alreadyAdmin || addAdmin.isPending}
                        onClick={() => void onPromote(u)}
                        aria-label={alreadyAdmin ? t('admins.known.alreadyAdmin') : t('admins.known.promote')}
                      >
                        {addAdmin.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                        {alreadyAdmin ? t('admins.known.alreadyAdmin') : t('admins.known.promote')}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : null}
      </section>

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t('admins.remove.confirmTitle')}
        description={t('admins.remove.confirmDescription')}
        intent="danger"
        confirmLabel={t('admins.remove.label')}
        onConfirm={onConfirmRemove}
      />
    </div>
  )
}
