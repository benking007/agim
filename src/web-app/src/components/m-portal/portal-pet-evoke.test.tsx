/**
 * PortalPet — task rows are activatable so the user can evoke a run in chat.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalPet, type PetTaskItem } from './portal-pet'
import '@/i18n'

describe('PortalPet task evoke', () => {
  it('calls onTaskActivate when a run row is clicked', async () => {
    const user = userEvent.setup()
    const onTaskActivate = vi.fn()
    const tasks: PetTaskItem[] = [{
      id: 'run-1',
      kind: 'run',
      label: 'Agim',
      detail: 'Running',
      runId: 'run-abc',
      messageId: 'msg-1',
    }]
    render(
      <PortalPet
        dark={false}
        busy
        tasks={tasks}
        onTaskActivate={onTaskActivate}
      />,
    )
    await user.click(screen.getByLabelText(/Agim pet|Agim 电子宠物/i))
    const dialog = await screen.findByRole('dialog')
    const taskBtn = within(dialog).getByRole('button', { name: /Agim/i })
    await user.click(taskBtn)
    expect(onTaskActivate).toHaveBeenCalledTimes(1)
    expect(onTaskActivate.mock.calls[0]?.[0]).toMatchObject({
      kind: 'run',
      runId: 'run-abc',
      messageId: 'msg-1',
    })
  })
})
