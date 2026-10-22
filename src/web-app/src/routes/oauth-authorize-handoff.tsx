import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { reloadServerPage } from '@/lib/full-navigation'

/**
 * Safety net when a client-side redirect lands on the authorize path.
 * The consent form is HTML from the server. This route reloads that URL
 * instead of letting the SPA 404 own it.
 */
export default function OauthAuthorizeHandoff(): null {
  const loc = useLocation()
  useEffect(() => {
    reloadServerPage(`${loc.pathname}${loc.search}`)
  }, [loc.pathname, loc.search])
  return null
}
