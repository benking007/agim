// `/web` — print the URL of this host's web console.
//
// Source of truth: Viewer config. Resolution order (see
// core/viewer-config.ts → getEffectivePublicBaseUrl):
//   1. AGIM_VIEWER_PUBLIC_BASE_URL (operator-set reverse proxy / custom domain)
//   2. Cloudflared quick-tunnel URL (when AGIM_VIEWER_TUNNEL_MODE=quick)
//   3. (none) → degrade to a localhost hint
//
// The same /v/<id> mapping that the long-message render router uses; this
// command just exposes the base so users can bookmark the console from IM.

import type { RouteContext } from '../router.js'
import { getEffectivePublicBaseUrl, getViewerConfig } from '../viewer-config.js'

export async function handleWebCommand(_args: string, _ctx: RouteContext): Promise<string> {
  void _args
  void _ctx
  const cfg = getViewerConfig()
  const url = getEffectivePublicBaseUrl()
  if (url) {
    const source = cfg.publicBaseUrl
      ? 'AGIM_VIEWER_PUBLIC_BASE_URL'
      : 'cloudflared tunnel'
    return `🌐 Web 后台\n   ${url}\n   (来源: ${source})`
  }
  return (
    '🌐 Web 后台地址未配置。\n' +
    '   设置以下任一项后重启服务即可：\n' +
    '     • AGIM_VIEWER_PUBLIC_BASE_URL=https://your-domain  (反代/自定义域名)\n' +
    '     • AGIM_VIEWER_TUNNEL_MODE=quick                    (cloudflared 临时隧道)'
  )
}
