import type { AnalysisJupyterRuntimeStatus } from '../../../types'

export interface RuntimeServerEntry {
  projectCwd: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  current: boolean
}

export interface RuntimeServerGroup {
  key: string
  kind: 'local' | 'ssh'
  label: string
  entries: RuntimeServerEntry[]
}

/** Ignore polling timestamps while retaining changes to service state and connected notebooks. */
export function runtimeStatusesSnapshot(statuses: readonly AnalysisJupyterRuntimeStatus[]): string {
  return JSON.stringify(
    statuses.map(({ server, notebooks }) => [
      server.projectCwd,
      server.runtimeKind,
      server.state,
      server.serverLabel,
      server.pid,
      server.port,
      server.remotePort,
      server.hasEndpoint,
      server.message,
      server.cleanupUnconfirmed,
      server.canAbandonCleanup,
      notebooks.sessions.map((session) => [
        session.notebookPath,
        session.sessionId,
        session.state,
        session.kernelName,
        session.kernelDisplayName
      ])
    ])
  )
}

function groupIdentity(
  entry: { kind: 'local' | 'ssh'; serverLabel?: string },
  localLabel: string,
  remoteFallbackLabel: string
): Pick<RuntimeServerGroup, 'key' | 'kind' | 'label'> {
  if (entry.kind === 'local') return { key: 'local', kind: 'local', label: localLabel }
  const host = entry.serverLabel?.trim()
  return {
    key: `ssh:${host?.toLowerCase() ?? ''}`,
    kind: 'ssh',
    label: host || remoteFallbackLabel
  }
}

export function groupRuntimeStatuses(input: {
  projectCwd: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  currentRuntimeKind?: 'local' | 'ssh'
  currentServerLabel?: string
  currentCanonicalCwd?: string
  additionalRuntimeStatuses?: AnalysisJupyterRuntimeStatus[]
  localLabel: string
  remoteFallbackLabel: string
}): RuntimeServerGroup[] {
  const currentServerCwd = input.runtimeStatus?.server.projectCwd ?? input.currentCanonicalCwd
  const currentStatus =
    input.additionalRuntimeStatuses?.find(({ server }) => server.projectCwd === currentServerCwd) ??
    input.runtimeStatus
  const entries = [
    {
      projectCwd: input.projectCwd,
      runtimeStatus: currentStatus,
      current: true,
      kind: currentStatus?.server.runtimeKind ?? input.currentRuntimeKind ?? 'local',
      serverLabel: currentStatus?.server.serverLabel ?? input.currentServerLabel
    },
    ...(input.additionalRuntimeStatuses ?? [])
      .filter(
        ({ server }) =>
          server.projectCwd !== input.projectCwd && server.projectCwd !== currentServerCwd
      )
      .map((runtimeStatus) => ({
        projectCwd: runtimeStatus.server.projectCwd,
        runtimeStatus,
        current: false,
        kind: runtimeStatus.server.runtimeKind ?? ('local' as const),
        serverLabel: runtimeStatus.server.serverLabel
      }))
  ]
  const groups = new Map<string, RuntimeServerGroup>()
  for (const entry of entries) {
    const { key, kind, label } = groupIdentity(entry, input.localLabel, input.remoteFallbackLabel)
    const existing = groups.get(key)
    if (existing) existing.entries.push(entry)
    else groups.set(key, { key, kind, label, entries: [entry] })
  }
  const ordered = [...groups.values()]
  return [
    ...ordered.filter((group) => group.kind === 'local'),
    ...ordered.filter((group) => group.kind === 'ssh')
  ]
}
