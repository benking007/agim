/**
 * Open the browser's native folder picker.
 *
 * Prefer File System Access `showDirectoryPicker` (Chrome / Edge — the
 * OS directory dialog). When that API is missing, the rail clicks a
 * hidden `<input webkitdirectory>` which still opens the same kind of
 * folder chooser in Firefox / Safari / most webviews.
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

/** Root folder name from a `webkitdirectory` FileList. */
export function dirFromFileList(files: FileList | File[] | null | undefined): PickedWorkspaceDir | null {
  if (!files || files.length === 0) return null
  const first = files[0]
  if (!first) return null
  const rel = (first.webkitRelativePath || first.name || '').replace(/\\/g, '/')
  const root = rel.split('/').find((part) => part.trim())
  if (!root) return null
  return { name: root, path: root }
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
