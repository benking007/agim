/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLOUD_WORKSPACE_ID,
  WORKSPACES_KEY,
  addLocalWorkspace,
  findWorkspace,
  listWorkspaces,
  loadActiveWorkspaceId,
  loadWorkspaceIndex,
  removeLocalWorkspace,
  setActiveWorkspace,
  toggleWorkspaceCollapsed,
  workspaceBasename,
} from './web-workspaces'

describe('web-workspaces', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to the cloud workspace', () => {
    const listed = listWorkspaces()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(CLOUD_WORKSPACE_ID)
    expect(listed[0]?.kind).toBe('cloud')
    expect(loadActiveWorkspaceId()).toBe(CLOUD_WORKSPACE_ID)
  })

  it('adds a local workspace and selects it', () => {
    const ws = addLocalWorkspace({ name: 'agim', path: '/Users/a/Work/agim' })
    expect(ws.kind).toBe('local')
    expect(ws.name).toBe('agim')
    expect(ws.path).toBe('/Users/a/Work/agim')
    expect(loadActiveWorkspaceId()).toBe(ws.id)
    expect(listWorkspaces().map((w) => w.id)).toEqual([CLOUD_WORKSPACE_ID, ws.id])
  })

  it('reuses an existing local workspace with the same path', () => {
    const first = addLocalWorkspace({ name: 'agim', path: '/tmp/agim' })
    setActiveWorkspace(CLOUD_WORKSPACE_ID)
    const again = addLocalWorkspace({ name: 'agim', path: '/tmp/agim' })
    expect(again.id).toBe(first.id)
    expect(loadActiveWorkspaceId()).toBe(first.id)
    expect(listWorkspaces().filter((w) => w.kind === 'local')).toHaveLength(1)
  })

  it('toggles collapse and can remove a local workspace', () => {
    const ws = addLocalWorkspace({ name: 'ceshi', path: '/tmp/ceshi' })
    expect(loadWorkspaceIndex().collapsed[ws.id]).toBe(false)
    toggleWorkspaceCollapsed(ws.id)
    expect(loadWorkspaceIndex().collapsed[ws.id]).toBe(true)
    removeLocalWorkspace(ws.id)
    expect(findWorkspace(ws.id)).toBeUndefined()
    expect(loadActiveWorkspaceId()).toBe(CLOUD_WORKSPACE_ID)
  })

  it('workspaceBasename handles posix and windows paths', () => {
    expect(workspaceBasename('/Users/a/Work/agim')).toBe('agim')
    expect(workspaceBasename('C:\\Users\\a\\Work\\agim\\')).toBe('agim')
    expect(workspaceBasename('   ')).toBe('')
  })

  it('migrates a persisted index and keeps cloud first', () => {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({
      activeId: 'ws-one',
      workspaces: [
        { id: 'ws-one', kind: 'local', name: 'one', path: '/tmp/one', createdAt: 2 },
        { id: 'cloud', kind: 'cloud', name: 'ignored' },
      ],
      collapsed: { 'ws-one': true },
    }))
    const listed = listWorkspaces()
    expect(listed[0]?.id).toBe(CLOUD_WORKSPACE_ID)
    expect(listed[1]?.id).toBe('ws-one')
    expect(loadActiveWorkspaceId()).toBe('ws-one')
    expect(loadWorkspaceIndex().collapsed['ws-one']).toBe(true)
  })
})
