import type { Dispatch, SetStateAction } from 'react'

import type {
  RemoteDoctorOptions,
  RemoteNextflowInstallResult
} from '../../../../../shared/remoteDoctorTypes'
import type { ResolvedRemoteRuntimeRoot } from '../../../../../shared/remoteRuntimeRootTypes'
import type { Project, ProjectRemoteConnection, RemoteHostProfile } from '../../../types'
import type { WrapperExecutionTargetDialogModel } from '../components/WrapperExecutionTargetDialog'
import {
  EMPTY_HPC_DRAFT,
  hpcDraftError,
  hpcDraftFromSettings,
  hpcSettingsFromDraft,
  type HpcDraft
} from './remoteHpcDraft'
import type { RemoteDoctorUiState } from './remoteDoctorUi'
import {
  normalizeRemoteRuntimeRootValue,
  remoteRuntimeRootUiStatus,
  remoteRuntimeRootValueError,
  runtimeRootHasHardErrors,
  runtimeRootNeedsWarningConfirmation
} from './remoteRuntimeRootUi'

export type InstallStatus = { message: string; severity: 'success' | 'error' } | null

export interface ControllerState {
  open: boolean
  hosts: RemoteHostProfile[]
  loading: boolean
  saving: boolean
  error: string | null
  connectionId: string
  hostProfileId: string
  remoteRoot: string
  runtimeRootOverride: string
  runtimeRootConfirmedKey: string | null
  hpc: HpcDraft
  localInputRoot: string
  remoteInputRoot: string
  environmentState: RemoteDoctorUiState
  installConfirmOpen: boolean
  installing: boolean
  installStatus: InstallStatus
}

export interface DerivedState {
  isRemoteProject: boolean
  boundHostProfileId?: string
  boundHostAvailable: boolean
  connections: ProjectRemoteConnection[]
  selected?: ProjectRemoteConnection
  configured?: ProjectRemoteConnection
  environmentKey: string
  checkingEnvironment: boolean
  environmentReport: WrapperExecutionTargetDialogModel['environmentReport']
}

export const INITIAL_CONTROLLER_STATE: ControllerState = {
  open: false,
  hosts: [],
  loading: false,
  saving: false,
  error: null,
  connectionId: '',
  hostProfileId: '',
  remoteRoot: '',
  runtimeRootOverride: '',
  runtimeRootConfirmedKey: null,
  hpc: EMPTY_HPC_DRAFT,
  localInputRoot: '',
  remoteInputRoot: '',
  environmentState: { phase: 'idle' },
  installConfirmOpen: false,
  installing: false,
  installStatus: null
}

export function patchControllerState(
  setState: Dispatch<SetStateAction<ControllerState>>,
  patch: Partial<ControllerState>
): void {
  setState((current) => ({ ...current, ...patch }))
}

export function executionTargetEnvironmentKey(state: ControllerState, nextflowBin: string): string {
  return JSON.stringify([
    state.hostProfileId,
    state.remoteRoot.trim(),
    normalizeRemoteRuntimeRootValue(state.runtimeRootOverride) ?? null,
    state.hpc.scheduler,
    state.hpc.controller,
    state.hpc.runtime,
    nextflowBin.trim()
  ])
}

export function runtimeRootResolutionForController(
  state: ControllerState
): ResolvedRemoteRuntimeRoot {
  const projectOverride = normalizeRemoteRuntimeRootValue(state.runtimeRootOverride)
  if (projectOverride) return { source: 'project', configured: projectOverride }
  const hostOverride = state.hosts.find((host) => host.id === state.hostProfileId)?.runtimeRoot
  if (hostOverride) return { source: 'host', configured: hostOverride }
  return { source: 'default', configured: '~/.phi/runtime' }
}

export function runtimeRootCandidateKey(state: ControllerState): string {
  return JSON.stringify([
    state.hostProfileId,
    normalizeRemoteRuntimeRootValue(state.runtimeRootOverride) ?? null,
    state.hosts.find((host) => host.id === state.hostProfileId)?.runtimeRoot ?? null
  ])
}

export function executionTargetDoctorOptions(
  hpc: HpcDraft,
  nextflowBin = hpc.nextflowBin,
  runtimeRootOverride?: string
): RemoteDoctorOptions {
  return {
    scope: 'full',
    scheduler: hpc.scheduler,
    controller: hpc.controller,
    runtime: hpc.runtime,
    refreshCapabilities: true,
    runtimeRootOverride: {
      source: 'project',
      ...(normalizeRemoteRuntimeRootValue(runtimeRootOverride ?? '')
        ? { configured: normalizeRemoteRuntimeRootValue(runtimeRootOverride ?? '') }
        : {})
    },
    ...(nextflowBin.trim() ? { nextflowBin: nextflowBin.trim() } : {})
  } as RemoteDoctorOptions
}

export function deriveControllerState(project: Project, state: ControllerState): DerivedState {
  const isRemoteProject = project.location.kind === 'ssh'
  const boundHostProfileId =
    project.location.kind === 'ssh' ? project.location.hostProfileId : undefined
  const connections = project.remoteConnections ?? []
  const selected = connections.find((item) => item.id === state.connectionId)
  const configured = boundHostProfileId
    ? (connections.find(
        (item) =>
          item.id === project.defaultRemoteConnectionId && item.hostProfileId === boundHostProfileId
      ) ?? connections.find((item) => item.hostProfileId === boundHostProfileId))
    : connections.find((item) => item.id === project.defaultRemoteConnectionId)
  const environmentKey = executionTargetEnvironmentKey(state, state.hpc.nextflowBin)
  const environmentReport =
    state.environmentState.phase === 'done' && state.environmentState.key === environmentKey
      ? state.environmentState.report
      : null
  return {
    isRemoteProject,
    boundHostProfileId,
    boundHostAvailable: state.hosts.some((host) => host.id === boundHostProfileId),
    connections,
    selected,
    configured,
    environmentKey,
    checkingEnvironment:
      state.environmentState.phase === 'running' && state.environmentState.key === environmentKey,
    environmentReport
  }
}

