import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import TasksLayout from './layout'
import '@/i18n'

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tasks" element={<TasksLayout />}>
          <Route index element={<div data-testid="tasks-child">overview</div>} />
          <Route path="*" element={<div data-testid="tasks-child">child</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('/tasks layout', () => {
  it('shows task view links without exposing group labels', () => {
    renderAt('/tasks')

    expect(screen.queryByText('Start')).not.toBeInTheDocument()
    expect(screen.queryByText('Work')).not.toBeInTheDocument()
    expect(screen.queryByText('Automation')).not.toBeInTheDocument()
    expect(screen.queryByText('Review')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/tasks')
    expect(screen.getByRole('link', { name: 'Outbox' })).toHaveAttribute('href', '/tasks/outbox')
    expect(screen.getByRole('link', { name: 'Ask User' })).toHaveAttribute('href', '/tasks/asks')
    expect(screen.getByTestId('tasks-child')).toBeInTheDocument()
  })

  it('marks nested routes active in the grouped navigation', () => {
    renderAt('/tasks/a2a')

    const a2a = screen.getByRole('link', { name: 'Agent ↔ Agent' })
    expect(a2a.className).toContain('text-accent')
    expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('text-accent')
  })
})
