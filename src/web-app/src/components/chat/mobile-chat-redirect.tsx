/**
 * Redirect phones / tablets that land on the desktop chat route (`/`)
 * to `/m/chat`. Matches the Topbar breakpoint where chat chrome children
 * used to vanish below `lg` — keep the dedicated mobile surface instead.
 * Skip when the operator asks for admin chat via `?desktop=1`.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

import { COMPOSER_PHONE_MQ } from '@/lib/composer-enter'

function readIsMobileChat(): boolean {
  if (typeof window === 'undefined') return false
  // Prefer CSS media query; fall back to innerWidth for environments
  // where device-toolbar emulation and matchMedia briefly disagree.
  if (window.matchMedia) {
    try {
      if (window.matchMedia(COMPOSER_PHONE_MQ).matches) return true
    } catch { /* ignore */ }
  }
  return window.innerWidth > 0 && window.innerWidth <= 1023
}

export function MobileChatRedirect({ children }: { children: ReactNode }): JSX.Element {
  const [searchParams] = useSearchParams()
  const forceDesktop = searchParams.get('desktop') === '1'
  // Sync init avoids a first-paint flash of the admin chat chrome.
  const [isMobile, setIsMobile] = useState(() => (forceDesktop ? false : readIsMobileChat()))

  useEffect(() => {
    if (forceDesktop) {
      setIsMobile(false)
      return
    }
    const update = (): void => setIsMobile(readIsMobileChat())
    update()
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(COMPOSER_PHONE_MQ)
      : null
    mq?.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => {
      mq?.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [forceDesktop])

  if (isMobile && !forceDesktop) {
    const qs = searchParams.toString()
    return <Navigate to={qs ? `/m/chat?${qs}` : '/m/chat'} replace />
  }
  return <>{children}</>
}
