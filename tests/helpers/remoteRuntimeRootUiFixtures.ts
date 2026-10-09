import type { RemoteRuntimeRootCheckResult } from '../../src/shared/remoteRuntimeRootTypes'
import type { WrapperExecutionTargetDialogActions } from '../../src/renderer/src/features/wrapper/components/WrapperExecutionTargetDialog'
import type { Project, RemoteHostProfile } from '../../src/renderer/src/types'
import type { RemoteDoctorUiState } from '../../src/renderer/src/features/wrapper/lib/remoteDoctorUi'

export const HOST: RemoteHostProfile = {
  id: 'host-1',
  label: 'GPU',
  hostAlias: 'gpu',
  runtimeRoot: '/host/runtime'
}

export const AVAILABLE = { state: 'available' as const }
export const CAPABILITY_PROFILE = {
  platform: { os: 'linux', arch: 'x86_64' },
  probedAt: '2026-10-09T00:00:00.000Z',
  fs: AVAILABLE,
  exec: AVAILABLE,
  background: AVAILABLE,
  pty: AVAILABLE,
  watch: AVAILABLE,
  forwardPort: AVAILABLE,
  toolchain: {
    git: AVAILABLE,
    nextflow: AVAILABLE,
    java: AVAILABLE,
    conda: AVAILABLE,
    sbatch: AVAILABLE,
    containerRuntime: AVAILABLE,
    module: AVAILABLE
  }
}

export function remoteProject(runtimeRoot?: string): Project {
  return {
    id: 'project-1',
    name: 'Remote project',
    location: {
      kind: 'ssh',
      hostProfileId: HOST.id,
      remoteRoot: '/cluster/project',
      canonicalRoot: '/cluster/project'
    },
    workingDirectory: '/cluster/project',
    workingDirectoryRealPath: '/cluster/project',
    permissionMode: 'auto',
    pathAvailable: true,
    createdAt: '2026-10-09T00:00:00.000Z',
    ...(runtimeRoot
      ? {
          defaultRemoteConnectionId: 'connection-1',
          remoteConnections: [
            { id: 'connection-1', label: HOST.label, hostProfileId: HOST.id, runtimeRoot }
          ]
        }
      : {})
  }
}

export function runtimeCheck(
  patch: Partial<RemoteRuntimeRootCheckResult> = {}
): RemoteRuntimeRootCheckResult {
  return {
    configured: '/data/runtime',
    checkedAt: '2026-10-09T00:00:00.000Z',
    status: 'checked',
    expandedPath: '/data/runtime',
    exists: true,
    nearestExistingAncestor: '/data/runtime',
    ancestorWritable: true,
    ownedByCurrentUser: true,
    groupOrOtherWritable: false,
    hasSymlink: false,
    fsType: 'ext4',
    availableKiB: 1024,
    diskUsePercent: 10,
    inodeUsePercent: 8,
    executable: true,
    sharedFilesystem: false,
    computeNodeVisibility: 'unknown',
    hardErrors: [],
    warnings: [],
    ...patch
  }
}

export function runtimeDoctorState(
  key: string,
  check: RemoteRuntimeRootCheckResult,
  ok = true
): RemoteDoctorUiState {
  return {
    phase: 'done',
    key,
    report: {
      hostProfileId: HOST.id,
      checkedAt: '2026-10-09T00:00:00.000Z',
      ok,
      checks: [],
      runtimeRootCheck: check
    }
  }
}

const noop = (): void => undefined

export const DIALOG_ACTIONS: WrapperExecutionTargetDialogActions = {
  chooseConnection: noop,
  setHostProfileId: noop,
  setRemoteRoot: noop,
  setRuntimeRootOverride: noop,
  setHpc: noop,
  setLocalInputRoot: noop,
  setRemoteInputRoot: noop,
  close: noop,
  save: noop,
  checkEnvironment: noop,
  checkRuntimeRoot: noop,
  confirmRuntimeRootWarnings: noop,
  installNextflow: noop
}
