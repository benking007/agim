/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerPointsChip } from './composer-points-chip'
import { useAuth } from '@/stores/auth'
import type { MePointsResponse } from '@/types/api'

const getMePoints = vi.fn(async (): Promise<MePointsResponse> => ({
  balance: {
    userId: 'usr_bob',
    monthlyLimit: 100_000,
    bonus: 0,
    usedThisPeriod: 250,
    remaining: 8750,
    periodStart: 1,
    pointsPerUsd: 10_000,
    unlimited: false,
  },
  ledger: [
    {
      id: 'pt_1',
      userId: 'usr_bob',
      delta: -40,
      reason: 'agim_turn',
      model: 'deepseek-v4-flash',
      at: Date.parse('2026-08-25T01:00:00.000Z'),
    },
  ],
  daily: [
    { day: '2026-08-24', spent: 40 },
    { day: '2026-08-25', spent: 15 },
  ],
}))

vi.mock('@/lib/api/endpoints', () => ({
  api: {
    getMePoints: () => getMePoints(),
  },
}))

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('ComposerPointsChip', () => {
  beforeEach(() => {
    getMePoints.mockClear()
    useAuth.setState({
      token: null,
      user: null,
      role: null,
      signedIn: false,
      ready: true,
      hasUsers: true,
    })
  })

  it('hides for loopback / unsigned visitors', () => {
    const { container } = render(
      <ComposerPointsChip chipClassName="chip" />,
      { wrapper },
    )
    expect(container).toBeEmptyDOMElement()
    expect(getMePoints).not.toHaveBeenCalled()
  })

  it('hides for web: identities', () => {
    useAuth.setState({
      user: { id: 'web:loopback', username: 'web', displayName: 'web', role: 'user' },
      role: 'user',
      signedIn: true,
      ready: true,
    })
    const { container } = render(
      <ComposerPointsChip chipClassName="chip" />,
      { wrapper },
    )
    expect(container).toBeEmptyDOMElement()
    expect(getMePoints).not.toHaveBeenCalled()
  })

  it('shows remaining points and opens the spend sheet', async () => {
    useAuth.setState({
      user: { id: 'usr_bob', username: 'bob', displayName: 'bob', role: 'user' },
      role: 'user',
      signedIn: true,
      ready: true,
    })
    const user = userEvent.setup()
    render(<ComposerPointsChip chipClassName="chip" />, { wrapper })
    const btn = await screen.findByRole('button', { name: /remaining points/i })
    expect(await screen.findByText('8750')).toBeInTheDocument()
    await user.click(btn)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Points')).toBeInTheDocument()
    expect(screen.getByText(/250 used \/ 100k/i)).toBeInTheDocument()
    expect(screen.getByText('Last 14 days')).toBeInTheDocument()
    expect(document.querySelector('svg')).toBeTruthy()
    expect(screen.getByText(/Agent turn/)).toBeInTheDocument()
  })
})
