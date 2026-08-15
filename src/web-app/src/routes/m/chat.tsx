/**
 * /m/chat — Agent Portal (native-shell WebUI).
 * Visual design: docs/design/chatgpt_mobile_design_prototype.tsx
 */

import { AgentPortal } from '@/components/m-portal/agent-portal'
import { FirstRunRedirect } from '@/components/setup/first-run-redirect'

export default function MobileChatRoute(): JSX.Element {
  return (
    <FirstRunRedirect>
      <AgentPortal />
    </FirstRunRedirect>
  )
}
