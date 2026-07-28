/**
 * Subagent detail sheet — Result pane must render GFM Markdown
 * (headings / tables / bold), not dump raw `#` / `|` / `**`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SubagentDetailDialog } from './subagent-detail-dialog'
import type { ChatActivityStep } from '@/hooks/use-chat'

const markdownResult = [
  '# ETF 国家队监控系统',
  '',
  '## 一、核心面板指标',
  '',
  '**国家队今天有没有逆市护盘？**',
  '',
  '| 原名称 | 降维名称 |',
  '|--------|----------|',
  '| 量比 | **放量力度** |',
].join('\n')

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getJob: vi.fn(async () => ({
      job: {
        id: 2462,
        status: 'done',
        prompt: 'Parent brief here',
        result: markdownResult,
        agent: 'agim',
      },
    })),
  },
}))

describe('SubagentDetailDialog result Markdown', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div data-agim-composer-sheet-root></div>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('renders Result as Markdown (heading + bold + table), not raw markers', async () => {
    const step: ChatActivityStep = {
      id: 'sa-1',
      kind: 'subagent',
      label: 'agim:deepseek-v4-pro',
      status: 'done',
      jobId: 2462,
      startedAt: Date.now(),
    }

    render(
      <SubagentDetailDialog
        open
        onOpenChange={() => {}}
        step={step}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('subagent-result-markdown')).toBeInTheDocument()
    })

    const box = screen.getByTestId('subagent-result-markdown')
    expect(box.querySelector('table')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /ETF 国家队监控系统/ })).toBeInTheDocument()
    expect(screen.getByText('国家队今天有没有逆市护盘？').tagName.toLowerCase()).toBe('strong')
    expect(screen.getByText('放量力度').tagName.toLowerCase()).toBe('strong')
    // Raw markdown markers should not appear as visible text blobs
    expect(screen.queryByText(/^# ETF/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\|\s*原名称\s*\|/)).not.toBeInTheDocument()
  })
})
