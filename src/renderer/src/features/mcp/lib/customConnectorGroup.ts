import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../../../types'

export const CUSTOM_CONNECTOR_GROUP = '自建' as const

export interface CustomConnectorServerEntry {
  kind: 'server'
  name: string
  subtitle: string
  origin: '自建·本地' | '自建·远程'
  status: '已启用' | '已停用'
  enabled: boolean
  server: McpServerSummary
}

export interface CustomConnectorJobEntry {
  kind: 'job'
  name: string
  subtitle: string
  origin: '自建·本地'
  status: '正在添加…' | '需要先配置' | '添加失败'
  job: McpConnectorSetupProgress
}

export type CustomConnectorEntry = CustomConnectorServerEntry | CustomConnectorJobEntry

function commandLine(server: McpServerSummary): string {
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
}

export function mergeCustomConnectorJobs(
  current: readonly McpConnectorSetupProgress[],
  incoming: readonly McpConnectorSetupProgress[]
): McpConnectorSetupProgress[] {
  const byId = new Map(current.map((job) => [job.id, job]))
  for (const job of incoming) {
    if (job.kind !== 'local-stdio') continue
    const existing = byId.get(job.id)
    if (!existing || job.revision >= existing.revision) byId.set(job.id, job)
  }
  return [...byId.values()]
}

export function customConnectorReadySwitchKey(
  progress: McpConnectorSetupProgress,
  page: 'list' | 'detail'
): string | null {
  return progress.kind === 'local-stdio' && progress.phase === 'ready' && page === 'list'
    ? `${progress.id}:${progress.revision}`
    : null
}

export function customConnectorEntries(
  servers: readonly McpServerSummary[],
  jobs: readonly McpConnectorSetupProgress[]
): CustomConnectorEntry[] {
  const serverEntries: CustomConnectorServerEntry[] = servers
    .filter(
      (server) =>
        server.userStdio === true ||
        (Boolean(server.url) && !server.packageId && !server.connectorId)
    )
    .map((server) => ({
      kind: 'server' as const,
      name: server.name,
      subtitle: server.userStdio ? commandLine(server) : server.url!,
      origin: server.userStdio ? ('自建·本地' as const) : ('自建·远程' as const),
      status: server.enabled === false ? ('已停用' as const) : ('已启用' as const),
      enabled: server.enabled !== false,
      server
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const serverNames = new Set(servers.map((server) => server.name))
  const jobEntries: CustomConnectorJobEntry[] = jobs
    .filter(
      (job) =>
        job.kind === 'local-stdio' &&
        (job.phase === 'starting' || job.phase === 'failed') &&
        !serverNames.has(job.id)
    )
    .map((job) => ({
      kind: 'job' as const,
      name: job.title?.trim() || job.id,
      subtitle: job.summary?.trim() || job.id,
      origin: '自建·本地' as const,
      status:
        job.phase === 'starting'
          ? ('正在添加…' as const)
          : job.failureKind === 'needs-setup'
            ? ('需要先配置' as const)
            : ('添加失败' as const),
      job
    }))
    .sort((left, right) => {
      const timeDifference = Date.parse(right.job.updatedAt) - Date.parse(left.job.updatedAt)
      if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference
      const revisionDifference = right.job.revision - left.job.revision
      return revisionDifference || left.name.localeCompare(right.name)
    })

  return [...jobEntries, ...serverEntries]
}
