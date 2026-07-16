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
  it('shows RUNNING… with live tool status and expandable steps', async () => {
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
    expect(screen.getAllByText(/Running|执行中/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/web_search/i).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: /Running|执行中/i }))
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
})
