/** The consent page is served by the HTTP handler, not a React route. */
export function isOAuthAuthorizeNext(next: string): boolean {
  if (!next.startsWith('/') || next.startsWith('//')) return false
  const path = next.split('?')[0]?.split('#')[0] ?? ''
  return path === '/bridge/oauth/authorize'
}

/** Full document load so the server, not the SPA router, owns the response. */
export function reloadServerPage(url: string): void {
  window.location.replace(url)
}

export function followNext(
  next: string,
  navigate: (to: string, options: { replace: true }) => void,
): void {
  if (isOAuthAuthorizeNext(next)) {
    reloadServerPage(next)
    return
  }
  navigate(next, { replace: true })
}
