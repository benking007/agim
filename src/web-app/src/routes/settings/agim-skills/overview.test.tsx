import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import AgimSkillsOverviewRoute from './overview'
import '@/i18n'

beforeEach(() => {
  localStorage.setItem('agim_token', 'tok')
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderPage(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/settings/agim-skills']}>
        <Routes>
          <Route path="/settings/agim-skills" element={<AgimSkillsOverviewRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockFetch(opts: {
  unavailable?: boolean
  workspaceSkills?: number
  hotSkills?: number
  overrideActive?: boolean
} = {}) {
  const workspaceSkills = opts.workspaceSkills ?? 1
  const hotSkills = opts.hotSkills ?? 2
  const skills = [
    {
      name: 'agim-core',
      description: 'Core helpers',
      source: 'builtin',
      always: true,
      available: true,
      requiresBins: [],
      requiresEnv: [],
      dir: '/builtin/agim-core',
      bucket: 0,
    },
    ...Array.from({ length: workspaceSkills }, (_, idx) => ({
      name: `workspace-${idx + 1}`,
      description: 'Business helper',
      source: 'workspace',
      always: false,
      available: !(opts.unavailable && idx === 0),
      unavailableReason: opts.unavailable && idx === 0 ? 'missing cli' : undefined,
      requiresBins: opts.unavailable && idx === 0 ? ['missing-cli'] : [],
      requiresEnv: [],
      dir: `/workspace/skill-${idx + 1}`,
      bucket: 3,
    })),
  ]

  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const u = String(input)
    if (u === '/api/agim-skills') {
      return jsonResponse({
        skills,
        count: skills.length,
        maxBodyChars: 32_000,
      })
    }
    if (u === '/api/skills/remote/hot') {
      return jsonResponse({
        skills: Array.from({ length: hotSkills }, (_, idx) => ({
          slug: `hot-${idx + 1}`,
          name: `Hot ${idx + 1}`,
          description: 'Remote skill',
        })),
        cached: false,
        fetchedAt: Date.UTC(2026, 6, 1, 8, 0, 0),
      })
    }
    if (u === '/api/agim-skills/injection') {
      return jsonResponse({
        auto: 'auto',
        autoChars: 4,
        override: opts.overrideActive ? 'override-body' : null,
        overrideChars: opts.overrideActive ? 13 : 0,
        overridePath: '/Users/a/.agim/skill-injection-override.md',
        overrideActive: Boolean(opts.overrideActive),
        maxOverrideChars: 40_000,
      })
    }
    return jsonResponse({})
  })
}

describe('/settings/agim-skills overview', () => {
  it('summarizes installed skills, hot skills, and injection state', async () => {
    mockFetch()
    renderPage()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Skills overview' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('1 workspace · 1 builtin')).toBeInTheDocument())
    expect(screen.getByText('Skill dependencies are ready')).toBeInTheDocument()
    expect(screen.getByText('2 available to browse')).toBeInTheDocument()
    expect(screen.getByText('1 always-on · 4 chars summary')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Review installed skills/i })).toHaveAttribute('href', '/settings/agim-skills/installed')
  })

  it('prioritizes unavailable skills before discovery or injection tuning', async () => {
    mockFetch({ unavailable: true, overrideActive: true })
    renderPage()

    await waitFor(() => expect(screen.getByText('1 needs attention')).toBeInTheDocument())
    expect(screen.getByText('1 skill(s) missing dependencies')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Fix unavailable skills first/i })).toHaveAttribute('href', '/settings/agim-skills/installed')
  })

  it('routes an empty workspace toward the hot skill list when discovery is available', async () => {
    mockFetch({ workspaceSkills: 0, hotSkills: 3 })
    renderPage()

    await waitFor(() => expect(screen.getByText('0 workspace · 1 builtin')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Pick a hot skill to try/i })).toHaveAttribute('href', '/settings/agim-skills/hot')
  })
})
