import { useEffect, useState } from 'react'
import {
  listWorkspaces,
  loadActiveWorkspaceId,
  loadWorkspaceIndex,
  subscribeWorkspaces,
  type WebWorkspace,
} from '@/lib/web-workspaces'

export function useWebWorkspaces(): {
  workspaces: WebWorkspace[]
  activeId: string
  collapsed: Record<string, boolean>
} {
  const [snap, setSnap] = useState(() => {
    const index = loadWorkspaceIndex()
    return {
      workspaces: listWorkspaces(),
      activeId: loadActiveWorkspaceId(),
      collapsed: index.collapsed,
    }
  })
  useEffect(() => subscribeWorkspaces(() => {
    const index = loadWorkspaceIndex()
    setSnap({
      workspaces: listWorkspaces(),
      activeId: index.activeId,
      collapsed: index.collapsed,
    })
  }), [])
  return snap
}
