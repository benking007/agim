/**
 * Browser-side index of Portal workspaces.
 *
 * Workspaces are a client grouping over `web-*` sessions — not the IM
 * tenant `/api/workspaces` registry. The default `cloud` workspace is
 * the agent cwd (`~/.agim-workspaces/<agent>/`). Named entries are
 * subdirectories of that host tree — never folders on the browser's
 * machine.
 */

export const CLOUD_WORKSPACE_ID = 'cloud'
export const WORKSPACES_KEY = 'agim-web-workspaces'

export type WorkspaceKind = 'cloud' | 'local'

export interface WebWorkspace {
  id: string
  kind: WorkspaceKind
  name: string
  /** Local folder path or picker name. Cloud has none. */
  path?: string
  createdAt: number
  /** Hidden from the Portal rail when set. Cloud cannot be archived. */
  archivedAt?: number
}

export interface WebWorkspaceIndex {
  activeId: string
  workspaces: WebWorkspace[]
  collapsed: Record<string, boolean>
}

const listeners = new Set<() => void>()

export function subscribeWorkspaces(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  for (const fn of listeners) fn()
}

export function mintWorkspaceId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function workspaceBasename(path: string): string {
  const norm = path.replace(/[\\/]+$/, '').trim()
  if (!norm) return ''
  const parts = norm.split(/[\\/]/)
  return parts[parts.length - 1] || norm
}

export function cloudWorkspace(): WebWorkspace {
  return { id: CLOUD_WORKSPACE_ID, kind: 'cloud', name: 'cloud', createdAt: 0 }
}

function normalizeWorkspace(raw: unknown): WebWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || !rec.id.trim()) return null
  if (rec.id === CLOUD_WORKSPACE_ID || rec.kind === 'cloud') return cloudWorkspace()
  if (rec.kind !== 'local') return null
  const name = typeof rec.name === 'string' && rec.name.trim()
    ? rec.name.trim()
    : (typeof rec.path === 'string' ? workspaceBasename(rec.path) : '')
  if (!name) return null
  const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path.trim() : name
  const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt)
    ? rec.createdAt
    : Date.now()
  const archivedAt = typeof rec.archivedAt === 'number' && Number.isFinite(rec.archivedAt) && rec.archivedAt > 0
    ? rec.archivedAt
    : undefined
  return {
    id: rec.id.trim(),
    kind: 'local',
    name,
    path,
    createdAt,
    ...(archivedAt ? { archivedAt } : {}),
  }
}

function parseIndex(raw: string): WebWorkspaceIndex | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const rec = v as Record<string, unknown>
    const workspaces: WebWorkspace[] = [cloudWorkspace()]
    const seen = new Set<string>([CLOUD_WORKSPACE_ID])
    if (Array.isArray(rec.workspaces)) {
      for (const item of rec.workspaces) {
        const entry = normalizeWorkspace(item)
        if (!entry || seen.has(entry.id)) continue
        seen.add(entry.id)
        workspaces.push(entry)
      }
    }
    const collapsed: Record<string, boolean> = {}
    if (rec.collapsed && typeof rec.collapsed === 'object') {
      for (const [id, flag] of Object.entries(rec.collapsed as Record<string, unknown>)) {
        if (typeof flag === 'boolean') collapsed[id] = flag
      }
    }
    const visible = new Set(
      workspaces.filter((w) => w.kind === 'cloud' || !w.archivedAt).map((w) => w.id),
    )
    const activeId = typeof rec.activeId === 'string' && visible.has(rec.activeId)
      ? rec.activeId
      : CLOUD_WORKSPACE_ID
    return { activeId, workspaces, collapsed }
  } catch {
    return null
  }
}

function writeIndex(index: WebWorkspaceIndex): WebWorkspaceIndex {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(index)) } catch { /* private mode */ }
  notify()
  return index
}

/** Drop named folders and return to the cloud workspace (account switch). */
export function resetWorkspaces(): WebWorkspaceIndex {
  return writeIndex({
    activeId: CLOUD_WORKSPACE_ID,
    workspaces: [cloudWorkspace()],
    collapsed: {},
  })
}

export function loadWorkspaceIndex(): WebWorkspaceIndex {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY)
    if (raw) {
      const parsed = parseIndex(raw)
      if (parsed) return parsed
    }
  } catch { /* private mode */ }
  return { activeId: CLOUD_WORKSPACE_ID, workspaces: [cloudWorkspace()], collapsed: {} }
}

export function isWorkspaceArchived(entry: WebWorkspace): boolean {
  return entry.kind !== 'cloud' && typeof entry.archivedAt === 'number' && entry.archivedAt > 0
}

