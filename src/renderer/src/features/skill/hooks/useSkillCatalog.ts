import { useCallback, useRef, useState } from 'react'
import type { PromptAgentSummary, SkillSummary } from '../../../types'

export type SkillCatalogState = {
  skills: SkillSummary[]
  promptAgents: PromptAgentSummary[]
  activeSkillId: string | null
  isLoadingSkills: boolean
  setActiveSkillId: (id: string | null) => void
  refreshSkills: () => Promise<void>
  refreshPromptAgents: () => Promise<void>
}

export function useSkillCatalog(getActiveCwd: () => string): SkillCatalogState {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [promptAgents, setPromptAgents] = useState<PromptAgentSummary[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [isLoadingSkills, setIsLoadingSkills] = useState(false)
  const skillsRequestRef = useRef(0)
  const promptAgentsRequestRef = useRef(0)

  const refreshSkills = useCallback(async (): Promise<void> => {
    const request = ++skillsRequestRef.current
    const cwd = getActiveCwd()
    setIsLoadingSkills(true)
    try {
      const list = await window.api.listSkills(cwd)
      if (request !== skillsRequestRef.current || cwd !== getActiveCwd()) return
      setSkills(list)
      setActiveSkillId((current) => current ?? list[0]?.id ?? null)
    } finally {
      if (request === skillsRequestRef.current) {
        setIsLoadingSkills(false)
      }
    }
  }, [getActiveCwd])

  const refreshPromptAgents = useCallback(async (): Promise<void> => {
    const request = ++promptAgentsRequestRef.current
    const cwd = getActiveCwd()
    const list = await window.api.listPromptAgents(cwd)
    if (request !== promptAgentsRequestRef.current || cwd !== getActiveCwd()) return
    setPromptAgents(list)
  }, [getActiveCwd])

  return {
    skills,
    promptAgents,
    activeSkillId,
    isLoadingSkills,
    setActiveSkillId,
    refreshSkills,
    refreshPromptAgents
  }
}
