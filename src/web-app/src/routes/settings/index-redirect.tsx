import { Navigate } from 'react-router-dom'
import { useAuth, useIsAdmin } from '@/stores/auth'

export default function SettingsIndexRedirect(): JSX.Element | null {
  const ready = useAuth((s) => s.ready)
  const isAdmin = useIsAdmin()
  if (!ready) return null
  return <Navigate to={isAdmin ? 'start' : 'account'} replace />
}
