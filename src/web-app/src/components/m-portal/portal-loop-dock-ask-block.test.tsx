/**
 * When ask_user / approval docks are open, PortalLoopDock must yield so
 * AskDock is not buried under Aligning / Confirm / Act Now.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { PortalLoopDock } from './portal-loop-dock'

vi.mock('./use-portal-loop', () => ({
  usePortalLoop: () => ({
    loop: {
      id: 'loop-align-1',
      active: true,
      bucket: 'aligning',
      objective: '',
      exitDescription: '',
      body: '',
      round: 1,
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

describe('PortalLoopDock yields to ask/approval docks', () => {
  it('hides Aligning when hasBlockingDock is true', () => {
    const { container } = render(
      <MemoryRouter>
        <PortalLoopDock
          threadId="t1"
          agentId="agim"
          hasBlockingDock
          onSend={() => {}}
        />
      </MemoryRouter>,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByLabelText('Loop 对焦')).toBeNull()
  })

  it('shows Aligning when no blocking dock', () => {
    render(
      <MemoryRouter>
        <PortalLoopDock
          threadId="t1"
          agentId="agim"
          hasBlockingDock={false}
          onSend={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Loop 对焦')).toBeInTheDocument()
  })
})
