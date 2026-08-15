/**
 * PortalRunStatus — render contract for the merged RUNNING… / Worked surface.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Brain } from 'lucide-react'

import '@/i18n'
import type { ChatActivity } from '@/hooks/use-chat'
import { PortalRunStatus } from './portal-run-status'

function activity(over: Partial<ChatActivity> = {}): ChatActivity {
  return {
    runId: 'run-1',
    status: 'running',
    startedAt: 1,
    steps: [
      {
        id: 's1',
        kind: 'tool',
        label: 'web_search',
        status: 'running',
        startedAt: 1,
      },
    ],
    ...over,
  }
}

describe('PortalRunStatus', () => {
  it('shows a collapsed think · tool line and expandable steps', async () => {
    const user = userEvent.setup()
    render(
      <PortalRunStatus
        dark
        agentName="Agim"
        agentColor="from-blue-500 to-cyan-600"
        AgentIcon={Brain}
        activity={activity({
          steps: [
            {
              id: 'r1',
              kind: 'reflect',
              label: '先确认港股代码',
              status: 'success',
              startedAt: 1,
            },
            {
              id: 's1',
              kind: 'tool',
              label: 'web_search',
              status: 'running',
              startedAt: 2,
            },
          ],
        })}
        streaming
      />,
    )
    const line = screen.getByTestId('portal-run-collapsed-line')
    expect(line.className).toMatch(/agim-shimmer/)
    expect(line.className).toMatch(/text-zinc-400/)
    expect(line.className).not.toMatch(/animate-pulse/)
    expect(line.textContent).toMatch(/先确认港股代码/)
    expect(line.textContent).toMatch(/web_search/)
    expect(screen.queryByTestId('activity-icon-reflect')).toBeNull()
    await user.click(screen.getByRole('button', { name: /先确认港股代码/ }))
    expect(screen.getByTestId('activity-icon-reflect')).toBeTruthy()
    expect(screen.getByTestId('activity-icon-tool')).toBeTruthy()
    expect(screen.getAllByText('先确认港股代码').length).toBeGreaterThan(0)
    expect(screen.queryByText(/一步一想|执行过程 ·|Execution ·|Step reflect/)).toBeNull()
    expect(screen.getAllByText('web_search').length).toBeGreaterThan(0)
  })

  it('shows expandable Worked summary when finished', async () => {
    const user = userEvent.setup()
    render(
      <PortalRunStatus
        dark
        agentName="Agim"
        agentColor="from-blue-500 to-cyan-600"
        AgentIcon={Brain}
        activity={activity({
          status: 'success',
          durationMs: 4200,
          steps: [{
            id: 's1',
            kind: 'tool',
            label: 'web_search',
            status: 'success',
            startedAt: 1,
            finishedAt: 2,
          }],
        })}
      />,
    )
    expect(screen.getByText('Agim')).toBeTruthy()
    expect(screen.getByText(/Worked|已完成/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Worked|已完成/i }))
    expect(screen.getByText('web_search')).toBeTruthy()
  })

  it('shows inline Subagent card for multiple waiting agents', async () => {
    render(
      <PortalRunStatus
        dark
        agentName="Agim"
        agentColor="from-blue-500 to-cyan-600"
        AgentIcon={Brain}
        activity={activity({
          status: 'running',
          steps: [
            {
              id: 'a2a-1',
              kind: 'agent',
              label: 'agim/cheap',
              status: 'running',
              startedAt: 1,
              jobId: 1,
            },
            {
              id: 'a2a-2',
              kind: 'agent',
              label: 'claude-code',
              status: 'running',
              startedAt: 2,
              jobId: 2,
            },
          ],
        })}
        streaming
      />,
    )
    expect(await screen.findByText(/Subagents · 2 waiting|子代理 · 等待 2 个/)).toBeTruthy()
    expect(await screen.findByText('→ agim/cheap')).toBeTruthy()
    expect(screen.getByText('→ claude-code')).toBeTruthy()
  })

  it('keeps parent reflect on the gray status line and does not render a card', async () => {
    const user = userEvent.setup()
    render(
      <PortalRunStatus
        dark
        agentName="Agim"
        agentColor="from-blue-500 to-cyan-600"
        AgentIcon={Brain}
        activity={activity({
          status: 'running',
          steps: [
            {
              id: 't-write',
              kind: 'tool',
              label: 'agim_write_file',
              status: 'success',
              startedAt: 1,
              finishedAt: 2,
            },
            {
              id: 'step-reflect-1',
              kind: 'reflect',
              label: 'Dispatch a checker for the new install URLs',
              status: 'success',
              startedAt: 3,
              finishedAt: 4,
              preview: 'Wrote install steps; links still unverified.',
            },
          ],
        })}
        streaming
      />,
    )
    expect(screen.queryByTestId('portal-step-reflect-card')).toBeNull()
    expect(screen.queryByText(/Execution · Dispatch a checker|执行过程 · Dispatch a checker|Step reflect · Dispatch a checker|一步一想 · Dispatch a checker/)).toBeNull()
    const line = screen.getByTestId('portal-run-collapsed-line')
    expect(line.textContent).toMatch(/Dispatch a checker/)
    expect(line.textContent).toMatch(/write_file/)
    expect(screen.queryByText('agim_write_file')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Dispatch a checker/ }))
    expect(screen.getByTestId('activity-icon-reflect')).toBeTruthy()
    expect(screen.getByText('Dispatch a checker for the new install URLs')).toBeTruthy()
    expect(screen.getByText('Wrote install steps; links still unverified.')).toBeTruthy()
    expect(screen.queryByText(/一步一想|执行过程 ·|Execution ·|Step reflect/)).toBeNull()
  })
})
