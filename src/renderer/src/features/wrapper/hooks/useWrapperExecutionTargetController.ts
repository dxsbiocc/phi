import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { Project, ProjectRemoteConnection } from '../../../types'
import type { RemoteNextflowInstallResult } from '../../../../../shared/remoteDoctorTypes'
import type {
  WrapperExecutionTargetDialogActions,
  WrapperExecutionTargetDialogModel
} from '../components/WrapperExecutionTargetDialog'
import { installRemoteNextflowAndRefreshProfile } from '../lib/remoteNextflowInstall'
import { remoteRuntimeRootValueError } from '../lib/remoteRuntimeRootUi'
import {
  INITIAL_CONTROLLER_STATE,
  controllerConnectionPatch,
  controllerSaveError,
  createControllerConnection,
  createExecutionTargetDialogModel,
  deriveControllerState,
  executionTargetDoctorOptions,
  executionTargetEnvironmentKey,
  installedControllerPatch,
  patchControllerState,
  runtimeRootCandidateKey,
  type ControllerState,
  type DerivedState
} from '../lib/wrapperExecutionTargetController'

type StateSetter = Dispatch<SetStateAction<ControllerState>>
interface SequenceActions {
  current: () => number
  next: () => number
}

export interface WrapperExecutionTargetControllerInput {
  project: Project
  onUpdateRemoteConnection?: (
    projectId: string,
    connectionId: string,
    patch: ProjectRemoteConnection
  ) => Promise<void>
  onUpdateRemoteDefaults?: (
    projectId: string,
    defaults: { defaultRemoteConnectionId?: string | null; remoteWorkspaceRoot?: string | null }
  ) => Promise<void>
  onOpenRemoteSettings?: () => void
  onSaved?: () => void
}

interface WrapperExecutionTargetController {
  model: WrapperExecutionTargetDialogModel
  actions: WrapperExecutionTargetDialogActions
  configured?: ProjectRemoteConnection
  isRemoteProject: boolean
  openDialog: () => void
  installConfirmOpen: boolean
  installing: boolean
  closeInstall: () => void
  confirmInstall: () => void
}

function useSequenceActions(): SequenceActions {
  const sequence = useRef(0)
  return {
    current: (): number => sequence.current,
    next: (): number => ++sequence.current
  }
}

function useRemoteHosts(open: boolean, setState: StateSetter): void {
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api
      .listRemoteHosts()
      .then((hosts) => {
        if (!cancelled) patchControllerState(setState, { hosts })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          patchControllerState(setState, {
            error: cause instanceof Error ? cause.message : String(cause)
          })
        }
      })
      .finally(() => {
        if (!cancelled) patchControllerState(setState, { loading: false })
      })
    return (): void => {
      cancelled = true
    }
  }, [open, setState])
}

function createEnvironmentCheck(
  state: ControllerState,
  setState: StateSetter,
  sequence: SequenceActions
): (nextflowBin?: string) => Promise<void> {
  return async (nextflowBin = state.hpc.nextflowBin) => {
    const root = state.remoteRoot.trim()
    if (!state.hosts.some((host) => host.id === state.hostProfileId)) {
      return patchControllerState(setState, { error: '请选择可用的 SSH 服务器' })
    }
    if (!root.startsWith('/') || /[\r\n\0]/.test(root)) {
      return patchControllerState(setState, { error: '服务器工作目录必须是绝对路径' })
    }
    const runtimeRootError = remoteRuntimeRootValueError(state.runtimeRootOverride)
    if (runtimeRootError) return patchControllerState(setState, { error: runtimeRootError })
    const key = executionTargetEnvironmentKey(state, nextflowBin)
    const requestId = sequence.next()
    patchControllerState(setState, { error: null, environmentState: { phase: 'running', key } })
    try {
      const report = await window.api.remoteDoctor(
        state.hostProfileId,
        root,
        executionTargetDoctorOptions(state.hpc, nextflowBin, state.runtimeRootOverride)
      )
      if (sequence.current() === requestId) {
        patchControllerState(setState, { environmentState: { phase: 'done', key, report } })
      }
    } catch {
      if (sequence.current() === requestId) {
        patchControllerState(setState, {
          environmentState: {
            phase: 'failed',
            key,
            message: '运行环境检查未完成，请确认服务器和网络状态后重试。'
          }
        })
      }
    }
  }
}

