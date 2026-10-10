import type { RemoteRuntimePromptContext } from './main-system-prompt'
import { getRemoteHostProfile, type RemoteHostProfile } from './remote-hosts'
import { resolveRemoteRuntimeRoot } from './remote-runtime-root'
import { readHostRuntimeRoot } from './remote-runtime-root-store'
import { readCapabilityProfile } from './workspace-host/capability-profile-store'

type RemoteLocation = { hostProfileId: string; canonicalRoot: string }

type Dependencies = {
  getHostProfile?: (id: string, agentDir: string) => RemoteHostProfile | undefined
  readHostRoot?: (id: string, agentDir: string) => string | undefined
  readMicromambaStatus?: (
    hostAlias: string,
    projectRoot: string,
    agentDir: string
  ) => RemoteRuntimePromptContext['micromambaStatus']
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
  const root = resolveRemoteRuntimeRoot({ hostOverride })
  const micromambaStatus = profile
    ? (dependencies.readMicromambaStatus ?? cachedMicromambaStatus)(
        profile.hostAlias,
        location.canonicalRoot,
        agentDir
      )
    : 'unchecked'
  return {
    rootLabel: remoteRuntimeRootLabel(root.configured),
    source: root.source,
    micromambaStatus
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
