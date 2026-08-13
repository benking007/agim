/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeferredMarkdownView } from './deferred-markdown-view'

describe('DeferredMarkdownView', () => {
  it('eager small content parses markdown immediately', async () => {
    render(
      <DeferredMarkdownView
        eager
        content={'## Hello\n\nThis is **bold**.'}
      />,
    )
    expect(await screen.findByRole('heading')).toHaveTextContent('Hello')
    expect(screen.queryByTestId('deferred-md-plain')).toBeNull()
  })

  it('non-eager content stays plaintext until observed', () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      takeRecords = vi.fn()
      root = null
      rootMargin = ''
      thresholds: number[] = []
      callback: IntersectionObserverCallback
      constructor(cb: IntersectionObserverCallback) { this.callback = cb }
    })
    render(<DeferredMarkdownView content={'## Hidden\n\nnot yet'} />)
    expect(screen.getByTestId('deferred-md-plain')).toHaveTextContent('## Hidden')
    expect(screen.queryByRole('heading')).toBeNull()
    vi.unstubAllGlobals()
  })
})
