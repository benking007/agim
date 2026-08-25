import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Brain } from 'lucide-react'

import '@/i18n'
import { PortalEmptyChat } from './portal-empty-chat'

const visual = { color: 'from-sky-500 to-blue-600' }

describe('PortalEmptyChat', () => {
  it('shows a loading spinner while the session history is in flight', () => {
    render(
      <PortalEmptyChat
        dark={false}
        agentId="agim"
        visual={visual}
        AgentIcon={Brain}
        loading
      />,
    )
    expect(screen.getByTestId('portal-session-loading')).toBeInTheDocument()
    expect(screen.queryByText('Brand Palettes')).not.toBeInTheDocument()
    expect(screen.queryByText('UI Architecture')).not.toBeInTheDocument()
  })

  it('hides starter prompt cards on an idle empty session', () => {
    render(
      <PortalEmptyChat
        dark={false}
        agentId="agim"
        visual={visual}
        AgentIcon={Brain}
      />,
    )
    expect(screen.queryByTestId('portal-session-loading')).not.toBeInTheDocument()
    expect(screen.queryByText('Brand Palettes')).not.toBeInTheDocument()
    expect(screen.queryByText('UI Architecture')).not.toBeInTheDocument()
    expect(screen.getByTestId('portal-empty-chat')).toBeInTheDocument()
  })
})
