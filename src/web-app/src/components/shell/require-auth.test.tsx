import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import { useAuth } from '@/stores/auth'
import { RequireAuth } from './require-auth'

afterEach(() => {
  useAuth.setState({
    token: null,
    user: null,
    role: null,
    signedIn: false,
    ready: false,
    hasUsers: null,
  })
})

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/m/chat"
          element={(
            <RequireAuth>
              <div>portal-ok</div>
            </RequireAuth>
          )}
        />
        <Route path="/register" element={<div>register-ok</div>} />
        <Route path="/login" element={<div>login-ok</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  it('waits while hydrate is in flight', () => {
    useAuth.setState({ signedIn: false, ready: false, hasUsers: null })
    renderAt('/m/chat')
    expect(screen.queryByText('portal-ok')).not.toBeInTheDocument()
    expect(screen.queryByText('register-ok')).not.toBeInTheDocument()
  })

  it('lets auth-off through', () => {
    useAuth.setState({ signedIn: true, ready: true, hasUsers: false, role: 'admin' })
    renderAt('/m/chat')
    expect(screen.getByText('portal-ok')).toBeInTheDocument()
  })

  it('sends unsigned visitors to register when the machine has no users', () => {
    useAuth.setState({ signedIn: false, ready: true, hasUsers: false })
    renderAt('/m/chat')
    expect(screen.getByText('register-ok')).toBeInTheDocument()
  })
})
