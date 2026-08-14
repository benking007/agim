/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canPickDirectory, dirFromFileList, pickWorkspaceDirectory } from './pick-workspace-dir'

describe('pickWorkspaceDirectory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports unsupported when the picker API is missing', async () => {
    expect(canPickDirectory()).toBe(false)
    await expect(pickWorkspaceDirectory()).resolves.toEqual({ status: 'unsupported' })
  })

  it('returns the folder name from showDirectoryPicker', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => ({ name: 'agim' })))
    expect(canPickDirectory()).toBe(true)
    await expect(pickWorkspaceDirectory()).resolves.toEqual({
      status: 'picked',
      dir: { name: 'agim', path: 'agim' },
    })
  })

  it('reads the folder name from a webkitdirectory FileList', () => {
    const file = new File(['x'], 'package.json')
    Object.defineProperty(file, 'webkitRelativePath', { value: 'ceshi/package.json' })
    expect(dirFromFileList([file])).toEqual({ name: 'ceshi', path: 'ceshi' })
    expect(dirFromFileList([])).toBeNull()
  })

  it('treats a dismissed picker as abort', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }))
    await expect(pickWorkspaceDirectory()).resolves.toEqual({ status: 'abort' })
  })
})
