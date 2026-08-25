import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import '@/i18n'
import { PortalEmptyChat } from './portal-empty-chat'

describe('PortalEmptyChat', () => {
  it('shows a loading spinner while the session history is in flight', () => {
    render(<PortalEmptyChat dark={false} loading />)
    expect(screen.getByTestId('portal-session-loading')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/加载会话|Loading conversation/)
    expect(screen.queryByText('Brand Palettes')).not.toBeInTheDocument()
    expect(screen.queryByText('UI Architecture')).not.toBeInTheDocument()
    expect(screen.queryByText('Agim')).not.toBeInTheDocument()
  })

  it('hides starter prompt cards and the agent title on an idle empty session', () => {
    render(<PortalEmptyChat dark={false} />)
    expect(screen.queryByTestId('portal-session-loading')).not.toBeInTheDocument()
    expect(screen.queryByText('Brand Palettes')).not.toBeInTheDocument()
    expect(screen.queryByText('UI Architecture')).not.toBeInTheDocument()
    expect(screen.queryByText('Agim')).not.toBeInTheDocument()
    expect(screen.getByTestId('portal-empty-chat')).toBeInTheDocument()
  })
})
