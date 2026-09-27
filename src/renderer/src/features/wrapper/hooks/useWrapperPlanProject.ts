import { useEffect, useState } from 'react'

import type { WrapperRunPlan } from '../../../../../shared/wrapperTypes'
import type { Project } from '../../../lib/projectTypes'

/** Keep a plan's saved project identity current without binding it to the active chat tab. */
export function useWrapperPlanProject(plan: WrapperRunPlan | undefined): {
  targetProject: Project | undefined
  localTargetProject: Project | undefined
  targetProjectLoaded: boolean
  needsRemoteSetup: boolean
  refreshLocalTargetProject: () => void
} {
  const [targetProject, setTargetProject] = useState<Project | undefined>()
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null)
  const projectId = plan?.targetSelection?.projectId
  const needsRemoteSetup = Boolean(
    plan?.validation.errors.some((error) =>
      /远程计算目标|服务器工作目录|远程连接|运行方式/.test(error)
    )
  )
  const unboundLocalPlanCwd = !projectId && needsRemoteSetup ? plan?.cwd : undefined

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    let latestConnection: Project['remoteConnection']
    const unsubscribe = window.api.onRemoteProjectConnectionChanged((change) => {
      if (change.projectId !== projectId) return
      latestConnection = change.state
      setTargetProject((current) =>
        current?.id === projectId
          ? { ...current, remoteConnection: change.state, remoteReachability: change.state.phase }
          : current
      )
    })
    void window.api
      .listProjects()
      .then((projects) => {
        if (cancelled) return
        const found = projects.find((project) => project.id === projectId)
        setTargetProject(
          found && latestConnection
            ? {
                ...found,
                remoteConnection: latestConnection,
                remoteReachability: latestConnection.phase
              }
            : found
        )
        setLoadedProjectId(projectId)
      })
      .catch(() => {
        if (!cancelled) setLoadedProjectId(projectId)
      })
    return (): void => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId])

  useEffect(() => {
    if (!unboundLocalPlanCwd) return
    let cancelled = false
    void window.api
      .listProjects()
      .then((projects) => {
        if (cancelled) return
        setTargetProject(
          projects.find(
            (project) =>
              project.location.kind === 'local' &&
              (project.location.path === unboundLocalPlanCwd ||
                project.location.realPath === unboundLocalPlanCwd)
          )
        )
      })
      .catch(() => undefined)
    return (): void => {
      cancelled = true
    }
  }, [unboundLocalPlanCwd])

  const localTargetProject =
    targetProject?.location.kind === 'local' &&
    (projectId === targetProject.id ||
      (unboundLocalPlanCwd &&
        (targetProject.location.path === unboundLocalPlanCwd ||
          targetProject.location.realPath === unboundLocalPlanCwd)))
      ? targetProject
      : undefined

  return {
    targetProject,
    localTargetProject,
    targetProjectLoaded: !projectId || loadedProjectId === projectId,
    needsRemoteSetup,
    refreshLocalTargetProject: () => {
      if (!localTargetProject) return
      void window.api
        .listProjects()
        .then((projects) => {
          setTargetProject(projects.find((project) => project.id === localTargetProject.id))
        })
        .catch(() => undefined)
    }
  }
}
