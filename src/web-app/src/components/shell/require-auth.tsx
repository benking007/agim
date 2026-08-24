/**
 * RequireAuth — route guard. Redirects unsigned visitors to /login or
 * /register (first user) while preserving `?next=`.
 */

import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/stores/auth'

interface RequireAuthProps {
  children: ReactNode
}

export function RequireAuth({ children }: RequireAuthProps): JSX.Element {
  const signedIn = useAuth((s) => s.signedIn)
  const ready = useAuth((s) => s.ready)
  const hasUsers = useAuth((s) => s.hasUsers)
  const location = useLocation()

  if (!signedIn && !ready) {
    return <></>
  }

  if (!signedIn) {
    const next = encodeURIComponent(location.pathname + location.search)
    const dest = hasUsers === false ? '/register' : '/login'
    return <Navigate to={`${dest}?next=${next}`} replace />
  }
  return <>{children}</>
}
