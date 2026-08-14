import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import '@/i18n'
import { ChatJumpToLatest } from './chat-jump-to-latest'

describe('ChatJumpToLatest', () => {
  it('renders nothing when following the bottom', () => {
    const { container } = render(
      <ChatJumpToLatest show={false} onJump={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('jumps to the latest message when clicked', async () => {
    const user = userEvent.setup()
    const onJump = vi.fn()
    render(<ChatJumpToLatest show onJump={onJump} />)
    await user.click(screen.getByTestId('chat-jump-to-latest'))
    expect(onJump).toHaveBeenCalledTimes(1)
  })
})
