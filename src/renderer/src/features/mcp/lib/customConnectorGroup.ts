import { getUiLocale } from '../../../lib/i18n'
import { resourceUi } from '../../../lib/resourceUi'
import { connectorCopy } from './connectorCopy'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'
import type { McpServerSummary } from '../../../types'
import type {
  ConnectorInstallFilter,
  ConnectorSignInFilter,
  ConnectorSort
} from './featuredConnectorFilters'

export const CUSTOM_CONNECTOR_GROUP = '自建' as const

export interface CustomConnectorServerEntry {
  kind: 'server'
  name: string
  subtitle: string
  origin: typeof connectorCopy.customLocal | typeof connectorCopy.customRemote
  status: typeof resourceUi.enabled | typeof resourceUi.disabled
  enabled: boolean
  server: McpServerSummary
}

export interface CustomConnectorJobEntry {
  kind: 'job'
  name: string
  subtitle: string
  origin: typeof connectorCopy.customLocal
  status:
    typeof connectorCopy.adding | typeof connectorCopy.needsSetup | typeof connectorCopy.addFailed
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
      origin: server.userStdio ? connectorCopy.customLocal : connectorCopy.customRemote,
      status: server.enabled === false ? resourceUi.disabled : resourceUi.enabled,
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
      origin: connectorCopy.customLocal,
      status:
        job.phase === 'starting'
          ? connectorCopy.adding
          : job.failureKind === 'needs-setup'
            ? connectorCopy.needsSetup
            : connectorCopy.addFailed,
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

export function filterCustomConnectorEntries(
  entries: readonly CustomConnectorEntry[],
  options: {
    query: string
    signIn: ConnectorSignInFilter
    install: ConnectorInstallFilter
    sort: ConnectorSort
  }
): CustomConnectorEntry[] {
  const query = options.query.trim().toLowerCase()
  const matched = entries.filter((entry) => {
    if (options.signIn !== 'all' && options.signIn !== '无需登录') return false
    const configured = entry.kind === 'server'
    if (options.install === 'added' && !configured) return false
    if (options.install === 'not-added' && configured) return false
    if (!query) return true
    return [entry.name, entry.subtitle, entry.origin, entry.status].some((value) =>
      value.toLowerCase().includes(query)
    )
  })
  if (options.sort === 'name') {
    return [...matched].sort((left, right) => left.name.localeCompare(right.name, getUiLocale()))
  }
  if (options.sort === 'added') {
    return [...matched].sort(
      (left, right) => Number(right.kind === 'server') - Number(left.kind === 'server')
    )
  }
  return matched
}
