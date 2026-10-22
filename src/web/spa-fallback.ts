/**
 * GET paths that receive index.html for the React router.
 * The OAuth consent page is not one of them: the server writes that HTML.
 */
export function shouldServeSpaIndex(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return false
  if (pathname.startsWith('/ws')) return false
  if (pathname === '/events') return false
  if (pathname.startsWith('/vendor/')) return false
  if (
    pathname === '/loc'
    || pathname === '/loc.html'
    || pathname.startsWith('/l/')
    || pathname.startsWith('/v/')
  ) return false
  if (pathname === '/m/login' || pathname === '/m/login.html') return false
  if (pathname.startsWith('/.well-known/oauth-')) return false
  if (pathname === '/bridge/oauth/authorize') return false
  return true
}
