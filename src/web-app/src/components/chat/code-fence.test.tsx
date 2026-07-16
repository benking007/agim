/**
 * CodeFence — highlight + copy contract.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CodeFence } from './code-fence'

describe('CodeFence', () => {
  it('syntax-highlights python fences with hljs token spans', async () => {
    render(
      <CodeFence className="language-python">
        {'def hello(n):\n    return n + 1\n'}
      </CodeFence>,
    )
    expect(screen.getByText('python')).toBeTruthy()
    await waitFor(() => {
      const code = document.querySelector('code.hljs')
      expect(code).toBeTruthy()
      expect(code?.querySelector('.hljs-keyword')).toBeTruthy()
    })
  })

  it('falls back to auto-highlight when language is omitted', async () => {
    render(
      <CodeFence>
        {'const x = 1;\nfunction f() { return x; }\n'}
      </CodeFence>,
    )
    await waitFor(() => {
      const code = document.querySelector('code.hljs')
      expect(code).toBeTruthy()
      expect(code?.innerHTML.length).toBeGreaterThan(10)
    })
  })
})
