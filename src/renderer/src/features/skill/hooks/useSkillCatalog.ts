import { useCallback, useRef, useState } from 'react'
import type { PromptAgentSummary, SkillSummary } from '../../../types'

export type SkillCatalogState = {
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  activeSkillId: string | null
  isLoadingSkills: boolean
  busySkillId: string | null
  setActiveSkillId: (id: string | null) => void
  refreshSkills: () => Promise<void>
  refreshPromptAgents: () => Promise<void>
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
    setActiveSkillId((current) =>
      current && list.some((skill) => skill.id === current) ? current : (list[0]?.id ?? null)
    )
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

  const setSkillDisabled = useCallback(
    async (skill: SkillSummary, disabled: boolean): Promise<SkillSummary[]> => {
      const cwd = getActiveCwd()
      setBusySkillId(skill.id)
      try {
        const list = await window.api.setSkillDisabled(skill.filePath, disabled, cwd)
        if (cwd === getActiveCwd()) applySkills(list)
        return list
      } finally {
        setBusySkillId((current) => (current === skill.id ? null : current))
      }
    },
    [applySkills, getActiveCwd]
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
    setSkillDisabled,
    deleteSkill
  }
}
