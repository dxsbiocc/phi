import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { getAuthManager } from '../agent/auth-manager'
import { ownsRemoteRuntimeSession } from '../agent/engine/in-process-engine'
import { selectionThinking } from '../agent/engine/rpc/runtime-selection-control'
import type { ModelSelection, PermissionMode } from '../agent/projects'
import type { ModelRuntime, RuntimeModel } from '../agent/runtime/runtime-adapter'
import {
  captureCurrentSelectionTarget,
  type ModelSelectionTargetDependencies
} from '../agent/session/model-selection-target'
import { findPhiSessionById, updateSessionManifest } from '../agent/session/session-store'
import type { SessionPreferenceTable } from '../app-state/session-preferences'

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ThinkingIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  selectionTarget: ModelSelectionTargetDependencies
  sessionState: {
    getCurrentSessionPath: () => string | undefined
    getCurrentPermissionMode: () => PermissionMode
    sessionThinkingLevels: SessionPreferenceTable<ThinkingLevel>
    getCurrentResolvedSession: () => Promise<{
      session: {
        thinkingLevel?: ThinkingLevel
        setThinkingLevel(level: ThinkingLevel): Promise<void>
      }
    } | null>
  }
  models: {
    resolveRuntimeModelSelection: (
      runtime: ModelRuntime,
      selection: ModelSelection
    ) => { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null
    resolveSessionThinkingLevel: (
      sessionKey: string,
      snapshot: { path: string | undefined; cwd: string; permissionMode: PermissionMode }
    ) => ThinkingLevel
  }
}

/* eslint-disable complexity -- Preserves remote and local thinking selection semantics. */
export function registerThinkingIpc(options: ThinkingIpcOptions): void {
  const ipcMain = options.ipcMain
  const selectionTarget = options.selectionTarget
  const sessionState = options.sessionState

  ipcMain.handle(IPC.thinking.select, async (_, level: ThinkingLevel) => {
    const target = captureCurrentSelectionTarget(selectionTarget)
    if (target.rpc) {
      const current = await target.resolved()
      target.assertCurrent()
      if (current) {
        if (!ownsRemoteRuntimeSession(current.session.runtimeSessionId))
          throw new Error('Remote selection requires an exact live attachment')
        await current.session.setThinkingLevel(level, target)
        target.assertCurrent()
      } else {
        if (target.phiSessionId && findPhiSessionById(target.phiSessionId)?.runtimeRef)
          throw new Error('Remote selection requires an exact live attachment')
        const runtime = await getAuthManager().getRuntime()
        target.assertCurrent()
        const manifest = target.phiSessionId ? findPhiSessionById(target.phiSessionId) : null
        const selected =
          manifest?.model &&
          options.models.resolveRuntimeModelSelection(runtime, manifest.model)?.model
        if (!selected) throw new Error('Remote thinking selection requires a trusted model')
        const normalized = selectionThinking(selected, level, true).phi
        if (target.phiSessionId)
          updateSessionManifest(target.phiSessionId, { thinkingLevel: normalized })
      }
      const key = selectionTarget.resolveSessionKeyAlias(target.key)
      const confirmed = target.phiSessionId
        ? findPhiSessionById(target.phiSessionId)?.thinkingLevel
        : level
      if (confirmed === undefined) sessionState.sessionThinkingLevels.delete(key)
      else sessionState.sessionThinkingLevels.set(key, confirmed)
      return
    }
    sessionState.sessionThinkingLevels.set(
      selectionTarget.resolveSessionKeyAlias(target.key),
      level
    )
    if (target.phiSessionId) updateSessionManifest(target.phiSessionId, { thinkingLevel: level })
    if (selectionTarget.hasActivePromptRun(target.key)) return
    const current = await target.resolved()
    if (current) await current.session.setThinkingLevel(level)
  })
  ipcMain.handle(IPC.thinking.selected, async () => {
    const resolved = sessionState.sessionThinkingLevels.get(
      selectionTarget.resolveSessionKeyAlias(selectionTarget.getCurrentSessionKey())
    )
    if (resolved) return resolved

    const current = await sessionState.getCurrentResolvedSession()
    if (current) {
      const { session } = current
      return session.thinkingLevel
    }
    return options.models.resolveSessionThinkingLevel(selectionTarget.getCurrentSessionKey(), {
      path: sessionState.getCurrentSessionPath(),
      cwd: selectionTarget.getCurrentCwd(),
      permissionMode: sessionState.getCurrentPermissionMode()
    })
  })
}
/* eslint-enable complexity */
