import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

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
})
