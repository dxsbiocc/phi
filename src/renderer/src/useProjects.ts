import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { PermissionMode, Project, ProjectRemoteConnection, ThinkingLevel } from './types'

export type ProjectsState = {
  projects: Project[]
  setProjects: (projects: Project[] | ((prev: Project[]) => Project[])) => void
  projectsRef: MutableRefObject<Project[]>
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
    patch: ProjectRemoteConnection | null,
    passphrase?: string | null
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
        showSnackbarError(error, '更新项目默认模型失败')
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
      patch: ProjectRemoteConnection | null,
      passphrase?: string | null
    ): Promise<void> => {
      setUpdatingRemoteProjectId(projectId)
      try {
        const project = await window.api.updateProjectRemoteConnection(
          projectId,
          connectionId,
          patch,
          passphrase
        )
        setProjects((prev) => prev.map((item) => (item.id === project.id ? project : item)))
      } catch (error) {
        showSnackbarError(error, '更新远程连接失败')
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
        showSnackbarError(error, '更新远程执行默认设置失败')
      } finally {
        setUpdatingRemoteProjectId(null)
      }
    },
    [showSnackbarError]
  )

  return {
    projects,
    setProjects,
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
