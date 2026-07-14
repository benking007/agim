/**
 * Redirect phones that land on the desktop chat route (`/`) to `/m/chat`.
 * Desktop admin chat stays at `/`. Skip when the operator explicitly
 * asks for the admin surface via `?desktop=1`.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

const MOBILE_MQ = '(max-width: 639px)'

export function MobileChatRedirect({ children }: { children: ReactNode }): JSX.Element {
  const [searchParams] = useSearchParams()
  const forceDesktop = searchParams.get('desktop') === '1'
  const [isMobile, setIsMobile] = useState<boolean | null>(null)

  useEffect(() => {
    if (forceDesktop || typeof window === 'undefined' || !window.matchMedia) {
      setIsMobile(false)
      return
    }
    const mq = window.matchMedia(MOBILE_MQ)
    const update = (): void => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [forceDesktop])

  // SSR / first paint: render children to avoid a flash of empty.
  if (isMobile === null) return <>{children}</>
  if (isMobile && !forceDesktop) {
    const qs = searchParams.toString()
    return <Navigate to={qs ? `/m/chat?${qs}` : '/m/chat'} replace />
  }
  return <>{children}</>
}
