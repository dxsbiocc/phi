import { spawnSync } from 'node:child_process'
import type {
  RemoteDoctorCheck,
  RemoteDoctorOptions,
  RemoteDoctorReport,
  RemoteDoctorStatus
} from '../../shared/remoteDoctorTypes'
import type { RemoteRuntimeRootCheckResult } from '../../shared/remoteRuntimeRootTypes'
import { selectedRemoteDoctorRuntimeRoot } from './remote-doctor-runtime-root'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from './remote-hosts'
import { readHostRuntimeRoot } from './remote-runtime-root-store'
import { getPhiAgentDir } from './runtime-paths'
import {
  getCapabilityProfile,
  saveCapabilityProfile
} from './workspace-host/capability-profile-store'
import { capabilityToolchainChecks } from './workspace-host/capability-toolchain-checks'
import { reconcileRemoteHelperProfile } from './workspace-host/helper-installer'
import {
  connectionProfileWithMicromamba,
  currentRemoteMicromambaVersion,
  runtimeRootProfileWithMicromamba,
  type MicromambaProfileResolver
} from './workspace-host/remote-micromamba-profile'
import { checkRemoteRuntimeRoot } from './workspace-host/runtime-root-check'
import type { ConnectImpl } from './wrappers/executor-remote'
import {
  diagnoseSshConnectionFailure,
  RemoteSshConnectionError,
  sshConnectionDiagnosis
} from './wrappers/remote-ssh-diagnostics'
import {
  connectRemoteSshSession,
  shellQuote,
  type RemoteSshSession
} from './wrappers/remote-ssh-session'

const CHECK_TIMEOUT_MS = 5_000
const CONNECT_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 30_000

export interface RemoteDoctorDependencies {
  agentDir?: string
  connectImpl?: ConnectImpl
  userInitiated?: boolean
  sftpAvailable?: () => boolean
  checkTimeoutMs?: number
  connectTimeoutMs?: number
  probeTimeoutMs?: number
  runtimeRootTimeoutMs?: number
  micromambaProfile?: MicromambaProfileResolver
  now?: () => Date
  /** Tool checks are repeated after saved setup at launch; Doctor never executes setup lines. */
  deferToolChecksToLaunch?: boolean
}

function systemSftpAvailable(): boolean {
  const result = spawnSync('sftp', ['-h'], { stdio: 'ignore', timeout: 2_000 })
  return !result.error
}

class DoctorTimeoutError extends Error {}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DoctorTimeoutError()), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizedOptions(input: unknown): RemoteDoctorOptions {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const rootOverride =
    value.runtimeRootOverride && typeof value.runtimeRootOverride === 'object'
      ? (value.runtimeRootOverride as Record<string, unknown>)
      : undefined
  return {
    ...(value.scope === 'connection' || value.scope === 'workspace' || value.scope === 'full'
      ? { scope: value.scope }
      : {}),
    ...(value.scheduler === 'local' || value.scheduler === 'slurm'
      ? { scheduler: value.scheduler }
      : {}),
    ...(value.controller === 'login' || value.controller === 'sbatch'
      ? { controller: value.controller }
      : {}),
    ...(value.runtime === 'singularity' || value.runtime === 'conda' || value.runtime === 'docker'
      ? { runtime: value.runtime }
      : {}),
    ...(typeof value.nextflowBin === 'string' && value.nextflowBin.trim().length <= 512
      ? { nextflowBin: value.nextflowBin.trim() }
      : {}),
    ...(typeof value.containerRuntimeBin === 'string' &&
    value.containerRuntimeBin.trim().length <= 512
      ? { containerRuntimeBin: value.containerRuntimeBin.trim() }
      : {}),
    ...(value.refreshCapabilities === true ? { refreshCapabilities: true } : {}),
    ...(rootOverride && (rootOverride.source === 'host' || rootOverride.source === 'project')
      ? {
          runtimeRootOverride: {
            source: rootOverride.source,
            ...(typeof rootOverride.configured === 'string'
              ? { configured: rootOverride.configured }
              : {})
          }
        }
      : {})
  }
}

function validRemotePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    path.length <= 4096 &&
    !/[\r\n\0]/.test(path)
  )
}