export function installedControllerPatch(
  result: RemoteNextflowInstallResult,
  key: string
): Partial<ControllerState> {
  return {
    installStatus: {
      severity: 'success',
      message: result.alreadyInstalled
        ? `已发现 Nextflow：${result.path}。请保存运行方式。`
        : `Nextflow 已安装到 ${result.path}。请保存运行方式。`
    },
    environmentState: { phase: 'running', key }
  }
}

export function controllerConnectionPatch(
  connection: ProjectRemoteConnection | undefined,
  derived: DerivedState
): Partial<ControllerState> {
  return {
    connectionId: connection?.id ?? '',
    hostProfileId: derived.boundHostProfileId ?? connection?.hostProfileId ?? '',
    runtimeRootOverride: connection?.runtimeRoot ?? '',
    runtimeRootConfirmedKey: null,
    hpc: connection?.hpc
      ? hpcDraftFromSettings(connection.hpc)
      : derived.isRemoteProject
        ? { ...EMPTY_HPC_DRAFT, scheduler: 'local', controller: 'login' }
        : EMPTY_HPC_DRAFT,
    localInputRoot: connection?.inputPathMapping?.localRoot ?? '',
    remoteInputRoot: connection?.inputPathMapping?.remoteRoot ?? ''
  }
}

export function controllerSaveError(state: ControllerState, derived: DerivedState): string | null {
  const root = state.remoteRoot.trim()
  const localRoot = state.localInputRoot.trim()
  const serverRoot = state.remoteInputRoot.trim()
  if (!state.hosts.some((item) => item.id === state.hostProfileId)) {
    return derived.isRemoteProject
      ? '项目绑定的 SSH 服务器已不可用，请先恢复服务器配置'
      : '请选择 SSH 服务器'
  }
  if (!root.startsWith('/') || /[\r\n\0]/.test(root)) return '服务器工作目录必须是绝对路径'
  const runtimeRootError = remoteRuntimeRootValueError(state.runtimeRootOverride)
  if (runtimeRootError) return runtimeRootError
  const runtimeStatus = remoteRuntimeRootUiStatus(state.environmentState, derived.environmentKey)
  if (runtimeStatus.phase === 'checked' && runtimeStatus.result.hardErrors.length > 0) {
    return runtimeStatus.result.hardErrors[0]?.message ?? '运行时根目录存在硬性错误'
  }
  if (
    runtimeRootNeedsWarningConfirmation(state.environmentState, derived.environmentKey) &&
    state.runtimeRootConfirmedKey !== runtimeRootCandidateKey(state)
  ) {
    return '运行时根目录存在提醒，请先点击“仍然使用”确认。'
  }
  if (!derived.isRemoteProject && Boolean(localRoot) !== Boolean(serverRoot)) {
    return '本机和服务器输入根目录需要同时填写'
  }
  if (!derived.isRemoteProject && localRoot && !localRoot.startsWith('/')) {
    return '本机输入根目录必须是绝对路径'
  }
  if (!derived.isRemoteProject && serverRoot && !serverRoot.startsWith('/')) {
    return '服务器输入根目录必须是绝对路径'
  }
  return hpcDraftError(state.hpc)
}

export function createControllerConnection(
  state: ControllerState,
  derived: DerivedState
): ProjectRemoteConnection {
  const host = state.hosts.find((item) => item.id === state.hostProfileId)!
  const localRoot = state.localInputRoot.trim()
  const serverRoot = state.remoteInputRoot.trim()
  return {
    id: derived.selected?.id ?? crypto.randomUUID(),
    label: derived.selected?.hostProfileId === host.id ? derived.selected.label : host.label,
    hostProfileId: host.id,
    ...(normalizeRemoteRuntimeRootValue(state.runtimeRootOverride)
      ? { runtimeRoot: normalizeRemoteRuntimeRootValue(state.runtimeRootOverride) }
      : {}),
    hpc: hpcSettingsFromDraft(state.hpc),
    ...(!derived.isRemoteProject && localRoot && serverRoot
      ? { inputPathMapping: { localRoot, remoteRoot: serverRoot } }
      : {})
  }
}

export function createExecutionTargetDialogModel(
  project: Project,
  state: ControllerState,
  derived: DerivedState
): WrapperExecutionTargetDialogModel {
  return {
    ...state,
    isRemoteProject: derived.isRemoteProject,
    remoteHostLabel: project.remoteHostAlias ?? derived.boundHostProfileId ?? '',
    boundHostAvailable: derived.boundHostAvailable,
    connections: derived.connections,
    runtimeRootEffective: runtimeRootResolutionForController(state),
    runtimeRootValueError: remoteRuntimeRootValueError(state.runtimeRootOverride),
    runtimeRootHardBlocked:
      Boolean(remoteRuntimeRootValueError(state.runtimeRootOverride)) ||
      runtimeRootHasHardErrors(state.environmentState, derived.environmentKey),
    checkingEnvironment: derived.checkingEnvironment,
    environmentKey: derived.environmentKey,
    environmentReport: derived.environmentReport
  }
}
