import { useState } from 'react'
import { modeFromFields, type SessionMode } from '../../../../../shared/sessionMode'
import type { Project } from '../../../types'

type HomePromptDraft = {
  text: string
  projectId: string | null
  mode: SessionMode
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
  mode: SessionMode
  remote: boolean
  disabled: boolean
  canSend: boolean
  selectMode: (mode: SessionMode) => void
  submit: () => void
}

type HomeSelectionState = Pick<HomePromptController, 'projectId' | 'setProjectId'>
type HomeModeState = Pick<HomePromptController, 'mode' | 'selectMode'>
type HomeSubmissionState = Pick<HomePromptController, 'draft' | 'setDraft' | 'disabled' | 'submit'>

function useHomeProjectSelection(selection: HomeProjectSelection | null): HomeSelectionState {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [appliedKey, setAppliedKey] = useState<number | null>(null)
  const next = applyHomeProjectSelection({ projectId, appliedKey }, selection)
  if (next.projectId !== projectId) setProjectId(next.projectId)
  if (next.appliedKey !== appliedKey) setAppliedKey(next.appliedKey)
  return { projectId, setProjectId }
}

function useHomeMode(selectedProject: Project | null): HomeModeState {
  const [modes, setModes] = useState<Record<string, SessionMode>>({})
  const key = selectedProject?.id ?? 'ordinary'
  const inherited = selectedProject
    ? modeFromFields({ permissionMode: selectedProject.permissionMode })
    : 'auto'
  const mode = modes[key] ?? inherited
  const selectMode = (nextMode: SessionMode): void => {
    setModes((current) => (current[key] === nextMode ? current : { ...current, [key]: nextMode }))
  }
  return { mode, selectMode }
}

function useHomeSubmission(
  busy: boolean,
  selectedProject: Project | null,
  mode: SessionMode,
  onStart: (request: HomePromptDraft) => Promise<void>
): HomeSubmissionState {
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const disabled = busy || starting
  const submit = (): void => {
    const text = draft.trim()
    if (!text || disabled) return
    setStarting(true)
    void onStart({
      text,
      projectId: selectedProject?.id ?? null,
      mode
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
  onStart: (request: HomePromptDraft) => Promise<void>
): HomePromptController {
  const { projectId, setProjectId } = useHomeProjectSelection(selection)
  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const { mode, selectMode } = useHomeMode(selectedProject)
  const prompt = useHomeSubmission(busy, selectedProject, mode, onStart)
  return {
    draft: prompt.draft,
    setDraft: prompt.setDraft,
    projectId,
    setProjectId,
    selectedProject,
    mode,
    remote: selectedProject?.location.kind === 'ssh',
    disabled: prompt.disabled,
    canSend: prompt.draft.trim().length > 0 && !prompt.disabled,
    selectMode,
    submit: prompt.submit
  }
}
