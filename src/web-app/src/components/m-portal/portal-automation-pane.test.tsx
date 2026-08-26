import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import '@/i18n'

const updateMutate = vi.fn()

vi.mock('@/hooks/use-schedules', () => ({
  useSchedules: () => ({
    isLoading: false,
    data: {
      schedules: [
        {
          id: 7,
          name: 'gold-daily',
          agent: 'agim',
          cron: '30 9 * * *',
          enabled: 1,
          prompt: '<!-- agim:schedule {"model":"deepseek-v4-pro","artifacts":"PROJECTS/gold-daily"} -->\n写日报',
        },
      ],
    },
  }),
  useUpdateSchedule: () => ({ isPending: false, mutate: updateMutate }),
  useDeleteSchedule: () => ({ mutate: vi.fn() }),
  useCreateSchedule: () => ({ isPending: false, mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-jobs', () => ({
  useJobs: () => ({
    isLoading: false,
    data: {
      jobs: [
        {
          id: 99,
          agent: 'agim',
          status: 'completed',
          prompt: '<!-- agim:schedule {"artifacts":"PROJECTS/gold-daily"} -->\n写日报',
          result: 'done',
        },
      ],
    },
  }),
}))

vi.mock('@/hooks/use-workspace', () => ({
  useAgentsStatus: () => ({ data: { agim: true } }),
}))

vi.mock('@/hooks/use-llm-admin', () => ({
  useLlmList: () => ({ data: { backends: [{ name: 'deepseek-v4-pro' }] } }),
}))

import { PortalAutomationPane } from './portal-automation-pane'

describe('PortalAutomationPane', () => {
  it('lists a schedule with its artifacts path', () => {
    render(<PortalAutomationPane dark={false} defaultAgent="agim" />)
    expect(screen.getByTestId('portal-automation-pane')).toBeInTheDocument()
    expect(screen.getByText('gold-daily')).toBeInTheDocument()
    expect(screen.getByText(/PROJECTS\/gold-daily/)).toBeInTheDocument()
  })

  it('shows artifacts on the run history tab', async () => {
    const user = userEvent.setup()
    render(<PortalAutomationPane dark={false} defaultAgent="agim" />)
    await user.click(screen.getByRole('button', { name: 'Run history' }))
    expect(screen.getByTestId('portal-schedule-run-99')).toBeInTheDocument()
    expect(screen.getByText(/PROJECTS\/gold-daily/)).toBeInTheDocument()
  })

  it('opens the editor with existing fields and saves a PATCH', async () => {
    const user = userEvent.setup()
    updateMutate.mockReset()
    render(<PortalAutomationPane dark={false} defaultAgent="agim" />)
    await user.click(screen.getByTestId('portal-schedule-edit-7'))
    expect(screen.getByRole('heading', { name: 'Edit scheduled task' })).toBeInTheDocument()
    const nameInput = screen.getByDisplayValue('gold-daily')
    await user.clear(nameInput)
    await user.type(nameInput, 'gold-evening')
    const prompt = screen.getByDisplayValue('写日报')
    await user.clear(prompt)
    await user.type(prompt, '写晚报')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(updateMutate).toHaveBeenCalledTimes(1)
    const arg = updateMutate.mock.calls[0]?.[0] as {
      id: number
      body: { name: string; agent: string; cron: string; prompt: string }
    }
    expect(arg.id).toBe(7)
    expect(arg.body.name).toBe('gold-evening')
    expect(arg.body.agent).toBe('agim')
    expect(arg.body.cron).toBe('30 9 * * *')
    expect(arg.body.prompt).toContain('写晚报')
    expect(arg.body.prompt).toContain('deepseek-v4-pro')
    expect(arg.body.prompt).toContain('PROJECTS/gold-daily')
  })
})