export function listWorkspaces(): WebWorkspace[] {
  const { workspaces } = loadWorkspaceIndex()
  return [
    ...workspaces.filter((w) => w.kind === 'cloud'),
    ...workspaces
      .filter((w) => w.kind === 'local' && !isWorkspaceArchived(w))
      .sort((a, b) => a.createdAt - b.createdAt),
  ]
}

export function loadActiveWorkspaceId(): string {
  return loadWorkspaceIndex().activeId
}

export function findWorkspace(id: string): WebWorkspace | undefined {
  return loadWorkspaceIndex().workspaces.find((w) => w.id === id)
}

/** Host path (or picker name) for the selected local workspace. Cloud → undefined. */
export function activeWorkspacePath(): string | undefined {
  const ws = findWorkspace(loadActiveWorkspaceId())
  if (!ws || ws.kind === 'cloud') return undefined
  const path = (ws.path || ws.name || '').trim()
  return path || undefined
}

export function updateWorkspacePath(id: string, path: string): WebWorkspace | undefined {
  const nextPath = path.trim()
  if (!nextPath) return findWorkspace(id)
  const index = loadWorkspaceIndex()
  const name = workspaceBasename(nextPath) || nextPath
  const workspaces = index.workspaces.map((w) => (
    w.id === id && w.kind === 'local' ? { ...w, path: nextPath, name } : w
  ))
  writeIndex({ ...index, workspaces })
  return workspaces.find((w) => w.id === id)
}

export function setActiveWorkspace(id: string): WebWorkspaceIndex {
  const index = loadWorkspaceIndex()
  const next = id.trim()
  const target = index.workspaces.find((w) => w.id === next)
  if (!target || isWorkspaceArchived(target)) return index
  if (index.activeId === next && index.collapsed[next] !== true) return index
  return writeIndex({
    ...index,
    activeId: next,
    collapsed: { ...index.collapsed, [next]: false },
  })
}

export function isWorkspaceCollapsed(id: string): boolean {
  return !!loadWorkspaceIndex().collapsed[id]
}

export function toggleWorkspaceCollapsed(id: string): WebWorkspaceIndex {
  const index = loadWorkspaceIndex()
  if (!index.workspaces.some((w) => w.id === id)) return index
  return writeIndex({
    ...index,
    collapsed: { ...index.collapsed, [id]: !index.collapsed[id] },
  })
}

export function addLocalWorkspace(input: { name: string; path: string }): WebWorkspace {
  const path = input.path.trim()
  const name = (input.name.trim() || workspaceBasename(path)).trim()
  if (!name) return cloudWorkspace()
  const index = loadWorkspaceIndex()
  const dup = index.workspaces.find((w) => w.kind === 'local' && w.path === path)
  if (dup) {
    const restored: WebWorkspace = { ...dup }
    delete restored.archivedAt
    writeIndex({
      ...index,
      activeId: dup.id,
      workspaces: index.workspaces.map((w) => (w.id === dup.id ? restored : w)),
      collapsed: { ...index.collapsed, [dup.id]: false },
    })
    return restored
  }
  const entry: WebWorkspace = {
    id: mintWorkspaceId(),
    kind: 'local',
    name,
    path,
    createdAt: Date.now(),
  }
  writeIndex({
    activeId: entry.id,
    workspaces: [...index.workspaces, entry],
    collapsed: { ...index.collapsed, [entry.id]: false },
  })
  return entry
}

export function removeLocalWorkspace(id: string): WebWorkspaceIndex {
  const index = loadWorkspaceIndex()
  if (id === CLOUD_WORKSPACE_ID) return index
  const workspaces = index.workspaces.filter((w) => w.id !== id)
  if (workspaces.length === index.workspaces.length) return index
  const { [id]: _removed, ...collapsed } = index.collapsed
  return writeIndex({
    activeId: index.activeId === id ? CLOUD_WORKSPACE_ID : index.activeId,
    workspaces,
    collapsed,
  })
}

/** Hide a named folder from the Portal rail. The cloud root cannot be archived. */
export function archiveLocalWorkspace(id: string): WebWorkspaceIndex {
  const index = loadWorkspaceIndex()
  if (id === CLOUD_WORKSPACE_ID) return index
  const target = index.workspaces.find((w) => w.id === id)
  if (target?.kind !== 'local' || isWorkspaceArchived(target)) return index
  const workspaces = index.workspaces.map((w) => (
    w.id === id ? { ...w, archivedAt: Date.now() } : w
  ))
  return writeIndex({
    activeId: index.activeId === id ? CLOUD_WORKSPACE_ID : index.activeId,
    workspaces,
    collapsed: index.collapsed,
  })
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    if (e.key !== WORKSPACES_KEY && e.key !== null) return
    notify()
  })
}
