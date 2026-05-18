/**
 * /memory/skills smoke — verifies:
 *   * Lists skills grouped by category from /api/skills
 *   * Filter by free-text narrows the list (local-only, no API call)
 *   * Click row → SkillDetailDialog opens + fires GET
 *     /api/skills/:slug; renders the content block
 *   * Empty bank → friendly empty-state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MemorySkillsRoute from './skills'
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/memory/skills']}>
        <Routes>
          <Route path="/memory/skills" element={<MemorySkillsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const TWO_SKILLS = {
  total: 2,
  byCategory: { fin: 1, dev: 1 },
  sources: { claude: '/root/.claude/skills', opencode: '/root/.config/opencode/skills' },
  skills: [
    {
      slug: 'fin-data-fetch', name: 'Finance data fetch',
      description: 'Pull intraday OHLC bars from common quote providers.',
      category: 'fin', agents: ['claude'],
      path: '/root/.claude/skills/fin-data-fetch/SKILL.md',
    },
    {
      slug: 'dev-git-cleanup', name: 'Git cleanup',
      description: 'Prune merged branches and orphaned worktrees.',
      category: 'dev', agents: ['claude', 'opencode'],
      path: '/root/.claude/skills/dev-git-cleanup/SKILL.md',
    },
  ],
}

describe('/memory/skills', () => {
  it('lists skills grouped by category', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(TWO_SKILLS))
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Finance data fetch')).toBeInTheDocument()
    })
    expect(screen.getByText('Git cleanup')).toBeInTheDocument()
    // Category headers
    expect(screen.getByText(/fin · 1/)).toBeInTheDocument()
    expect(screen.getByText(/dev · 1/)).toBeInTheDocument()
  })

  it('filter narrows results locally', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(TWO_SKILLS))
    renderPage()
    await waitFor(() => expect(screen.getByText('Finance data fetch')).toBeInTheDocument())
    const search = screen.getByLabelText('Search')
    fireEvent.change(search, { target: { value: 'git' } })
    await waitFor(() => {
      expect(screen.queryByText('Finance data fetch')).not.toBeInTheDocument()
      expect(screen.getByText('Git cleanup')).toBeInTheDocument()
    })
  })

  it('row click opens detail dialog + fires GET /api/skills/:slug', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/skills') return jsonResponse(TWO_SKILLS)
      if (u === '/api/skills/dev-git-cleanup') {
        return jsonResponse({
          ...TWO_SKILLS.skills[1],
          content: '# Git cleanup\n\nLong markdown body…',
        })
      }
      return jsonResponse({})
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Git cleanup')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Git cleanup'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    const dialog = screen.getByRole('dialog')
    await waitFor(() => {
      expect(within(dialog).getByText(/Long markdown body/)).toBeInTheDocument()
    })
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]) === '/api/skills/dev-git-cleanup'),
    ).toBe(true)
  })

  it('empty bank → friendly empty-state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        total: 0, byCategory: {}, skills: [],
        sources: { claude: '/c', opencode: '/o' },
      }),
    )
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('No skills installed')).toBeInTheDocument()
    })
  })
})
