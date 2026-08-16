/**
 * InjectedContextDetails — nested accordion for prompt-injection dumps.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { InjectedContextDetails } from './injected-context-details'

describe('InjectedContextDetails', () => {
  it('renders nothing for empty text', () => {
    const { container } = render(<InjectedContextDetails text="   " />)
    expect(container.firstChild).toBeNull()
  })

  it('expands to a scrollable full dump', () => {
    const body = [
      '## System prompt',
      'You are agim.',
      '',
      '## Ephemeral context (this turn)',
      'Focus: ship v2',
    ].join('\n')
    render(<InjectedContextDetails text={body} />)
    expect(screen.getByRole('button')).toHaveTextContent(/Injected context|注入内容/)
    expect(screen.queryByTestId('injected-context-body')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    const pre = screen.getByTestId('injected-context-body')
    expect(pre.textContent).toContain('System prompt')
    expect(pre.textContent).toContain('Focus: ship v2')
    expect(pre.className).toMatch(/overflow-auto/)
  })
})
