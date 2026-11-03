import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import type { RemoteNextflowInstallResult } from '../../shared/remoteDoctorTypes'
import { remoteMicromambaPath } from '../../shared/remoteMicromambaTypes'
import { readHostRuntimeRoot } from './remote-runtime-root-store'
import { resolveRemoteRuntimeRoot } from './remote-runtime-root'
import { getPhiAgentDir } from './runtime-paths'
import type { ConnectImpl } from './wrappers/executor-remote'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'
import { buildRemoteMicromambaShellCommand } from './workspace-host/remote-micromamba-command'
import { currentRemoteMicromambaVersion } from './workspace-host/remote-micromamba-profile'
import { checkRemoteRuntimeRoot } from './workspace-host/runtime-root-check'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const NEXTFLOW_ENVIRONMENT_NAME = 'phi-nextflow'

export function buildRemoteNextflowEnvironmentCommand(input: {
  micromambaPath: string
  runtimeRoot: string
  prefix: string
}): string {
  return buildRemoteMicromambaShellCommand({
    binary: input.micromambaPath,
    runtimeRoot: input.runtimeRoot,
    subcommand: 'create',
    args: [
      '--yes',
      '--prefix',
      input.prefix,
      '--channel',
      'conda-forge',
      '--channel',
      'bioconda',
      'nextflow',
      'openjdk>=17'
    ]
  })
}

export interface RemoteNextflowInstallDependencies {
  agentDir?: string
  connectImpl?: ConnectImpl
  micromambaVersion?: string
  resolveRuntimeRoot?: (
    session: RemoteSshSession,
    hostProfileId: string,
    agentDir: string
  ) => Promise<string>
}

async function defaultRuntimeRoot(
  session: RemoteSshSession,
  hostProfileId: string,
  agentDir: string
): Promise<string> {
  const configured = resolveRemoteRuntimeRoot({
    hostOverride: readHostRuntimeRoot(hostProfileId, agentDir)
  }).configured
  const check = await checkRemoteRuntimeRoot(session, configured)
  if (check.status !== 'checked' || !check.expandedPath || check.hardErrors.length > 0) {
    throw new Error(
      'The Phi runtime root is unavailable on this server. Check Remote Hosts settings before installing Nextflow.'
    )
  }
  return check.expandedPath
}

function environmentReadyCommand(prefix: string): string {
  const nextflow = `${prefix}/bin/nextflow`
  const java = `${prefix}/bin/java`
  return `bash -lc ${shellQuote(
    [
      `test -x ${shellQuote(nextflow)}`,
      `test -x ${shellQuote(java)}`,
      `NXF_DISABLE_CHECK_LATEST=true NXF_ANSI_LOG=false ${shellQuote(nextflow)} -version >/dev/null 2>&1`,
      `${shellQuote(java)} -version >/dev/null 2>&1`
    ].join(' && ')
  )}`
}

/** Create/reuse Nextflow and Java in Phi's isolated micromamba runtime. */
export async function installRemoteNextflow(
  hostProfileId: string,
  dependencies: RemoteNextflowInstallDependencies = {}
): Promise<RemoteNextflowInstallResult> {
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const profile = getRemoteHostProfile(hostProfileId, agentDir)
  if (!profile) throw new Error('SSH server profile not found. Select the server again.')
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  const session = await connect({
    ...remoteConnectionConfigForProfile(profile),
    execTimeoutMs: INSTALL_TIMEOUT_MS
  })
  try {
    const runtimeRoot = await (dependencies.resolveRuntimeRoot ?? defaultRuntimeRoot)(
      session,
      hostProfileId,
      agentDir
    )
    const micromambaVersion = dependencies.micromambaVersion ?? currentRemoteMicromambaVersion()
    if (!micromambaVersion) throw new Error('The bundled remote micromamba version is unavailable.')
    const prefix = `${runtimeRoot}/envs/${NEXTFLOW_ENVIRONMENT_NAME}`
    const path = `${prefix}/bin/nextflow`
    const ready = environmentReadyCommand(prefix)
    const existing = await session.exec(ready)
    if (existing.code === 0) return { path, alreadyInstalled: true }

    const created = await session.exec(
      buildRemoteNextflowEnvironmentCommand({
        micromambaPath: remoteMicromambaPath(runtimeRoot, micromambaVersion),
        runtimeRoot,
        prefix
      })
    )
    if (created.code !== 0) {
      throw new Error(
        'The Phi-managed Nextflow environment could not be created. Check the remote runtime root, micromamba, and server package access.'
      )
    }
    const verified = await session.exec(ready)
    if (verified.code !== 0) {
      throw new Error(
        'The Phi-managed Nextflow environment was created but Nextflow or Java could not be verified.'
      )
    }
    return { path, alreadyInstalled: false }
  } finally {
    await session.close().catch(() => undefined)
  }
}
