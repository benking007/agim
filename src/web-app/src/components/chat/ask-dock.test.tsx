/**
 * AskDock — verify the choice card renders its choices and the optional
 * "details" links as real anchors (the agent-supplied "查看详情" entry).
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AskDock } from './ask-dock'
import '@/i18n'
import type { PendingAsk } from '@/hooks/use-chat'
import type { ChoiceCardPrompt } from '@/types/ws'

function ask(promptOver: Partial<ChoiceCardPrompt> = {}): PendingAsk {
  return {
    messageId: 'm1',
    prompt: {
      title: 'agim',
      body: 'pick one',
      choices: [
        { label: '1. a', data: 'ask:r:1' },
        { label: '2. b', data: 'ask:r:2' },
      ],
      meta: {
        kind: 'ask-user',
        reqId: 'r',
        selectionMode: 'single',
        minSelections: 1,
        maxSelections: 1,
        allowCustomInput: false,
        customInputLabel: '',
        timeoutSec: 90,
      },
      ...promptOver,
    },
  }
}

describe('AskDock', () => {
  it('renders nothing when there are no pending asks', () => {
    const { container } = render(<AskDock asks={[]} onSubmit={() => true} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the choice buttons', () => {
    render(<AskDock asks={[ask()]} onSubmit={() => true} />)
    expect(screen.getByText('1. a')).toBeInTheDocument()
    expect(screen.getByText('2. b')).toBeInTheDocument()
  })

  it('renders details links as target=_blank anchors', () => {
    const a = ask({ links: [{ label: '📖 查看详情', url: 'https://example.com/v/x' }] })
    render(<AskDock asks={[a]} onSubmit={() => true} />)
    const link = screen.getByText('📖 查看详情') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://example.com/v/x')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('omits the links row when no links are present', () => {
    render(<AskDock asks={[ask()]} onSubmit={() => true} />)
    expect(screen.queryByText('📖 查看详情')).toBeNull()
  })

  it('wraps long single-select labels with multi-line button classes', () => {
    const long =
      '继续推进本轮：先核对子代理交付物，再对照退出条件给出 verdict，必要时补充一次 ask'
    render(
      <AskDock
        asks={[ask({
          choices: [
            { label: `1. ${long}`, data: 'ask:r:1' },
            { label: '2. 暂停', data: 'ask:r:2' },
          ],
        })]}
        onSubmit={() => true}
      />,
    )
    const btn = screen.getByRole('button', { name: new RegExp(long.slice(0, 12)) })
    expect(btn.className).toMatch(/whitespace-normal/)
    expect(btn.className).toMatch(/break-words/)
    expect(btn.className).toMatch(/h-auto/)
  })
})
