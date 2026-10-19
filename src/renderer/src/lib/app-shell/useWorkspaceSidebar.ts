import { useState, type Dispatch, type SetStateAction } from 'react'

import type { WorkspaceSidebarMode } from '../workspaceSidebar'
import { navigationPaneWidth } from '../../layout'

export interface WorkspaceSidebarPreview {
  mode: WorkspaceSidebarMode
  anchorEl: HTMLElement
}

/**
 * App shell: navigation sidebar ownership.
 *
 * Second slice of the App.tsx split. It owns how the left rail is shown: open
 * state, width, the active sidebar mode, the hover preview, and the session-tab
 * bookkeeping that decides whether the conversation tab is restored.
 *
 * The preview close timer deliberately stays in App.tsx: returning a ref from a
 * hook makes the react-hooks compiler rules treat `.current` writes as illegal
 * mutations, so refs stay with their owner until the callbacks move too.
 */
export interface WorkspaceSidebarState {
  isSidebarOpen: boolean
  setIsSidebarOpen: Dispatch<SetStateAction<boolean>>
  sidebarWidth: number
  setSidebarWidth: Dispatch<SetStateAction<number>>
  workspaceSidebarMode: WorkspaceSidebarMode
  setWorkspaceSidebarMode: Dispatch<SetStateAction<WorkspaceSidebarMode>>
  workspaceSidebarPreview: WorkspaceSidebarPreview | null
  setWorkspaceSidebarPreview: Dispatch<SetStateAction<WorkspaceSidebarPreview | null>>
  sessionTabWasOpened: boolean
  setSessionTabWasOpened: Dispatch<SetStateAction<boolean>>
  closedWorkspaceSessionTabKeys: Set<string>
  setClosedWorkspaceSessionTabKeys: Dispatch<SetStateAction<Set<string>>>
}

export function useWorkspaceSidebar(): WorkspaceSidebarState {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(navigationPaneWidth)
  const [workspaceSidebarMode, setWorkspaceSidebarMode] =
    useState<WorkspaceSidebarMode>('conversations')
  const [workspaceSidebarPreview, setWorkspaceSidebarPreview] =
    useState<WorkspaceSidebarPreview | null>(null)
  const [sessionTabWasOpened, setSessionTabWasOpened] = useState(false)
  const [closedWorkspaceSessionTabKeys, setClosedWorkspaceSessionTabKeys] = useState<Set<string>>(
    () => new Set()
  )

  return {
    isSidebarOpen,
    setIsSidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    workspaceSidebarMode,
    setWorkspaceSidebarMode,
    workspaceSidebarPreview,
    setWorkspaceSidebarPreview,
    sessionTabWasOpened,
    setSessionTabWasOpened,
    closedWorkspaceSessionTabKeys,
    setClosedWorkspaceSessionTabKeys
  }
}
