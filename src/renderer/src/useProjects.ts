import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { RemoteProjectConnectionChange } from '../../shared/projectLocation'
import type { PermissionMode, Project, ProjectRemoteConnection, ThinkingLevel } from './types'
import { appCopy } from './lib/appCopy'

export function applyRemoteProjectConnectionChange(
  projects: Project[],
  change: RemoteProjectConnectionChange
): Project[] {
  return projects.map((project) =>
    project.id === change.projectId && project.location.kind === 'ssh'
      ? {
          ...project,
          remoteConnection: change.state,
          remoteReachability: change.state.phase
        }
      : project
  )
}

export type ProjectsState = {
  projects: Project[]
  setProjects: (projects: Project[] | ((prev: Project[]) => Project[])) => void
  projectsRef: MutableRefObject<Project[]>
  /** Replaces one project after a settings panel saved it through its own IPC call. */
  onProjectUpdated: (project: Project) => void
  updatingPermissionProjectId: string | null
  updatingRemoteProjectId: string | null
  refreshProjects: () => Promise<void>
  onUpdateProjectPermissionMode: (
    projectId: string,
    permissionMode: PermissionMode
  ) => Promise<void>
  onUpdateProjectDefaults: (
    projectId: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => Promise<void>
  onUpdateProjectRemoteConnection: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null
  ) => Promise<void>
  onUpdateProjectRemoteDefaults: (
    projectId: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ) => Promise<void>
}

export function useProjects(
  showSnackbarError: (error: unknown, fallback: string) => void
): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([])
  const projectsRef = useRef<Project[]>([])
  const [updatingPermissionProjectId, setUpdatingPermissionProjectId] = useState<string | null>(
    null
  )
  const [updatingRemoteProjectId, setUpdatingRemoteProjectId] = useState<string | null>(null)

  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  useEffect(
    () =>
      window.api.onRemoteProjectConnectionChanged((change) => {
        setProjects((current) => {
          const next = applyRemoteProjectConnectionChange(current, change)
          projectsRef.current = next
          return next
        })
      }),
    []
  )

  const refreshProjects = useCallback(async (): Promise<void> => {
    const list = await window.api.listProjects()
    projectsRef.current = list
    setProjects(list)
  }, [])

  const onUpdateProjectPermissionMode = useCallback(
    async (projectId: string, permissionMode: PermissionMode): Promise<void> => {
      setUpdatingPermissionProjectId(projectId)
      try {
        const project = await window.api.updateProjectPermissionMode(projectId, permissionMode)
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      } finally {
        setUpdatingPermissionProjectId(null)
      }
    },
    []
  )

  const onUpdateProjectDefaults = useCallback(
    async (
      projectId: string,
      defaults: {
        defaultModel?: { providerId: string; modelId: string } | null
        defaultThinkingLevel?: ThinkingLevel | null
      }
    ): Promise<void> => {
      setUpdatingPermissionProjectId(projectId)
      try {
        const project = await window.api.updateProjectDefaults(projectId, defaults)
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      } catch (error) {
        showSnackbarError(error, appCopy.updateProjectModelFailed)
      } finally {
        setUpdatingPermissionProjectId(null)
      }
    },
    [showSnackbarError]
  )

  const onUpdateProjectRemoteConnection = useCallback(
    async (
      projectId: string,
      connectionId: string,
      patch: ProjectRemoteConnection | null
    ): Promise<void> => {
      setUpdatingRemoteProjectId(projectId)
      try {
        const project = await window.api.updateProjectRemoteConnection(
          projectId,
          connectionId,
          patch
        )
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      } catch (error) {
        showSnackbarError(error, appCopy.updateRemoteConnectionFailed)
        throw error
      } finally {
        setUpdatingRemoteProjectId(null)
      }
    },
    [showSnackbarError]
  )

  const onUpdateProjectRemoteDefaults = useCallback(
    async (
      projectId: string,
      defaults: {
        defaultRemoteConnectionId?: string | null
        remoteWorkspaceRoot?: string | null
      }
    ): Promise<void> => {
      setUpdatingRemoteProjectId(projectId)
      try {
        const project = await window.api.updateProjectRemoteDefaults(projectId, defaults)
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      } catch (error) {
        showSnackbarError(error, appCopy.updateRemoteDefaultsFailed)
        throw error
      } finally {
        setUpdatingRemoteProjectId(null)
      }
    },
    [showSnackbarError]
  )

  const onProjectUpdated = useCallback((project: Project): void => {
    setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
  }, [])

  return {
    projects,
    setProjects,
    onProjectUpdated,
    projectsRef,
    updatingPermissionProjectId,
    updatingRemoteProjectId,
    refreshProjects,
    onUpdateProjectPermissionMode,
    onUpdateProjectDefaults,
    onUpdateProjectRemoteConnection,
    onUpdateProjectRemoteDefaults
  }
}
