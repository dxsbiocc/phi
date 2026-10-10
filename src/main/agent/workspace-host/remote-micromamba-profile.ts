import type {
  RemoteMicromambaCapabilityProfile,
  RemoteRipgrepCapabilityProfile,
  RemoteRuntimeRootCapabilityProfile,
  RemoteRuntimeRootCheckResult,
  RemoteRuntimeRootSource
} from '../../../shared/remoteRuntimeRootTypes'
import type { RemoteMicromambaStatusResult } from '../../../shared/remoteMicromambaTypes'
import {
  describeRemoteMicromambaArtifact,
  remoteMicromambaManifestVersion
} from '../remote-micromamba-artifact'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { readLatestCapabilityProfileForHost } from './capability-profile-store'
import { reconcileRemoteHelperProfile } from './helper-installer'
import { getRemoteMicromambaStatus } from './remote-micromamba'
import { getRemoteRipgrepStatus } from './remote-ripgrep'
import type { ProbedHostCapabilityProfile } from './probe-parse'
import { runtimeRootCapabilityProfile } from './runtime-root-profile'
import type { HostCapabilityProfile } from './types'

export type MicromambaProfileResolver = (
  session: RemoteSshSession,
  runtimeRoot: string,
  platform: HostCapabilityProfile['platform']
) => Promise<RemoteMicromambaCapabilityProfile | undefined>

export type RipgrepProfileResolver = (
  session: RemoteSshSession,
  runtimeRoot: string
) => Promise<RemoteRipgrepCapabilityProfile | undefined>

function installedVersion(
  status: RemoteMicromambaStatusResult,
  expectedVersion: string
): string | undefined {
  return status.status === 'installed' ? expectedVersion : status.installedVersions.at(-1)
}

function preserveDownloadCapability(
  current: RemoteMicromambaCapabilityProfile | undefined,
  previous: RemoteMicromambaCapabilityProfile | undefined
): RemoteMicromambaCapabilityProfile | undefined {
  if (!current || current.download || !previous?.download) return current
  return { ...current, download: previous.download }
}

async function defaultMicromambaProfile(
  session: RemoteSshSession,
  runtimeRoot: string,
  platform: HostCapabilityProfile['platform']
): Promise<RemoteMicromambaCapabilityProfile | undefined> {
  try {
    const expected = describeRemoteMicromambaArtifact(platform)
    const status = await getRemoteMicromambaStatus(session, runtimeRoot, {
      expectedVersion: expected.version,
      platform: expected.platform
    })
    if (status.status === 'not-installed') return { status: 'not-installed' }
    if (status.status === 'failed' || status.status === 'unchecked') return undefined
    const version = installedVersion(status, expected.version)
    return version ? { status: status.status, version } : undefined
  } catch {
    return undefined
  }
}

async function defaultRipgrepProfile(
  session: RemoteSshSession,
  runtimeRoot: string
): Promise<RemoteRipgrepCapabilityProfile | undefined> {
  const result = await getRemoteRipgrepStatus(session, runtimeRoot)
  if (result.status === 'not-installed') return { status: 'not-installed' }
  if ((result.status === 'system' || result.status === 'managed') && result.version) {
    return { status: result.status, version: result.version }
  }
  return undefined
}

export function currentRemoteMicromambaVersion(): string | undefined {
  try {
    return remoteMicromambaManifestVersion()
  } catch {
    return undefined
  }
}

export async function runtimeRootProfileWithMicromamba(input: {
  session: RemoteSshSession
  configuredRoot: string
  source: RemoteRuntimeRootSource
  platform: HostCapabilityProfile['platform']
  check: RemoteRuntimeRootCheckResult
  previous?: RemoteMicromambaCapabilityProfile
  previousRipgrep?: RemoteRipgrepCapabilityProfile
  resolve?: MicromambaProfileResolver
  resolveRipgrep?: RipgrepProfileResolver
}): Promise<RemoteRuntimeRootCapabilityProfile> {
  const usableRoot = input.check.status === 'checked' && input.check.hardErrors.length === 0
  let resolved = input.previous
  let ripgrep = input.previousRipgrep
  if (usableRoot) {
    resolved = await (input.resolve ?? defaultMicromambaProfile)(
      input.session,
      input.configuredRoot,
      input.platform
    )
    ripgrep = await (input.resolveRipgrep ?? defaultRipgrepProfile)(
      input.session,
      input.configuredRoot
    )
  }
  const micromamba = preserveDownloadCapability(resolved, input.previous)
  return runtimeRootCapabilityProfile(
    input.source,
    input.check,
    micromamba ?? input.previous ?? { status: 'unchecked' },
    ripgrep ?? input.previousRipgrep ?? { status: 'unchecked' }
  )
}

export async function connectionProfileWithMicromamba(input: {
  session: RemoteSshSession
  hostAlias: string
  configuredRoot: string
  source: RemoteRuntimeRootSource
  check: RemoteRuntimeRootCheckResult
  agentDir: string
  resolve?: MicromambaProfileResolver
}): Promise<ProbedHostCapabilityProfile | undefined> {
  const latest = readLatestCapabilityProfileForHost(input.hostAlias, {
    agentDir: input.agentDir,
    expectedMicromambaVersion: currentRemoteMicromambaVersion()
  })
  if (!latest) return undefined
  const runtimeRoot = await runtimeRootProfileWithMicromamba({
    ...input,
    platform: latest.platform,
    previous: latest.runtimeRoot?.micromamba,
    previousRipgrep: latest.runtimeRoot?.ripgrep
  })
  return reconcileRemoteHelperProfile({ ...latest, runtimeRoot })
}
