import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { getAuthManager } from '../agent/auth-manager'
import { ownsRemoteRuntimeSession } from '../agent/engine/in-process-engine'
import { selectionThinking } from '../agent/engine/rpc/runtime-selection-control'
import type { ModelSelection, PermissionMode } from '../agent/projects'
import type { ModelRuntime, RuntimeModel } from '../agent/runtime/runtime-adapter'
import { getSupportedThinkingLevels } from '../agent/runtime/model-thinking-levels'
import {
  captureCurrentSelectionTarget,
  type ModelSelectionTargetDependencies
} from '../agent/session/model-selection-target'
import { findPhiSessionById, updateSessionManifest } from '../agent/session/session-store'

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelsIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  selectionTarget: ModelSelectionTargetDependencies
  sessionState: {
    getCurrentSessionPath: () => string | undefined
    getCurrentPermissionMode: () => PermissionMode
    sessionModelSelections: Map<string, ModelSelection | null>
    sessionThinkingLevels: Map<string, ThinkingLevel>
  }
  requests: {
    nextModelSelectionRequest: () => number
    rememberModelSelection: (request: number, model: ModelSelection | null) => void
  }
  models: {
    selectableRuntimeModels: (runtime: ModelRuntime) => RuntimeModel[]
    resolveRuntimeModelSelection: (
      runtime: ModelRuntime,
      selection: ModelSelection
    ) => { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null
    resolveSessionModelSelection: (
      sessionKey: string,
      snapshot: { path: string | undefined; cwd: string; permissionMode: PermissionMode }
    ) => ModelSelection | null
    resolveSessionThinkingLevel: (
      sessionKey: string,
      snapshot: { path: string | undefined; cwd: string; permissionMode: PermissionMode }
    ) => ThinkingLevel
  }
}

const sessionModelSelectionQueues = new Map<string, Promise<void>>()

/* eslint-disable complexity, max-lines-per-function -- Preserves the model selection queue and RPC fences verbatim. */
export function registerModelsIpc(options: ModelsIpcOptions): void {
  const ipcMain = options.ipcMain
  const selectionTarget = options.selectionTarget
  const sessionState = options.sessionState
  const requests = options.requests

  ipcMain.handle(IPC.models.list, async () => {
    const runtime = await getAuthManager().getRuntime()
    return options.models.selectableRuntimeModels(runtime).map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      supportsImages: model.supportsImages ?? false,
      thinkingLevels: getSupportedThinkingLevels(model)
    }))
  })
  ipcMain.handle(
    IPC.models.select,
    async (_, providerId: string | null, modelId: string | null) => {
      const target = captureCurrentSelectionTarget(selectionTarget)
      const request = requests.nextModelSelectionRequest()
      const key = target.phiSessionId ?? selectionTarget.resolveSessionKeyAlias(target.key)
      const rememberSelection = (model: ModelSelection | null): void => {
        requests.rememberModelSelection(request, model)
      }
      const selection = (sessionModelSelectionQueues.get(key) ?? Promise.resolve()).then(
        async () => {
          target.assertCurrent()
          if (providerId === null && modelId === null) {
            if (target.rpc) throw new Error('远程 RPC 对话暂不支持自动模型，请选择具体模型')
            sessionState.sessionModelSelections.set(
              selectionTarget.resolveSessionKeyAlias(target.key),
              null
            )
            if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { model: null })
            rememberSelection(null)
            return
          }
          if (typeof providerId !== 'string' || typeof modelId !== 'string') {
            throw new Error('模型选择无效')
          }
          const runtime = await getAuthManager().getRuntime()
          target.assertCurrent()
          const resolved = options.models.resolveRuntimeModelSelection(runtime, {
            providerId,
            modelId
          })
          if (!resolved || resolved.migratedFrom)
            throw new Error(`未知模型: ${providerId}/${modelId}`)
          const model = resolved.model
          if (target.rpc) {
            const current = await target.resolved()
            target.assertCurrent()
            const snapshot = {
              path: sessionState.getCurrentSessionPath(),
              cwd: selectionTarget.getCurrentCwd(),
              permissionMode: sessionState.getCurrentPermissionMode()
            }
            const preferred = selectionThinking(
              model,
              options.models.resolveSessionThinkingLevel(target.key, snapshot)
            ).phi
            if (current) {
              if (!ownsRemoteRuntimeSession(current.session.runtimeSessionId))
                throw new Error('Remote selection requires an exact live attachment')
              await current.session.setModel(model, {
                assertCurrent: target.assertCurrent,
                preferredThinkingLevel: preferred
              })
              target.assertCurrent()
            } else {
              if (target.phiSessionId && findPhiSessionById(target.phiSessionId)?.runtimeRef)
                throw new Error('Remote selection requires an exact live attachment')
              if (target.phiSessionId)
                updateSessionManifest(target.phiSessionId, {
                  model: { providerId, modelId },
                  thinkingLevel: preferred
                })
            }
            const key = selectionTarget.resolveSessionKeyAlias(target.key)
            sessionState.sessionModelSelections.set(key, { providerId, modelId })
            const confirmed = target.phiSessionId
              ? findPhiSessionById(target.phiSessionId)?.thinkingLevel
              : preferred
            if (confirmed === undefined) sessionState.sessionThinkingLevels.delete(key)
            else sessionState.sessionThinkingLevels.set(key, confirmed)
            rememberSelection({ providerId, modelId })
            return
          }
          const nextModel = { providerId, modelId }
          if (!selectionTarget.hasActivePromptRun(target.key)) {
            const current = await target.resolved()
            if (current) await current.session.setModel(model)
            target.assertCurrent()
          }
          sessionState.sessionModelSelections.set(
            selectionTarget.resolveSessionKeyAlias(target.key),
            nextModel
          )
          if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { model: nextModel })
          rememberSelection(nextModel)
        }
      )
      const settled = selection.then(
        () => undefined,
        () => undefined
      )
      sessionModelSelectionQueues.set(key, settled)
      void settled.then(() => {
        if (sessionModelSelectionQueues.get(key) === settled)
          sessionModelSelectionQueues.delete(key)
      })
      return selection
    }
  )
  ipcMain.handle(IPC.models.selected, async () => {
    const snapshot = {
      path: sessionState.getCurrentSessionPath(),
      cwd: selectionTarget.getCurrentCwd(),
      permissionMode: sessionState.getCurrentPermissionMode()
    }
    const resolved = options.models.resolveSessionModelSelection(
      selectionTarget.getCurrentSessionKey(),
      snapshot
    )
    if (resolved) {
      const runtime = await getAuthManager().getRuntime()
      return options.models.resolveRuntimeModelSelection(runtime, resolved)?.selection ?? resolved
    }

    return null
  })
}
/* eslint-enable complexity, max-lines-per-function */
