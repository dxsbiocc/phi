import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { readManifestFile } from '../../session/manifest-file'
import type { PhiSessionManifest } from '../../session/session-store'
import type { RemoteOmpRuntimeRef, RemoteOmpScope } from '../../session/runtime-reference'

export const OLD_REMOTE_PROCESS_REASON = 'old remote process still owns the session'

export interface RemoteHistoryIdentity extends RemoteOmpScope {
  readonly phiSessionId: string
  readonly durableSessionKey: string
  readonly ompSessionId: string
  readonly journalBasename: string
}

export type RemoteHolderState = 'gone' | 'held' | 'unprovable'

export interface RemoteHistoryProbeResult {
  readonly identity: RemoteHistoryIdentity
  readonly sourcePath: string
  /** Header and digest are measured from the exact private copy at sourcePath. */
  readonly sourceSize: number
  readonly sourceSha256: string
  readonly sourceOmpSessionId: string
  readonly sourceCwd: string
  readonly writer: RemoteHolderState
  readonly runLock: RemoteHolderState
  /** RPC-only evidence is retained for diagnostics, never execution authority. */
  readonly diagnostics?: unknown
}

export type KernelHistoryPlan =
  | {
      readonly action: 'adopt-local'
      readonly reason: string
      readonly status: 'ready'
      readonly phiSessionId: string
      readonly source: {
        readonly kind: 'omp-journal'
        readonly path: string
        readonly cwd: string
        readonly origin: 'desktop-local'
        readonly phiSessionId: string
      }
    }
  | {
      readonly action: 'adopt-remote'
      readonly reason: string
      readonly status: 'ready'
      readonly phiSessionId: string
      readonly source: {
        readonly kind: 'omp-journal'
        readonly path: string
        readonly cwd: string
        readonly origin: 'rpc-remote'
        readonly phiSessionId: string
        readonly expected: { readonly sha256: string; readonly size: number }
      }
      readonly runtimeRef: RemoteOmpRuntimeRef
      readonly rpcDiagnostics?: unknown
    }
  | {
      readonly action: 'read-only'
      readonly reason: string
      readonly status: 'read-only' | 'unknown'
      readonly phiSessionId: string
      readonly error?: PhiSessionManifest['runtimeRecoveryError']
    }

export interface PureKernelHistoryPlanInput {
  readonly manifest: PhiSessionManifest
  readonly localJournalReadable?: boolean
  readonly expectedRemoteScope?: RemoteOmpScope
  readonly remoteProbe?: RemoteHistoryProbeResult
  readonly remoteProbeFailed?: boolean
}

function interruptedStatus(manifest: PhiSessionManifest): 'read-only' | 'unknown' {
  return manifest.lastRunOutcome === 'interrupted' ||
    manifest.status === 'running' ||
    Boolean(manifest.currentRunId)
    ? 'unknown'
    : 'read-only'
}

function readOnly(
  manifest: PhiSessionManifest,
  reason: string,
  options: {
    readonly oldRemoteOwner?: boolean
    readonly error?: PhiSessionManifest['runtimeRecoveryError']
  } = {}
): KernelHistoryPlan {
  return {
    action: 'read-only',
    reason,
    status: options.oldRemoteOwner ? interruptedStatus(manifest) : 'read-only',
    phiSessionId: manifest.sessionId,
    ...(options.error ? { error: options.error } : {})
  }
}

function matchesScope(ref: RemoteOmpRuntimeRef, scope: RemoteOmpScope): boolean {
  return (
    ref.hostProfileId === scope.hostProfileId &&
    ref.bindingHash === scope.bindingHash &&
    ref.projectId === scope.projectId &&
    ref.projectRoot === scope.projectRoot &&
    ref.runtimeRoot === scope.runtimeRoot
  )
}

function matchesProbeIdentity(
  manifest: PhiSessionManifest,
  ref: RemoteOmpRuntimeRef,
  identity: RemoteHistoryIdentity
): boolean {
  return (
    matchesScope(ref, identity) &&
    identity.phiSessionId === manifest.sessionId &&
    identity.durableSessionKey === ref.durableSessionKey &&
    identity.ompSessionId === ref.ompSessionId &&
    identity.journalBasename === ref.journalBasename
  )
}

function matchesRemoteSourceProof(
  manifest: PhiSessionManifest,
  ref: RemoteOmpRuntimeRef,
  probe: RemoteHistoryProbeResult
): boolean {
  return (
    Number.isSafeInteger(probe.sourceSize) &&
    probe.sourceSize >= 0 &&
    /^[a-f0-9]{64}$/u.test(probe.sourceSha256) &&
    probe.sourceOmpSessionId === ref.ompSessionId &&
    probe.sourceCwd === manifest.cwd
  )
}

