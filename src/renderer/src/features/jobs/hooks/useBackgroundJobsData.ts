import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  BackgroundAgentJob,
  BackgroundShellJob
} from '../../../../../shared/backgroundJobTypes'
import type { EnvironmentBuild } from '../../../../../shared/environmentBuildTypes'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import type { RemoteProjectUploadJob } from '../../../../../shared/remoteProjectUploadTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'

const REFRESH_MS = 2000

export type BackgroundJobsData = {
  agentJobs: BackgroundAgentJob[]
  shellJobs: BackgroundShellJob[]
  wrapperRuns: WrapperRun[]
  environmentBuilds: EnvironmentBuild[]
  connectorJobs: McpConnectorSetupProgress[]
  uploadJobs: RemoteProjectUploadJob[]
  jupyterJobs: RemoteJupyterStartJob[]
}

const EMPTY: BackgroundJobsData = {
  agentJobs: [],
  shellJobs: [],
  wrapperRuns: [],
  environmentBuilds: [],
  connectorJobs: [],
  uploadJobs: [],
  jupyterJobs: []
}

function upsertBy<T>(current: readonly T[], next: T, same: (item: T) => boolean): T[] {
  const index = current.findIndex(same)
  if (index === -1) return [next, ...current]
  const copy = current.slice()
  copy[index] = next
  return copy
}

function listOrEmpty<T>(list: (() => Promise<T[]>) | undefined): Promise<T[]> {
  return typeof list === 'function' ? list() : Promise.resolve([])
}

/** Polls every job source and merges the pushed updates in between. */
export function useBackgroundJobsData(): {
  data: BackgroundJobsData
  loaded: boolean
  error: string
  nowMs: number
  refresh: () => Promise<void>
  setError: (error: string) => void
} {
  const [data, setData] = useState<BackgroundJobsData>(EMPTY)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const refreshingRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      if (typeof window.api.listAgentJobs !== 'function') {
        setError('请重启 Phi 以查看后台任务。')
        setLoaded(true)
        return
      }
      const api = window.api
      const results = await Promise.allSettled([
        api.listAgentJobs(),
        listOrEmpty(api.listShellJobs),
        api.listWrapperRuns(),
        listOrEmpty(api.listEnvironmentBuilds),
        listOrEmpty(api.listLocalConnectorJobs),
        listOrEmpty(api.listRemoteProjectUploads),
        listOrEmpty(api.listRemoteJupyterJobs)
      ] as const)
      const [agents, shells, wrappers, builds, connectors, uploads, jupyter] = results
      setData((current) => ({
        agentJobs: agents.status === 'fulfilled' ? agents.value : current.agentJobs,
        shellJobs: shells.status === 'fulfilled' ? shells.value : current.shellJobs,
        wrapperRuns: wrappers.status === 'fulfilled' ? wrappers.value : current.wrapperRuns,
        environmentBuilds: builds.status === 'fulfilled' ? builds.value : current.environmentBuilds,
        connectorJobs: connectors.status === 'fulfilled' ? connectors.value : current.connectorJobs,
        uploadJobs: uploads.status === 'fulfilled' ? uploads.value : current.uploadJobs,
        jupyterJobs: jupyter.status === 'fulfilled' ? jupyter.value : current.jupyterJobs
      }))
      setError(
        results.some((result) => result.status === 'rejected')
          ? '部分任务状态暂时无法读取，稍后会自动重试。'
          : ''
      )
      setLoaded(true)
      setNowMs(Date.now())
    } finally {
      refreshingRef.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const api = window.api
    const unsubscribes = [
      api.onEnvironmentBuildsChanged?.((build) =>
        setData((current) => ({
          ...current,
          environmentBuilds: upsertBy(
            current.environmentBuilds,
            build,
            (item) => item.envId === build.envId
          )
        }))
      ),
      api.onMcpConnectorSetupChanged?.((setup) => {
        if (setup.kind !== 'local-stdio') return
        setData((current) => ({
          ...current,
          connectorJobs: upsertBy(current.connectorJobs, setup, (item) => item.id === setup.id)
        }))
      }),
      api.onRemoteProjectUploadsChanged?.((job) =>
        setData((current) => ({
          ...current,
          uploadJobs: upsertBy(current.uploadJobs, job, (item) => item.id === job.id)
        }))
      ),
      api.onRemoteJupyterJobsChanged?.((job) =>
        setData((current) => ({
          ...current,
          jupyterJobs: upsertBy(current.jupyterJobs, job, (item) => item.id === job.id)
        }))
      )
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.()
    }
  }, [])

  return { data, loaded, error, nowMs, refresh, setError }
}
