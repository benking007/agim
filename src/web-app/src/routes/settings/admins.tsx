/**
 * /settings/admins — manage `IMHUB_ADMIN_USERS` entries.
 *
 * Each entry is a `(platform, userId)` pair (e.g. `wechat:wxid_abc`).
 * Add via the inline form at the bottom; remove via per-row trash
 * button → ConfirmDialog. The backend's POST/DELETE handlers gate
 * on isLocalBind — if the operator is hitting agim from another
 * host the mutations 403; we surface that toast verbatim.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RefreshCcw, Shield, Trash2, UserPlus } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import type { AdminEntry } from '@/types/api'

export default function SettingsAdminsRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useAdminAllowlist()
  const data = listQuery.data

  const addAdmin = useAddAdmin()
  const removeAdmin = useRemoveAdmin()

  const [platform, setPlatform] = useState('')
  const [userId, setUserId] = useState('')
  const [removeTarget, setRemoveTarget] = useState<AdminEntry | null>(null)

  async function onAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const p = platform.trim()
    const u = userId.trim()
    if (!p || !u) return
    try {
      await addAdmin.mutateAsync({ platform: p, userId: u })
      toast.success(t('admins.toast.added'))
      setPlatform('')
      setUserId('')
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
          {data.bootstrapAvailable && (
            <Badge variant="info" title={data.bootstrapTokenPath}>
              {t('admins.bootstrapAvailable')}
            </Badge>
          )}
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

      {/* Add form */}
      <form
        onSubmit={(e) => void onAdd(e)}
        className="rounded-md border border-border bg-surface p-4"
      >
        <div className="mb-3 text-sm font-medium">{t('admins.add.title')}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1">
            <Label htmlFor="admin-platform" className="text-xs text-text-dim">
              {t('admins.add.platform')}
            </Label>
            <Input
              id="admin-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="wechat"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="admin-user" className="text-xs text-text-dim">
              {t('admins.add.userId')}
            </Label>
            <Input
              id="admin-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="wxid_abc123"
              className="font-mono text-xs"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={addAdmin.isPending || !platform.trim() || !userId.trim()}
          >
            {addAdmin.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {t('admins.add.submit')}
          </Button>
        </div>
      </form>

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
