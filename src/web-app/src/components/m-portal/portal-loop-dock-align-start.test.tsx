/**
 * Align 「确定并开始」 must queue an Act Now follow-up so Loop leaves
 * planning without a second click.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { PortalLoopDock } from './portal-loop-dock'
import { buildAlignStartFollowUp } from './portal-loop-align-payload'

vi.mock('./use-portal-loop', () => ({
  usePortalLoop: () => ({
    loop: {
      id: 'loop-align-1',
      active: true,
      bucket: 'aligning',
      objective: '[文件附件：/tmp/req.md (req.md, 1 KB)]',
      exitDescription: '根据2.0升级，至少进行3轮验证',
      body: '用 Cursor 落地',
      round: 0,
      maxRounds: 12,
      usage: { dispatchCount: 0 },
    },
    reload: vi.fn(),
    loading: false,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'zh' },
  }),
}))

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({ send: vi.fn() }),
}))

describe('PortalLoopDock Align confirm-and-start', () => {
  it('sends /loop payload and queues afterIdle Act Now nudge', () => {
    const onSend = vi.fn()
    render(
      <MemoryRouter>
        <PortalLoopDock
          threadId="t1"
          agentId="agim"
          hasBlockingDock={false}
          onSend={onSend}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: '确定并开始' }))

    expect(onSend).toHaveBeenCalledTimes(1)
    const [payload, opts] = onSend.mock.calls[0]!
    expect(payload).toContain('/loop [文件附件：/tmp/req.md')
    expect(payload).toContain('；退出条件为根据2.0升级，至少进行3轮验证')
    expect(payload).toContain('；正文：用 Cursor 落地')
    expect(opts).toEqual({
      afterIdle: buildAlignStartFollowUp({ zh: true }),
    })
  })
})
