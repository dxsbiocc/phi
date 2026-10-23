import { useState } from 'react'
import type { PermissionMode, Project } from '../../../types'
import { usePlanModeToggle, type PlanMode } from '../../plan/hooks/usePlanModeToggle'

type HomePromptDraft = {
  text: string
  projectId: string | null
  permissionMode: PermissionMode
  planMode?: true
  planExecute?: true
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
  planMode: PlanMode
  disablePlanReview: boolean
  disabled: boolean
  canSend: boolean
  selectPermission: (mode: PermissionMode) => void
  selectPlanMode: (mode: PlanMode) => void
  submit: () => void
}

type HomeSelectionState = Pick<HomePromptController, 'projectId' | 'setProjectId'>
type HomePermissionState = Pick<HomePromptController, 'permissionMode' | 'selectPermission'>
type HomeSubmissionState = Pick<HomePromptController, 'draft' | 'setDraft' | 'disabled' | 'submit'>

function useHomeProjectSelection(selection: HomeProjectSelection | null): HomeSelectionState {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [appliedKey, setAppliedKey] = useState<number | null>(null)
  const next = applyHomeProjectSelection({ projectId, appliedKey }, selection)
  if (next.projectId !== projectId) setProjectId(next.projectId)
  if (next.appliedKey !== appliedKey) setAppliedKey(next.appliedKey)
  return { projectId, setProjectId }
}

function useHomePermission(
  selectedProject: Project | null,
  onUpdate: (projectId: string, permissionMode: PermissionMode) => Promise<void>
): HomePermissionState {
  const [ordinary, setOrdinary] = useState<PermissionMode>('auto')
  const [project, setProject] = useState<{ id: string; mode: PermissionMode } | null>(null)
  const permissionMode = selectedProject
    ? project?.id === selectedProject.id
      ? project.mode
      : selectedProject.permissionMode
    : ordinary
  const selectPermission = (mode: PermissionMode): void => {
    if (!selectedProject) return setOrdinary(mode)
    setProject({ id: selectedProject.id, mode })
    void onUpdate(selectedProject.id, mode)
  }
  return { permissionMode, selectPermission }
}

function useHomeSubmission(
  busy: boolean,
  selectedProject: Project | null,
  permissionMode: PermissionMode,
  planToggle: ReturnType<typeof usePlanModeToggle>,
  onStart: (request: HomePromptDraft) => Promise<void>
): HomeSubmissionState {
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const disabled = busy || starting
  const submit = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    setStarting(true)
    planToggle.resetMode()
    void onStart({
      text,
      projectId: selectedProject?.id ?? null,
      permissionMode,
      ...planToggle.sendOptions
    })
      .then(() => setDraft(''))
      .finally(() => setStarting(false))
  }
  return { draft, setDraft, disabled, submit }
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
  const { projectId, setProjectId } = useHomeProjectSelection(selection)
  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const disablePlanReview = selectedProject?.location.kind === 'ssh'
  const planToggle = usePlanModeToggle(
    `home:${selectedProject?.id ?? 'ordinary'}`,
    disablePlanReview
  )
  const { permissionMode, selectPermission } = useHomePermission(
    selectedProject,
    onUpdateProjectPermissionMode
  )
  const prompt = useHomeSubmission(busy, selectedProject, permissionMode, planToggle, onStart)
  return {
    draft: prompt.draft,
    setDraft: prompt.setDraft,
    projectId,
    setProjectId,
    selectedProject,
    permissionMode,
    planMode: planToggle.mode,
    disablePlanReview,
    disabled: prompt.disabled,
    canSend: prompt.draft.trim().length > 0 && !prompt.disabled,
    selectPermission,
    selectPlanMode: planToggle.selectMode,
    submit: prompt.submit
  }
}