function report(
  hostProfileId: string,
  checks: RemoteDoctorCheck[],
  now: () => Date,
  capabilityProfile?: RemoteDoctorReport['capabilityProfile'],
  runtimeRootCheck?: RemoteRuntimeRootCheckResult
): RemoteDoctorReport {
  return {
    hostProfileId,
    checkedAt: now().toISOString(),
    ok: checks.every((check) => check.status !== 'error') && !runtimeRootCheck?.hardErrors.length,
    checks,
    ...(capabilityProfile ? { capabilityProfile } : {}),
    ...(runtimeRootCheck ? { runtimeRootCheck } : {})
  }
}

async function commandCheck(
  session: RemoteSshSession,
  timeoutMs: number,
  input: {
    id: string
    command: string
    success: string
    missing: string
    missingStatus: RemoteDoctorStatus
    suggestion: string
  }
): Promise<RemoteDoctorCheck> {
  try {
    const result = await bounded(session.exec(input.command), timeoutMs)
    return result.code === 0
      ? { id: input.id, status: 'ok', message: input.success }
      : {
          id: input.id,
          status: input.missingStatus,
          message: input.missing,
          suggestion: input.suggestion
        }
  } catch (error) {
    return {
      id: input.id,
      status: input.missingStatus,
      message:
        error instanceof DoctorTimeoutError
          ? 'Remote check timed out'
          : 'Remote check did not complete',
      suggestion: 'Check the SSH connection and server status, then retry.'
    }
  }
}

