import { useCallback, useRef, useState } from 'react'
import type { PromptAgentSummary, SkillSummary } from '../../../types'
import { retainSelectedCatalogId } from '../../../lib/catalogSelection'

export type SkillCatalogState = {
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  activeSkillId: string | null
  isLoadingSkills: boolean
  busySkillId: string | null
  setActiveSkillId: (id: string | null) => void
  refreshSkills: () => Promise<void>
  refreshPromptAgents: () => Promise<void>
  setGlobalEnabled: (skill: SkillSummary, enabled: boolean) => Promise<SkillSummary[]>
  setProjectOverride: (
    skill: SkillSummary,
    value: boolean | null,
    projectCwd: string
  ) => Promise<SkillSummary[]>
  setSkillDisabled: (skill: SkillSummary, disabled: boolean) => Promise<SkillSummary[]>
  deleteSkill: (skill: SkillSummary) => Promise<SkillSummary[]>
}

export function useSkillCatalog(getActiveCwd: () => string): SkillCatalogState {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [promptAgents, setPromptAgents] = useState<PromptAgentSummary[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [isLoadingSkills, setIsLoadingSkills] = useState(false)
  const [busySkillId, setBusySkillId] = useState<string | null>(null)
  const skillsRequestRef = useRef(0)
  const promptAgentsRequestRef = useRef(0)

  const applySkills = useCallback((list: SkillSummary[]): void => {
    setSkills(list)
    setActiveSkillId((current) => retainSelectedCatalogId(current, list))
  }, [])

  const refreshSkills = useCallback(async (): Promise<void> => {
    const request = ++skillsRequestRef.current
    const cwd = getActiveCwd()
    setIsLoadingSkills(true)
    try {
      const list = await window.api.listSkills(cwd)
      if (request !== skillsRequestRef.current || cwd !== getActiveCwd()) return
      applySkills(list)
    } finally {
      if (request === skillsRequestRef.current) {
        setIsLoadingSkills(false)
      }
    }
  }, [applySkills, getActiveCwd])

  const refreshPromptAgents = useCallback(async (): Promise<void> => {
    const request = ++promptAgentsRequestRef.current
    const cwd = getActiveCwd()
    const list = await window.api.listPromptAgents(cwd)
    if (request !== promptAgentsRequestRef.current || cwd !== getActiveCwd()) return
    setPromptAgents(list)
  }, [getActiveCwd])

  const updateEnablement = useCallback(
    async (
      skill: SkillSummary,
      value: boolean | null,
      scope: { type: 'global' } | { type: 'project'; projectCwd: string }
    ): Promise<SkillSummary[]> => {
      const cwd = getActiveCwd()
      setBusySkillId(skill.id)
      try {
        await window.api.setEnablement(`skill:${skill.name}`, value, scope)
        const list = await window.api.listSkills(cwd)
        if (cwd === getActiveCwd()) applySkills(list)
        return list
      } finally {
        setBusySkillId((current) => (current === skill.id ? null : current))
      }
    },
    [applySkills, getActiveCwd]
  )

  const setGlobalEnabled = useCallback(
    (skill: SkillSummary, enabled: boolean): Promise<SkillSummary[]> =>
      updateEnablement(skill, enabled, { type: 'global' }),
    [updateEnablement]
  )

  const setProjectOverride = useCallback(
    (skill: SkillSummary, value: boolean | null, projectCwd: string): Promise<SkillSummary[]> =>
      updateEnablement(skill, value, { type: 'project', projectCwd }),
    [updateEnablement]
  )

  const setSkillDisabled = useCallback(
    (skill: SkillSummary, disabled: boolean): Promise<SkillSummary[]> =>
      setGlobalEnabled(skill, !disabled),
    [setGlobalEnabled]
  )

  const deleteSkill = useCallback(
    async (skill: SkillSummary): Promise<SkillSummary[]> => {
      const cwd = getActiveCwd()
      setBusySkillId(skill.id)
      try {
        const list = await window.api.deleteSkill(skill.filePath, cwd)
        if (cwd === getActiveCwd()) applySkills(list)
        return list
      } finally {
        setBusySkillId((current) => (current === skill.id ? null : current))
      }
    },
    [applySkills, getActiveCwd]
  )

  return {
    skills,
    promptAgents,
    activeSkillId,
    isLoadingSkills,
    busySkillId,
    setActiveSkillId,
    refreshSkills,
    refreshPromptAgents,
    setGlobalEnabled,
    setProjectOverride,
    setSkillDisabled,
    deleteSkill
  }
}
