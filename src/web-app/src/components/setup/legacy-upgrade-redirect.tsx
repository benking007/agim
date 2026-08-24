/**
 * After the first admin exists, send them through /upgrade-legacy
 * if old tokens or loopback sessions are still waiting to be claimed.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { useAuth } from '@/stores/auth'

export function LegacyUpgradeRedirect({ children }: { children: ReactNode }): JSX.Element | null {
  const location = useLocation()
  const role = useAuth((s) => s.role)
  const [pending, setPending] = useState<boolean | null>(null)

  useEffect(() => {
    if (role !== 'admin') {
      setPending(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/legacy-upgrade', { credentials: 'same-origin' })
        if (!res.ok) {
          if (!cancelled) setPending(false)
          return
        }
        const body = await res.json() as { pending?: boolean }
        if (!cancelled) setPending(Boolean(body.pending))
      } catch {
        if (!cancelled) setPending(false)
      }
    })()
    return () => { cancelled = true }
  }, [role])

  if (location.pathname === '/upgrade-legacy') return <>{children}</>
  if (pending === null && role === 'admin') return null
  if (pending) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/upgrade-legacy?next=${next}`} replace />
  }
  return <>{children}</>
}
