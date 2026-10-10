import type { RemoteRuntimePromptContext } from './main-system-prompt'
import { currentRemoteMicromambaVersion } from './workspace-host/remote-micromamba-profile'
import { remoteMicromambaPath } from '../../shared/remoteMicromambaTypes'
import { getRemoteHostProfile, type RemoteHostProfile } from './remote-hosts'
import { resolveRemoteRuntimeRoot } from './remote-runtime-root'
import { readHostRuntimeRoot } from './remote-runtime-root-store'
import { readCapabilityProfile } from './workspace-host/capability-profile-store'

type RemoteLocation = { hostProfileId: string; canonicalRoot: string; projectOverride?: string }

type Dependencies = {
  getHostProfile?: (id: string, agentDir: string) => RemoteHostProfile | undefined
  readHostRoot?: (id: string, agentDir: string) => string | undefined
  readMicromambaStatus?: (
    hostAlias: string,
    projectRoot: string,
    agentDir: string
  ) => RemoteRuntimePromptContext['micromambaStatus']
  readMicromambaVersion?: () => string | undefined
}

export function resolveRemoteRuntimePromptContext(
  location: RemoteLocation,
  agentDir: string,
  dependencies: Dependencies = {}
): RemoteRuntimePromptContext {
  const profile = (dependencies.getHostProfile ?? getRemoteHostProfile)(
    location.hostProfileId,
    agentDir
  )
  const hostOverride = (dependencies.readHostRoot ?? readHostRuntimeRoot)(
    location.hostProfileId,
    agentDir
  )
  const root = resolveRemoteRuntimeRoot({
    ...(location.projectOverride ? { projectOverride: location.projectOverride } : {}),
    hostOverride
  })
  const micromambaStatus = profile
    ? (dependencies.readMicromambaStatus ?? cachedMicromambaStatus)(
        profile.hostAlias,
        location.canonicalRoot,
        agentDir
      )
    : 'unchecked'
  const rootLabel = remoteRuntimeRootLabel(root.configured)
  const micromambaVersion = (dependencies.readMicromambaVersion ?? currentRemoteMicromambaVersion)()
  return {
    rootLabel,
    source: root.source,
    micromambaStatus,
    ...(micromambaVersion
      ? { micromambaPathLabel: remoteMicromambaPath(rootLabel, micromambaVersion) }
      : {})
  }
}

export function remoteRuntimeRootLabel(
  configured: string
): RemoteRuntimePromptContext['rootLabel'] {
  return configured.startsWith('~/') ? (configured as `~/${string}`) : '$PHI_REMOTE_RUNTIME_ROOT'
}

function cachedMicromambaStatus(
  hostAlias: string,
  projectRoot: string,
  agentDir: string
): RemoteRuntimePromptContext['micromambaStatus'] {
  const status = readCapabilityProfile({ hostAlias, projectRoot }, { agentDir })?.runtimeRoot
    ?.micromamba?.status
  if (
    status === 'installed' ||
    status === 'not-installed' ||
    status === 'outdated' ||
    status === 'unusable'
  ) {
    return status
  }
  return 'unchecked'
}
