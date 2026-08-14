import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatComposer } from './chat-composer'
import '@/i18n'

describe('ChatComposer Enter semantics', () => {
  it('submits on Enter in desktop mode', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <ChatComposer value="hello" onChange={() => {}} onSubmit={onSubmit} />,
    )
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('inserts newline on Ctrl+Enter instead of submitting', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    render(
      <ChatComposer value="hello" onChange={onChange} onSubmit={onSubmit} />,
    )
    const ta = screen.getByRole('textbox')
    await user.type(ta, '{Control>}{Enter}{/Control}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits while busy when allowBusySubmit is set', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <ChatComposer
        value="also run tests"
        onChange={() => {}}
        onSubmit={onSubmit}
        busy
        allowBusySubmit
      />,
    )
    await user.click(screen.getByRole('button', { name: /send/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit on Enter when enterNewline (phone)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <ChatComposer
        value="hello"
        onChange={() => {}}
        onSubmit={onSubmit}
        enterNewline
      />,
    )
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
