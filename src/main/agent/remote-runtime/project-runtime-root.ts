import type { Project } from '../projects'
import { resolveRemoteRuntimeRoot, type RemoteRuntimeRootResolution } from '../remote-runtime-root'

export function resolveProjectRuntimeRoot(
  project: Project,
  hostOverride?: string
): RemoteRuntimeRootResolution {
  if (project.location.kind !== 'ssh') return resolveRemoteRuntimeRoot({ hostOverride })
  const hostProfileId = project.location.hostProfileId
  const connections = project.remoteConnections ?? []
  const projectConnection =
    connections.find(
      (connection) =>
        connection.id === project.defaultRemoteConnectionId &&
        connection.hostProfileId === hostProfileId
    ) ?? connections.find((connection) => connection.hostProfileId === hostProfileId)
  return resolveRemoteRuntimeRoot({
    ...(projectConnection?.runtimeRoot ? { projectOverride: projectConnection.runtimeRoot } : {}),
    hostOverride
  })
}
