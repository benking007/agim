/**
 * RequireAdmin — keep the user signed in and show a no-permission page
 * instead of treating AUTH_ADMIN_REQUIRED as a dead session.
 */

import type { ReactNode } from 'react'
import { useAuth, useIsAdmin } from '@/stores/auth'
import { NoPermissionPage } from '@/components/shell/no-permission'

interface RequireAdminProps {
  children: ReactNode
}

export function RequireAdmin({ children }: RequireAdminProps): JSX.Element | null {
  const ready = useAuth((s) => s.ready)
  const isAdmin = useIsAdmin()

  if (!ready) return null
  if (!isAdmin) return <NoPermissionPage />
  return <>{children}</>
}
