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
  it('shows RUNNING… with dots (no duplicate Running · tool line) and expandable steps', async () => {
    const user = userEvent.setup()
    render(
      <PortalRunStatus
        dark
        agentName="Agim"
        agentColor="from-blue-500 to-cyan-600"
        AgentIcon={Brain}
        activity={activity()}
        streaming
      />,
    )
    expect(screen.getByRole('button', { name: /Running|执行中/i })).toBeTruthy()
    // Collapsed live view: no secondary "Running · web_search" line.
    expect(screen.queryByText(/Running · web_search|执行中 · web_search/i)).toBeNull()
    expect(screen.queryByText('web_search')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Running|执行中/i }))
    expect(screen.getByText('web_search')).toBeTruthy()
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
})
