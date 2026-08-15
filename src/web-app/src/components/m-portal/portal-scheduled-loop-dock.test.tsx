import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./use-portal-scheduled-loop', () => ({
  usePortalScheduledLoop: () => ({
    pending: {
      cron: '0 2 * * *',
      cronLabel: '每天 02:00',
      timeText: '每天凌晨2点',
      objective: '修登录',
      exitDescription: '验收通过或最多5轮',
      headless: false,
      createdAt: 1,
    },
    busy: false,
    error: null,
    confirm: vi.fn(),
    cancel: vi.fn(),
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'zh' },
  }),
}))

import { PortalScheduledLoopDock } from './portal-scheduled-loop-dock'

describe('PortalScheduledLoopDock', () => {
  it('renders time / objective / exit and a Create button', () => {
    render(<PortalScheduledLoopDock threadId="t1" />)
    expect(screen.getByTestId('scheduled-loop-dock')).toBeInTheDocument()
    expect(screen.getByDisplayValue('每天凌晨2点')).toBeInTheDocument()
    expect(screen.getByDisplayValue('修登录')).toBeInTheDocument()
    expect(screen.getByDisplayValue('验收通过或最多5轮')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled()
  })
})
