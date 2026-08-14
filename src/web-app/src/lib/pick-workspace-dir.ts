/**
 * Open a native directory picker when the browser supports it
 * (`showDirectoryPicker` — Chromium / Edge, looks like the OS folder
 * dialog). Other engines fall back to a path field in the rail.
 */

export interface PickedWorkspaceDir {
  name: string
  path: string
}

export type PickWorkspaceDirResult =
  | { status: 'picked'; dir: PickedWorkspaceDir }
  | { status: 'abort' }
  | { status: 'unsupported' }

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (opts?: {
    id?: string
    mode?: 'read' | 'readwrite'
  }) => Promise<{ name: string }>
}

export function canPickDirectory(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

export async function pickWorkspaceDirectory(): Promise<PickWorkspaceDirResult> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (typeof picker !== 'function') return { status: 'unsupported' }
  try {
    const handle = await picker({ id: 'agim-workspace', mode: 'read' })
    const name = (handle.name || '').trim()
    if (!name) return { status: 'abort' }
    return { status: 'picked', dir: { name, path: name } }
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
      return { status: 'abort' }
    }
    return { status: 'unsupported' }
  }
}
