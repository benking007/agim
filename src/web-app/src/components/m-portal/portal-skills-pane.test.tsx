import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import '@/i18n'

vi.mock('@/hooks/use-agim-skills', () => ({
  useAgimSkillsList: () => ({
    isLoading: false,
    data: {
      skills: [
        { name: 'demo', description: 'A demo skill', source: 'builtin', enabled: true },
        { name: 'mine', description: 'My skill', source: 'user', enabled: false },
      ],
    },
  }),
  useAgimSkillSetEnabled: () => ({
    isPending: false,
    variables: null,
    mutate: vi.fn(),
  }),
  useAgimSkill: (name: string | null) => ({
    isLoading: false,
    isError: false,
    data: name === 'demo'
      ? {
          meta: { name: 'demo', description: 'A demo skill', source: 'builtin' },
          body: '# Demo skill\n\nHello body.',
        }
      : undefined,
  }),
}))

import { PortalSkillsPane } from './portal-skills-pane'

describe('PortalSkillsPane', () => {
  it('lists skills with switches', () => {
    render(<PortalSkillsPane dark={false} />)
    expect(screen.getByTestId('portal-skills-pane')).toBeInTheDocument()
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.getByText('mine')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'On' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Off' })).not.toBeChecked()
  })

  it('opens a read-only preview when a skill name is clicked', async () => {
    const user = userEvent.setup()
    render(<PortalSkillsPane dark={false} />)
    await user.click(screen.getByTestId('portal-skill-demo'))
    expect(screen.getByTestId('portal-skill-preview')).toBeInTheDocument()
    expect(screen.getByText('Read-only preview · Built-in')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Demo skill' })).toBeInTheDocument()
    expect(screen.getByText('Hello body.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('does not open the preview when the enable switch is clicked', async () => {
    const user = userEvent.setup()
    render(<PortalSkillsPane dark={false} />)
    await user.click(screen.getByRole('switch', { name: 'On' }))
    expect(screen.queryByTestId('portal-skill-preview')).not.toBeInTheDocument()
  })
})