function handleInstallFailure(
  installed: boolean,
  current: boolean,
  key: string,
  cause: unknown,
  setState: StateSetter
): void {
  if (installed && current) {
    return patchControllerState(setState, {
      environmentState: {
        phase: 'failed',
        key,
        message: '运行环境检查未完成，请确认服务器和网络状态后重试。'
      }
    })
  }
  if (!installed) {
    patchControllerState(setState, {
      installStatus: {
        severity: 'error',
        message: cause instanceof Error ? cause.message : 'Nextflow 安装未完成，请改为手动安装'
      }
    })
  }
}

function applyInstalledResult(
  result: RemoteNextflowInstallResult,
  state: ControllerState,
  setState: StateSetter,
  sequence: SequenceActions,
  tracker: { requestId: number; key: string; installed: boolean }
): void {
  tracker.installed = true
  tracker.key = executionTargetEnvironmentKey(state, result.path)
  tracker.requestId = sequence.next()
  setState((current) => ({
    ...current,
    ...installedControllerPatch(result, tracker.key),
    hpc: { ...current.hpc, nextflowBin: result.path }
  }))
}

function createNextflowInstall(
  state: ControllerState,
  setState: StateSetter,
  sequence: SequenceActions
): () => Promise<void> {
  return async () => {
    patchControllerState(setState, {
      installConfirmOpen: false,
      installing: true,
      installStatus: null
    })
    const tracker = { requestId: 0, key: '', installed: false }
    try {
      const { report } = await installRemoteNextflowAndRefreshProfile(
        {
          hostProfileId: state.hostProfileId,
          projectRoot: state.remoteRoot.trim(),
          doctorOptions: executionTargetDoctorOptions(
            state.hpc,
            state.hpc.nextflowBin,
            state.runtimeRootOverride
          )
        },
        {
          install: window.api.installRemoteNextflow,
          probe: window.api.remoteDoctor,
          onInstalled: (result) => applyInstalledResult(result, state, setState, sequence, tracker)
        }
      )
      if (sequence.current() === tracker.requestId) {
        patchControllerState(setState, {
          environmentState: { phase: 'done', key: tracker.key, report }
        })
      }
    } catch (cause) {
      handleInstallFailure(
        tracker.installed,
        sequence.current() === tracker.requestId,
        tracker.key,
        cause,
        setState
      )
    } finally {
      patchControllerState(setState, { installing: false })
    }
  }
}

