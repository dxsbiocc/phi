import { useState } from 'react'
import type { PermissionMode, Project } from '../../../types'

type HomePromptDraft = {
  text: string
  projectId: string | null
  permissionMode: PermissionMode
}

export function useHomePrompt(
  projects: Project[],
  busy: boolean,
  createdProjectId: string | null,
  onUpdateProjectPermissionMode: (
    projectId: string,
    permissionMode: PermissionMode
  ) => Promise<void>,
  onStart: (request: HomePromptDraft) => Promise<void>
): {
  draft: string
  setDraft: (value: string) => void
  projectId: string | null
  setProjectId: (projectId: string | null) => void
  selectedProject: Project | null
  permissionMode: PermissionMode
  disabled: boolean
  canSend: boolean
  selectPermission: (mode: PermissionMode) => void
  submit: () => void
} {
  const [draft, setDraft] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [seenCreatedId, setSeenCreatedId] = useState<string | null>(null)
  if (createdProjectId && createdProjectId !== seenCreatedId) {
    setSeenCreatedId(createdProjectId)
    setProjectId(createdProjectId)
  }
  const [ordinaryPermission, setOrdinaryPermission] = useState<PermissionMode>('auto')
  const [projectPermission, setProjectPermission] = useState<{
    id: string
    mode: PermissionMode
  } | null>(null)
  const [starting, setStarting] = useState(false)
  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const permissionMode = selectedProject
    ? projectPermission?.id === selectedProject.id
      ? projectPermission.mode
      : selectedProject.permissionMode
    : ordinaryPermission
  const disabled = busy || starting

  const selectPermission = (mode: PermissionMode): void => {
    if (selectedProject) {
      setProjectPermission({ id: selectedProject.id, mode })
      void onUpdateProjectPermissionMode(selectedProject.id, mode)
      return
    }
    setOrdinaryPermission(mode)
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    setStarting(true)
    void onStart({ text, projectId: selectedProject?.id ?? null, permissionMode })
      .then(() => setDraft(''))
      .finally(() => {
        setStarting(false)
      })
  }

  return {
    draft,
    setDraft,
    projectId,
    setProjectId,
    selectedProject,
    permissionMode,
    disabled,
    canSend: draft.trim().length > 0 && !disabled,
    selectPermission,
    submit
  }
}
