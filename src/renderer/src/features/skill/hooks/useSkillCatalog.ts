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
  refreshSkillsForNavigation: () => Promise<void>
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
  const skillsReadRef = useRef<{
    cwd: string
    request: number
    promise: Promise<SkillSummary[]>
  } | null>(null)

  const applySkills = useCallback((list: SkillSummary[]): void => {
    setSkills(list)
    setActiveSkillId((current) => retainSelectedCatalogId(current, list))
  }, [])

  const readSkills = useCallback(
    (cwd: string, force = false): Promise<SkillSummary[]> => {
      if (!force && skillsReadRef.current?.cwd === cwd) return skillsReadRef.current.promise
      const request = ++skillsRequestRef.current
      const promise = Promise.resolve()
        .then(() => window.api.listSkills(cwd))
        .then((list) => {
          if (request === skillsRequestRef.current && cwd === getActiveCwd()) applySkills(list)
          return list
        })
        .finally(() => {
          if (skillsReadRef.current?.request === request) skillsReadRef.current = null
          if (request === skillsRequestRef.current) setIsLoadingSkills(false)
        })
      skillsReadRef.current = { cwd, request, promise }
      return promise
    },
    [applySkills, getActiveCwd]
  )

  const refreshSkills = useCallback(async (): Promise<void> => {
    setIsLoadingSkills(true)
    await readSkills(getActiveCwd(), true)
  }, [getActiveCwd, readSkills])

  const refreshSkillsForNavigation = useCallback(async (): Promise<void> => {
    setIsLoadingSkills(true)
    await readSkills(getActiveCwd())
  }, [getActiveCwd, readSkills])

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
        return cwd === getActiveCwd()
          ? await readSkills(cwd, true)
          : await window.api.listSkills(cwd)
      } finally {
        setBusySkillId((current) => (current === skill.id ? null : current))
      }
    },
    [getActiveCwd, readSkills]
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
        if (cwd === getActiveCwd()) {
          skillsRequestRef.current += 1
          skillsReadRef.current = null
          setIsLoadingSkills(false)
          applySkills(list)
        }
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
    refreshSkillsForNavigation,
    refreshPromptAgents,
    setGlobalEnabled,
    setProjectOverride,
    setSkillDisabled,
    deleteSkill
  }
}
