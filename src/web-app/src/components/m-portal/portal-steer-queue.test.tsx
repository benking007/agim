import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import '@/i18n'
import { PortalSteerQueue } from './portal-steer-queue'

describe('PortalSteerQueue', () => {
  it('renders nothing when empty', () => {
    const { container } = render(
      <PortalSteerQueue dark={false} items={[]} onSend={() => {}} onDismiss={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('sends and dismisses a queued line', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onDismiss = vi.fn()
    render(
      <PortalSteerQueue
        dark={false}
        items={[{ id: 'q1', text: 'also run tests' }]}
        onSend={onSend}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByTestId('portal-steer-queue')).toBeInTheDocument()
    expect(screen.getByText('also run tests')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    const sendBtn = buttons[0]
    const dismissBtn = buttons[1]
    expect(sendBtn && dismissBtn).toBeTruthy()
    if (!sendBtn || !dismissBtn) return
    await user.click(sendBtn)
    expect(onSend).toHaveBeenCalledWith('q1')
    await user.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledWith('q1')
  })
})