/** Read-only server and candidate-directory checks, usable before a project exists. */
export async function remoteDoctor(
  hostProfileId: string,
  remotePath?: string,
  options: RemoteDoctorOptions = {},
  dependencies: RemoteDoctorDependencies = {}
): Promise<RemoteDoctorReport> {
  const checks: RemoteDoctorCheck[] = []
  const now = dependencies.now ?? (() => new Date())
  const agentDir = dependencies.agentDir ?? getPhiAgentDir()
  const profile = getRemoteHostProfile(hostProfileId, agentDir)
  if (!profile) {
    checks.push({
      id: 'ssh',
      status: 'error',
      message: 'SSH server profile not found',
      suggestion: 'Add a server in remote settings, or select an existing profile again.'
    })
    return report(hostProfileId, checks, now)
  }

  const selected = normalizedOptions(options)
  const checkTimeoutMs = dependencies.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const connectTimeoutMs = dependencies.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const probeTimeoutMs = dependencies.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const runtimeRootTimeoutMs = dependencies.runtimeRootTimeoutMs ?? CHECK_TIMEOUT_MS
  const connect = dependencies.connectImpl ?? connectRemoteSshSession
  let session: RemoteSshSession
  try {
    session = await bounded(
      connect({
        ...remoteConnectionConfigForProfile(profile),
        readyTimeoutMs: connectTimeoutMs,
        execTimeoutMs: Math.max(checkTimeoutMs, probeTimeoutMs + 1_000),
        ...(dependencies.userInitiated ? { userInitiated: true } : {})
      }),
      connectTimeoutMs + 1_000
    )
  } catch (error) {
    const diagnosis =
      error instanceof RemoteSshConnectionError
        ? error.diagnosis
        : error instanceof DoctorTimeoutError
          ? sshConnectionDiagnosis('timeout')
          : diagnoseSshConnectionFailure(error)
    checks.push({
      id: 'ssh',
      status: 'error',
      message: diagnosis.message,
      suggestion: diagnosis.suggestion
    })
    return report(hostProfileId, checks, now)
  }

  checks.push({ id: 'ssh', status: 'ok', message: 'Non-interactive SSH connection succeeded' })
  try {
    const rootResolution = selectedRemoteDoctorRuntimeRoot(
      selected,
      readHostRuntimeRoot(hostProfileId, agentDir)
    )
    const runtimeRootCheck = await checkRemoteRuntimeRoot(session, rootResolution.configured, {
      timeoutMs: runtimeRootTimeoutMs,
      now
    })
    if (selected.scope === 'connection') {
      const withRuntimeRoot = await connectionProfileWithMicromamba({
        session,
        hostAlias: profile.hostAlias,
        configuredRoot: rootResolution.configured,
        source: rootResolution.source,
        check: runtimeRootCheck,
        agentDir,
        resolve: dependencies.micromambaProfile
      })
      return report(hostProfileId, checks, now, withRuntimeRoot, runtimeRootCheck)
    }
    checks.push(
      (dependencies.sftpAvailable ?? systemSftpAvailable)()
        ? { id: 'sftp', status: 'ok', message: 'System SFTP is available' }
        : {
            id: 'sftp',
            status: 'error',
            message: 'System SFTP is unavailable',
            suggestion: 'Ensure the system can run sftp; remote Wrapper uploads require it.'
          }
    )
    if (remotePath !== undefined) {
      if (!validRemotePath(remotePath)) {
        checks.push({
          id: 'path',
          status: 'error',
          message: 'The candidate directory must be an absolute remote path',
          suggestion: 'Enter a server directory path starting with /.'
        })
      } else {
        const directory = await commandCheck(session, checkTimeoutMs, {
          id: 'path',
          command: `test -d ${shellQuote(remotePath)}`,
          success: 'The candidate directory exists',
          missing: 'The candidate path is missing or is not a directory',
          missingStatus: 'error',
          suggestion: 'Check the absolute path on the server.'
        })
        checks.push(directory)
        if (directory.status === 'ok') {
          checks.push(
            await commandCheck(session, checkTimeoutMs, {
              id: 'path_read',
              command: `test -r ${shellQuote(remotePath)} && test -x ${shellQuote(remotePath)}`,
              success: 'The candidate directory can be read and entered',
              missing: 'The candidate directory cannot be read or entered',
              missingStatus: 'error',
              suggestion: 'Check read and execute permissions on the server directory.'
            })
          )
          checks.push(
            await commandCheck(session, checkTimeoutMs, {
              id: 'path_write',
              command: `test -w ${shellQuote(remotePath)}`,
              success: 'The candidate directory is writable',
              missing: 'The candidate directory is not writable',
              missingStatus: 'error',
              suggestion: 'Choose a writable working directory.'
            })
          )
        }
      }
    }

    const shell = await commandCheck(session, checkTimeoutMs, {
      id: 'shell',
      command: `bash -lc ${shellQuote('printf phi-doctor-ready')}`,
      success: 'Bash login shell is available',
      missing: 'Bash login shell is unavailable',
      missingStatus: 'error',
      suggestion: 'Ensure the login shell can start Bash; Wrapper preflight checks use Bash.'
    })
    checks.push(shell)
    if (shell.status !== 'ok') {
      return report(hostProfileId, checks, now, undefined, runtimeRootCheck)
    }
    const profileKey = remotePath
      ? { hostAlias: profile.hostAlias, projectRoot: remotePath }
      : undefined
    const detectedProfile =
      remotePath && validRemotePath(remotePath) && session.execWithInput
        ? await getCapabilityProfile(
            session,
            { hostAlias: profile.hostAlias, projectRoot: remotePath },
            {
              agentDir,
              refresh: selected.refreshCapabilities,
              expectedMicromambaVersion: currentRemoteMicromambaVersion(),
              timeoutMs: probeTimeoutMs,
              now
            }
          )
        : undefined
    const detectedWithRuntimeRoot =
      detectedProfile && rootResolution && runtimeRootCheck
        ? {
            ...detectedProfile,
            runtimeRoot: await runtimeRootProfileWithMicromamba({
              session,
              configuredRoot: rootResolution.configured,
              source: rootResolution.source,
              platform: detectedProfile.platform,
              check: runtimeRootCheck,
              previous: detectedProfile.runtimeRoot?.micromamba,
              resolve: dependencies.micromambaProfile
            })
          }
        : detectedProfile
    if (detectedWithRuntimeRoot && profileKey) {
      saveCapabilityProfile(profileKey, detectedWithRuntimeRoot, agentDir)
    }
    const capabilityProfile =
      detectedWithRuntimeRoot && profileKey
        ? reconcileRemoteHelperProfile(detectedWithRuntimeRoot, { profileKey, agentDir })
        : detectedWithRuntimeRoot
    if (selected.scope === 'workspace') {
      return report(hostProfileId, checks, now, capabilityProfile, runtimeRootCheck)
    }

    const deferTools = dependencies.deferToolChecksToLaunch === true
    checks.push(
      ...(await capabilityToolchainChecks({
        profile: capabilityProfile,
        options: selected,
        deferTools,
        run: (input) => commandCheck(session, checkTimeoutMs, input)
      }))
    )
    return report(hostProfileId, checks, now, capabilityProfile, runtimeRootCheck)
  } finally {
    await bounded(session.close(), 3_000).catch(() => undefined)
  }
}