function createSaveAction(
  input: WrapperExecutionTargetControllerInput,
  state: ControllerState,
  derived: DerivedState,
  setState: StateSetter,
  sequence: SequenceActions
): () => Promise<void> {
  return async () => {
    const error = controllerSaveError(state, derived)
    if (error) return patchControllerState(setState, { error })
    const connection = createControllerConnection(state, derived)
    patchControllerState(setState, { saving: true, error: null })
    try {
      if (input.onUpdateRemoteConnection) {
        await input.onUpdateRemoteConnection(input.project.id, connection.id, connection)
      } else
        await window.api.updateProjectRemoteConnection(input.project.id, connection.id, connection)
      const defaults = {
        defaultRemoteConnectionId: connection.id,
        ...(!derived.isRemoteProject ? { remoteWorkspaceRoot: state.remoteRoot.trim() } : {})
      }
      if (input.onUpdateRemoteDefaults) {
        await input.onUpdateRemoteDefaults(input.project.id, defaults)
      } else await window.api.updateProjectRemoteDefaults(input.project.id, defaults)
      sequence.next()
      patchControllerState(setState, { connectionId: connection.id, open: false })
      input.onSaved?.()
    } catch (cause) {
      patchControllerState(setState, {
        error: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      patchControllerState(setState, { saving: false })
    }
  }
}

function createCloseAction(
  state: ControllerState,
  setState: StateSetter,
  sequence: SequenceActions
): () => void {
  return () => {
    if (state.saving || state.installing) return
    sequence.next()
    patchControllerState(setState, { installConfirmOpen: false, open: false })
  }
}

function createOpenAction(
  input: WrapperExecutionTargetControllerInput,
  derived: DerivedState,
  setState: StateSetter,
  sequence: SequenceActions
): () => void {
  return () => {
    const root =
      input.project.location.kind === 'ssh'
        ? input.project.location.canonicalRoot
        : (input.project.remoteWorkspaceRoot ?? '')
    setState((current) => ({
      ...current,
      ...controllerConnectionPatch(derived.configured, derived),
      remoteRoot: root,
      error: null,
      environmentState: { phase: 'idle' },
      installStatus: null,
      loading: true,
      open: true
    }))
    sequence.next()
  }
}

function createDialogActions(
  input: WrapperExecutionTargetControllerInput,
  state: ControllerState,
  derived: DerivedState,
  setState: StateSetter,
  close: () => void,
  checkEnvironment: (nextflowBin?: string) => Promise<void>,
  save: () => Promise<void>
): WrapperExecutionTargetDialogActions {
  return {
    chooseConnection: (id) =>
      patchControllerState(
        setState,
        controllerConnectionPatch(
          derived.connections.find((item) => item.id === id),
          derived
        )
      ),
    setHostProfileId: (hostProfileId) =>
      patchControllerState(setState, { hostProfileId, runtimeRootConfirmedKey: null }),
    setRemoteRoot: (remoteRoot) => patchControllerState(setState, { remoteRoot }),
    setRuntimeRootOverride: (runtimeRootOverride) =>
      patchControllerState(setState, { runtimeRootOverride, runtimeRootConfirmedKey: null }),
    setHpc: (hpc) => patchControllerState(setState, { hpc }),
    setLocalInputRoot: (localInputRoot) => patchControllerState(setState, { localInputRoot }),
    setRemoteInputRoot: (remoteInputRoot) => patchControllerState(setState, { remoteInputRoot }),
    openRemoteSettings: input.onOpenRemoteSettings
      ? () => {
          close()
          input.onOpenRemoteSettings?.()
        }
      : undefined,
    close,
    save: () => void save(),
    checkEnvironment: () => void checkEnvironment(),
    checkRuntimeRoot: () => void checkEnvironment(),
    confirmRuntimeRootWarnings: () =>
      patchControllerState(setState, {
        runtimeRootConfirmedKey: runtimeRootCandidateKey(state)
      }),
    installNextflow: () => patchControllerState(setState, { installConfirmOpen: true })
  }
}

export function useWrapperExecutionTargetController(
  input: WrapperExecutionTargetControllerInput
): WrapperExecutionTargetController {
  const [state, setState] = useState(INITIAL_CONTROLLER_STATE)
  const sequenceActions = useSequenceActions()
  const derived = deriveControllerState(input.project, state)
  useRemoteHosts(state.open, setState)
  const checkEnvironment = createEnvironmentCheck(state, setState, sequenceActions)
  const confirmInstall = createNextflowInstall(state, setState, sequenceActions)
  const save = createSaveAction(input, state, derived, setState, sequenceActions)
  const close = createCloseAction(state, setState, sequenceActions)
  const actions = createDialogActions(
    input,
    state,
    derived,
    setState,
    close,
    checkEnvironment,
    save
  )
  return {
    model: createExecutionTargetDialogModel(input.project, state, derived),
    actions,
    configured: derived.configured,
    isRemoteProject: derived.isRemoteProject,
    openDialog: createOpenAction(input, derived, setState, sequenceActions),
    installConfirmOpen: state.installConfirmOpen,
    installing: state.installing,
    closeInstall: () => patchControllerState(setState, { installConfirmOpen: false }),
    confirmInstall: () => void confirmInstall()
  }
}
