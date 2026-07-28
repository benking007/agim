/**
 * ConfirmMetDock — conclusion summary must render Markdown (GFM tables /
 * bold / code) and scroll when long, instead of dumping raw **pipes**.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { CONFIRM_MET_SUMMARY_MAX_CLASS, PortalLoopDock } from './portal-loop-dock'

const reload = vi.fn()

vi.mock('./use-portal-loop', () => ({
  usePortalLoop: () => ({
    loop: {
      id: 'loop-confirm-1',
      active: true,
      bucket: 'confirm',
      round: 2,
      maxRounds: 12,
      pendingConfirmation: {
        summary: [
          '第二轮 codex 已完成并部署红K短波策略。',
          '',
          '**交付清单：**',
          '',
          '| 文件 | 用途 |',
          '|------|------|',
          '| `strategies/redk/weekly_pick_and_buy.py` | 周选股 |',
          '| `strategies/redk/sim_extend.py` | **模拟盘扩展** |',
          '',
          '详见上文表格。',
        ].join('\n'),
        gaps: [],
      },
      usage: { dispatchCount: 3 },
    },
    reload,
    loading: false,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@/lib/api/loop', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/loop')>('@/lib/api/loop')
  return {
    ...actual,
    confirmLoopMet: vi.fn(),
  }
})

vi.mock('@/lib/api/ws', () => ({
  openChatWs: () => ({ send: vi.fn() }),
}))

describe('PortalLoopDock confirm-met summary', () => {
  beforeEach(() => {
    reload.mockReset()
  })

  it('renders Markdown (bold + table + code) and keeps a scroll cap', () => {
    render(
      <MemoryRouter>
        <PortalLoopDock
          threadId="t1"
          agentId="agim"
          onSend={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('Conclusion ready — confirm')).toBeInTheDocument()

    const box = screen.getByTestId('loop-confirm-summary')
    expect(box.className).toMatch(/overflow-y-auto/)
    expect(box.className).toContain(CONFIRM_MET_SUMMARY_MAX_CLASS)

    // Bold headings become strong, not raw **markers**
    expect(screen.getByText('交付清单：')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*交付清单：\*\*/)).not.toBeInTheDocument()

    // GFM table
    expect(box.querySelector('table')).toBeTruthy()
    expect(screen.getByText('文件')).toBeInTheDocument()
    expect(screen.getByText('用途')).toBeInTheDocument()

    // Inline code
    expect(box.querySelector('code')).toBeTruthy()
    expect(screen.getByText('strategies/redk/weekly_pick_and_buy.py')).toBeInTheDocument()

    // Nested bold in table cell
    expect(screen.getByText('模拟盘扩展')).toBeInTheDocument()
  })
})
