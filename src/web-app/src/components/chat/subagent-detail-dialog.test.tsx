/**
 * Subagent detail sheet — Parent prompt + Result panes render GFM Markdown
 * (headings / tables / bold), not dump raw `#` / `|` / `**`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SubagentDetailDialog } from './subagent-detail-dialog'
import type { ChatActivityStep } from '@/hooks/use-chat'

const markdownPrompt = [
  '## 用户推荐的数据源',
  '',
  '请核对 **NDX 成分/权重** 与 `quality=B`。',
  '',
  '| 因子 | 权重 | 质量 |',
  '|------|------|------|',
  '| F1 估值 | 60% | B |',
].join('\n')

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
        prompt: markdownPrompt,
        result: markdownResult,
        agent: 'agim',
      },
    })),
  },
}))

describe('SubagentDetailDialog Markdown', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div data-agim-composer-sheet-root></div>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('renders Parent prompt as Markdown (heading + bold + table)', async () => {
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
      expect(screen.getByTestId('subagent-prompt-markdown')).toBeInTheDocument()
    })

    const box = screen.getByTestId('subagent-prompt-markdown')
    expect(box.querySelector('table')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /用户推荐的数据源/ })).toBeInTheDocument()
    expect(screen.getByText('NDX 成分/权重').tagName.toLowerCase()).toBe('strong')
    expect(screen.queryByText(/^## 用户推荐/)).not.toBeInTheDocument()
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
    expect(screen.queryByText(/^# ETF/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\|\s*原名称\s*\|/)).not.toBeInTheDocument()
  })
})