function planRemoteHistory(
  manifest: PhiSessionManifest,
  ref: RemoteOmpRuntimeRef,
  input: PureKernelHistoryPlanInput
): KernelHistoryPlan {
  if (!input.expectedRemoteScope || !matchesScope(ref, input.expectedRemoteScope)) {
    return readOnly(manifest, 'remote session identity is inconsistent')
  }
  if (input.remoteProbeFailed || !input.remoteProbe) {
    return readOnly(manifest, OLD_REMOTE_PROCESS_REASON, { oldRemoteOwner: true })
  }
  if (!matchesProbeIdentity(manifest, ref, input.remoteProbe.identity)) {
    return readOnly(manifest, 'remote session identity is inconsistent')
  }
  if (!matchesRemoteSourceProof(manifest, ref, input.remoteProbe)) {
    return readOnly(manifest, 'remote journal identity is inconsistent')
  }
  if (input.remoteProbe.writer !== 'gone' || input.remoteProbe.runLock !== 'gone') {
    return readOnly(manifest, OLD_REMOTE_PROCESS_REASON, { oldRemoteOwner: true })
  }
  return {
    action: 'adopt-remote',
    reason: 'remote identity is verified and the old writer is gone',
    status: 'ready',
    phiSessionId: manifest.sessionId,
    source: {
      kind: 'omp-journal',
      path: input.remoteProbe.sourcePath,
      cwd: manifest.cwd,
      origin: 'rpc-remote',
      phiSessionId: manifest.sessionId,
      expected: {
        sha256: input.remoteProbe.sourceSha256,
        size: input.remoteProbe.sourceSize
      }
    },
    runtimeRef: ref,
    ...(input.remoteProbe.diagnostics === undefined
      ? {}
      : { rpcDiagnostics: input.remoteProbe.diagnostics })
  }
}

/** Pure decision table. Filesystem and remote observations are supplied as immutable facts. */
export function planKernelHistory(input: PureKernelHistoryPlanInput): KernelHistoryPlan {
  const { manifest } = input
  if (manifest.runtimeRecoveryError) {
    return readOnly(manifest, manifest.runtimeRecoveryError.message, {
      error: manifest.runtimeRecoveryError
    })
  }

  const ref = manifest.runtimeRef
  if (ref) return planRemoteHistory(manifest, ref, input)

  if (manifest.projectLocation?.kind === 'ssh') {
    return readOnly(manifest, 'legacy SSH sessions remain read-only')
  }

  if (manifest.runtimeSessionPath && input.localJournalReadable) {
    return {
      action: 'adopt-local',
      reason: 'local runtime journal is readable',
      status: 'ready',
      phiSessionId: manifest.sessionId,
      source: {
        kind: 'omp-journal',
        path: manifest.runtimeSessionPath,
        cwd: manifest.cwd,
        origin: 'desktop-local',
        phiSessionId: manifest.sessionId
      }
    }
  }

  return readOnly(
    manifest,
    manifest.runtimeSessionPath
      ? 'local runtime journal is not readable'
      : 'session has no adoptable runtime journal'
  )
}

async function readableRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export interface ReadAndPlanKernelHistoryInput {
  readonly phiSessionDirectory: string
  readonly phiSessionId: string
  readonly expectedRemoteScope?: RemoteOmpScope
  readonly probeRemoteOwnership?: (
    ref: RemoteOmpRuntimeRef,
    manifest: PhiSessionManifest
  ) => Promise<RemoteHistoryProbeResult>
  /** Injectable only to keep the decision table deterministic in tests. */
  readonly localJournalReadable?: (path: string) => Promise<boolean>
}

/** Read through Phi's canonical parser, then collect only the facts needed by the pure planner. */
export async function readAndPlanKernelHistory(
  input: ReadAndPlanKernelHistoryInput
): Promise<KernelHistoryPlan> {
  const manifest = readManifestFile(
    join(input.phiSessionDirectory, 'manifest.json'),
    input.phiSessionId
  )
  if (manifest.runtimeRef) {
    if (
      !input.expectedRemoteScope ||
      !matchesScope(manifest.runtimeRef, input.expectedRemoteScope)
    ) {
      return planKernelHistory({
        manifest,
        ...(input.expectedRemoteScope ? { expectedRemoteScope: input.expectedRemoteScope } : {}),
        remoteProbeFailed: true
      })
    }
    if (!input.probeRemoteOwnership) {
      return planKernelHistory({
        manifest,
        ...(input.expectedRemoteScope ? { expectedRemoteScope: input.expectedRemoteScope } : {}),
        remoteProbeFailed: true
      })
    }
    try {
      const remoteProbe = await input.probeRemoteOwnership(manifest.runtimeRef, manifest)
      return planKernelHistory({
        manifest,
        ...(input.expectedRemoteScope ? { expectedRemoteScope: input.expectedRemoteScope } : {}),
        remoteProbe
      })
    } catch {
      return planKernelHistory({
        manifest,
        ...(input.expectedRemoteScope ? { expectedRemoteScope: input.expectedRemoteScope } : {}),
        remoteProbeFailed: true
      })
    }
  }
  const localJournalReadable = manifest.runtimeSessionPath
    ? await (input.localJournalReadable ?? readableRegularFile)(manifest.runtimeSessionPath)
    : false
  return planKernelHistory({ manifest, localJournalReadable })
}
