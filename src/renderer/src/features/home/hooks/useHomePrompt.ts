import { useState } from 'react'
import type { PermissionMode, Project } from '../../../types'

type HomePromptDraft = {
  text: string
  projectId: string | null
  permissionMode: PermissionMode
  planMode: boolean
}

export type HomeProjectSelection = {
  key: number
  projectId: string | null
}

export function applyHomeProjectSelection(
  state: { projectId: string | null; appliedKey: number | null },
  selection: HomeProjectSelection | null
): { projectId: string | null; appliedKey: number | null } {
  if (!selection || selection.key === state.appliedKey) return state
  return { projectId: selection.projectId, appliedKey: selection.key }
}

type HomePromptController = {
  draft: string
  setDraft: (value: string) => void
  projectId: string | null
  setProjectId: (projectId: string | null) => void
  selectedProject: Project | null
  permissionMode: PermissionMode
  planReviewEnabled: boolean
  disablePlanReview: boolean
  disabled: boolean
  canSend: boolean
  selectPermission: (mode: PermissionMode) => void
  togglePlanReview: () => void
  submit: () => void
}

export function useHomePrompt(
  projects: Project[],
  busy: boolean,
  selection: HomeProjectSelection | null,
  onUpdateProjectPermissionMode: (
    projectId: string,
    permissionMode: PermissionMode
  ) => Promise<void>,
  onStart: (request: HomePromptDraft) => Promise<void>
): HomePromptController {
  const [draft, setDraft] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [appliedKey, setAppliedKey] = useState<number | null>(null)
  const [ordinaryPermission, setOrdinaryPermission] = useState<PermissionMode>('auto')
  const [projectPermission, setProjectPermission] = useState<{
    id: string
    mode: PermissionMode
  } | null>(null)
  const [starting, setStarting] = useState(false)
  const [planReviewEnabled, setPlanReviewEnabled] = useState(false)
  const nextSelection = applyHomeProjectSelection({ projectId, appliedKey }, selection)
  if (nextSelection.projectId !== projectId) setProjectId(nextSelection.projectId)
  if (nextSelection.appliedKey !== appliedKey) setAppliedKey(nextSelection.appliedKey)
  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const disablePlanReview = selectedProject?.location.kind === 'ssh'
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

  const togglePlanReview = (): void => {
    if (disablePlanReview) return
    setPlanReviewEnabled((enabled) => !enabled)
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    const planMode = planReviewEnabled && !disablePlanReview
    setStarting(true)
    setPlanReviewEnabled(false)
    void onStart({ text, projectId: selectedProject?.id ?? null, permissionMode, planMode })
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
    planReviewEnabled,
    disablePlanReview,
    disabled,
    canSend: draft.trim().length > 0 && !disabled,
    selectPermission,
    togglePlanReview,
    submit
  }
}
