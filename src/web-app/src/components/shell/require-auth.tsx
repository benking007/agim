/**
 * RequireAuth — route guard. Wraps every authenticated route in the
 * router config so an un-signed-in visit redirects to /login while
 * preserving the intended destination in the `?next=` query so post-
 * login navigation lands the user where they were headed.
 *
 * Mirrors the legacy _app.js redirect logic (same `next` shape, same
 * localStorage key `agim_token`) so a v1 session is a valid v2 session
 * with no migration step.
 */

import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/stores/auth'

interface RequireAuthProps {
  children: ReactNode
}

export function RequireAuth({ children }: RequireAuthProps): JSX.Element {
  const signedIn = useAuth((s) => s.signedIn)
  const location = useLocation()

  if (!signedIn) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <>{children}</>
}
