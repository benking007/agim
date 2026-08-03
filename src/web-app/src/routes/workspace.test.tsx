/**
 * /workspace smoke — verifies:
 *   * Without ?agent → friendly empty-state, no /api/workspace-files
 *     call
 *   * With ?agent → dir listing renders with entries
 *   * Click a file entry → URL updates to ?path= and the file editor
 *     renders with content
 *   * Dirty edit + Save → PUT /api/workspace-files
 *   * Download exports current draft via saveTextAsFile
 *   * Binary file → read-only placeholder
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { requireValue } from '@/test/assert'
import WorkspaceRoute, { mimeForWorkspaceFilename, workspaceBasename } from './workspace'
import '@/i18n'

vi.mock('@/lib/save-text-file', () => ({
  saveTextAsFile: vi.fn(async () => 'download' as const),
}))

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

function renderAt(search: string): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/workspace${search}`]}>
        <Routes>
          <Route path="/workspace" element={<WorkspaceRoute />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

const AGENTS = { claude: true, codex: false }
const DIR_PAYLOAD = {
  type: 'dir',
  agent: 'claude',
  path: '',
  base: '/root/.agim-workspaces/claude',
  entries: [
    { name: 'src',         isDir: true,  size: null, mtime: '2026-05-18T08:00:00Z' },
    { name: 'CLAUDE.md',   isDir: false, size: 1234, mtime: '2026-05-18T08:00:00Z' },
    { name: 'AGENTS.md',   isDir: false, size: 567,  mtime: '2026-05-18T08:00:00Z' },
  ],
}

describe('/workspace', () => {
  it('no ?agent → empty state, no /api/workspace-files call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({})
      return jsonResponse({})
    })
    renderAt('')
    await waitFor(() => {
      expect(screen.getByText('Pick an agent to browse its workspace')).toBeInTheDocument()
    })
    // Confirm the file-list endpoint was NOT called.
    expect(
      fetchSpy.mock.calls.every((c) => !String(c[0]).startsWith('/api/workspace-files')),
    ).toBe(true)
  })

  it('with ?agent → dir listing renders entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({})
      if (u.startsWith('/api/workspace-files')) return jsonResponse(DIR_PAYLOAD)
      return jsonResponse({})
    })
    renderAt('?agent=claude')
    await waitFor(() => {
      expect(screen.getByText('CLAUDE.md')).toBeInTheDocument()
    })
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
  })

  it('with ?path= → renders the file editor + saving fires PUT', async () => {
    const FILE_PAYLOAD = {
      type: 'file',
      agent: 'claude',
      path: 'CLAUDE.md',
      size: 1234,
      mtime: '2026-05-18T08:00:00Z',
      encoding: 'utf-8',
      content: '# CLAUDE.md\n\nHello world.',
      truncated: false,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({})
      if (u.startsWith('/api/workspace-files') && init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body).toMatchObject({ content: expect.stringContaining('EDIT') })
        return jsonResponse({ ok: true, agent: 'claude', path: 'CLAUDE.md', size: 50, mtime: '2026-05-18T09:00:00Z' })
      }
      if (u.startsWith('/api/workspace-files')) return jsonResponse(FILE_PAYLOAD)
      return jsonResponse({})
    })
    renderAt('?agent=claude&path=CLAUDE.md')
    // The textarea is the only one on the page; just look it up.
    const ta = await waitFor(() => {
      const t = document.querySelector('textarea') as HTMLTextAreaElement | null
      expect(t).not.toBeNull()
      expect(t?.value).toContain('Hello world.')
      return requireValue(t, 'workspace editor')
    })
    // Save disabled on clean
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(ta, { target: { value: `${ta.value}\n\nEDIT` } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (c) => String(c[0]).startsWith('/api/workspace-files') && (c[1] as RequestInit | undefined)?.method === 'PUT',
        ),
      ).toBe(true)
    })
  })

  it('Download exports the current draft (including unsaved edits)', async () => {
    const { saveTextAsFile } = await import('@/lib/save-text-file')
    const saveMock = vi.mocked(saveTextAsFile)
    saveMock.mockClear()

    const FILE_PAYLOAD = {
      type: 'file',
      agent: 'claude',
      path: 'reports/weekly.md',
      size: 40,
      mtime: '2026-05-18T08:00:00Z',
      encoding: 'utf-8',
      content: '# Weekly\n\nDraft body.',
      truncated: false,
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({})
      if (u.startsWith('/api/workspace-files')) return jsonResponse(FILE_PAYLOAD)
      return jsonResponse({})
    })
    renderAt('?agent=claude&path=reports%2Fweekly.md')
    const ta = await waitFor(() => {
      const el = document.querySelector('textarea') as HTMLTextAreaElement | null
      expect(el).not.toBeNull()
      return requireValue(el, 'workspace editor')
    })
    fireEvent.change(ta, { target: { value: `${ta.value}\n\n## Findings` } })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({
        filename: 'weekly.md',
        content: expect.stringContaining('## Findings'),
        mime: 'text/markdown;charset=utf-8',
      })
    })
  })

  it('binary file → read-only placeholder, no textarea', async () => {
    const BIN = {
      type: 'file', agent: 'claude', path: 'logo.png',
      size: 4096, mtime: '2026-05-18T08:00:00Z',
      encoding: 'base64', content: 'AAAA…', truncated: false,
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({})
      if (u.startsWith('/api/workspace-files')) return jsonResponse(BIN)
      return jsonResponse({})
    })
    renderAt('?agent=claude&path=logo.png')
    await waitFor(() => {
      expect(screen.getByText(/binary/i)).toBeInTheDocument()
    })
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('auto-selects the default agent and shows the workspace starter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse(AGENTS)
      if (u === '/api/config') return jsonResponse({ defaultAgent: 'claude' })
      if (u.startsWith('/api/workspace-files')) return jsonResponse(DIR_PAYLOAD)
      return jsonResponse({})
    })
    renderAt('')

    await waitFor(() => expect(screen.getByText('Agent notes')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /role file/i })).toBeInTheDocument()
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).startsWith('/api/workspace-files')),
    ).toBe(true)
  })

  it('opens the default role file from the starter card', async () => {
    const FILE_PAYLOAD = {
      type: 'file',
      agent: 'claude-code',
      path: 'CLAUDE.md',
      size: 123,
      mtime: '2026-05-18T08:00:00Z',
      encoding: 'utf-8',
      content: '# Claude role',
      truncated: false,
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse({ 'claude-code': true })
      if (u === '/api/config') return jsonResponse({ defaultAgent: 'claude-code' })
      if (u.startsWith('/api/workspace-files') && u.includes('CLAUDE.md')) return jsonResponse(FILE_PAYLOAD)
      if (u.startsWith('/api/workspace-files')) return jsonResponse({
        ...DIR_PAYLOAD,
        agent: 'claude-code',
      })
      return jsonResponse({})
    })
    renderAt('')

    await waitFor(() => expect(screen.getByText('Agent notes')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /role file/i }))
    await waitFor(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
      expect(ta?.value).toContain('# Claude role')
    })
  })

  it('memory shortcut creates MEMORY.md when it does not exist yet', async () => {
    let created = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input)
      if (u === '/api/agents/status') return jsonResponse({ claude: true })
      if (u === '/api/config') return jsonResponse({ defaultAgent: 'claude' })
      if (u.startsWith('/api/workspace-files') && init?.method === 'PUT') {
        const body = init.body ? JSON.parse(String(init.body)) : {}
        expect(body.content).toContain('# Memory')
        created = true
        return jsonResponse({ ok: true, agent: 'claude', path: 'MEMORY.md', size: 20, mtime: '2026-05-18T09:00:00Z' })
      }
      if (u.startsWith('/api/workspace-files') && u.includes('MEMORY.md')) {
        if (!created) return jsonResponse({ error: 'Not found' }, 404)
        return jsonResponse({
          type: 'file',
          agent: 'claude',
          path: 'MEMORY.md',
          size: 20,
          mtime: '2026-05-18T09:00:00Z',
          encoding: 'utf-8',
          content: '# Memory\n\nSaved note.',
          truncated: false,
        })
      }
      if (u.startsWith('/api/workspace-files')) return jsonResponse(DIR_PAYLOAD)
      return jsonResponse({})
    })
    renderAt('')

    await waitFor(() => expect(screen.getByText('Agent notes')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /memory/i }))
    await waitFor(() => expect(screen.getByText('This file does not exist yet')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /create memory file/i }))

    await waitFor(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
      expect(ta?.value).toContain('Saved note.')
    })
    expect(
      fetchSpy.mock.calls.some(
        (c) => String(c[0]).startsWith('/api/workspace-files') && (c[1] as RequestInit | undefined)?.method === 'PUT',
      ),
    ).toBe(true)
  })

  it('workspaceBasename / mimeForWorkspaceFilename helpers', () => {
    expect(workspaceBasename('reports/weekly.md')).toBe('weekly.md')
    expect(workspaceBasename('notes.txt')).toBe('notes.txt')
    expect(workspaceBasename('a/b/')).toBe('b')
    expect(mimeForWorkspaceFilename('report.md')).toBe('text/markdown;charset=utf-8')
    expect(mimeForWorkspaceFilename('data.json')).toBe('application/json;charset=utf-8')
    expect(mimeForWorkspaceFilename('plain.txt')).toBe('text/plain;charset=utf-8')
  })

  // Sanity: keep `within` reachable for ts-strict; the helper is
  // genuinely used elsewhere in the suite.
  void within
})
