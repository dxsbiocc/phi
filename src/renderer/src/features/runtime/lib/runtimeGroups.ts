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

export function groupRuntimeStatuses(input: {
  projectCwd: string
  runtimeStatus: AnalysisJupyterRuntimeStatus | null
  currentRuntimeKind?: 'local' | 'ssh'
  currentServerLabel?: string
  additionalRuntimeStatuses?: AnalysisJupyterRuntimeStatus[]
  localLabel: string
  remoteFallbackLabel: string
}): RuntimeServerGroup[] {
  const currentServerCwd = input.runtimeStatus?.server.projectCwd
  const entries = [
    {
      projectCwd: input.projectCwd,
      runtimeStatus: input.runtimeStatus,
      current: true,
      kind: input.runtimeStatus?.server.runtimeKind ?? input.currentRuntimeKind ?? 'local',
      serverLabel: input.runtimeStatus?.server.serverLabel ?? input.currentServerLabel
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
    const kind = entry.kind === 'ssh' ? 'ssh' : 'local'
    const host = entry.serverLabel?.trim()
    const key = kind === 'local' ? 'local' : `ssh:${host?.toLowerCase() ?? ''}`
    const label = kind === 'local' ? input.localLabel : host || input.remoteFallbackLabel
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
