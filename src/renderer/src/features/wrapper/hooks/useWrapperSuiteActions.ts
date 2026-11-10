import { useCallback, useState } from 'react'

import type { WrapperRemovalPreview } from '../../../../../shared/packageManagerTypes'
import { errorMessage } from '../../../../../shared/errorCodes'
import type { SnackbarSeverity } from '../../../components/AppSnackbarCard'
import type { BusyKeys } from '../../../components/catalog/useBusyKeys'
import { readableErrorMessage } from '../../../lib/sessionNotifications'
import type { OfficialWrapperToolChoice } from '../lib/officialWrapperCatalog'
import { wrapperCopy } from '../lib/wrapperCopy'
import { summarizeWrapperInstallPlan } from '../lib/wrapperInstallPlan'
import {
  summarizeWrapperSuiteInstall,
  wrapperSuiteAction,
  wrapperSuiteBusyKey,
  type WrapperSuiteInstallItem,
  type WrapperSuiteInstallSummary
} from '../lib/wrapperSuiteAction'
import type { WrapperCatalogChoice } from '../lib/wrapperCatalog'
import { installCatalogPackage } from '../../../lib/contentCatalog'

export interface PendingSuiteInstall {
  suite: string
  choices: readonly OfficialWrapperToolChoice[]
  plans: readonly WrapperSuiteInstallItem[]
  summary: WrapperSuiteInstallSummary
}

export interface PendingSuiteRemoval {
  suite: string
  choices: readonly OfficialWrapperToolChoice[]
  previews: WrapperRemovalPreview[]
}

export interface WrapperSuiteActions {
  pendingInstall: PendingSuiteInstall | null
  pendingRemoval: PendingSuiteRemoval | null
  install: (suite: string, choices: readonly OfficialWrapperToolChoice[]) => Promise<void>
  update: (suite: string, choices: readonly OfficialWrapperToolChoice[]) => Promise<void>
  requestRemoval: (suite: string, choices: readonly OfficialWrapperToolChoice[]) => Promise<void>
  confirmInstall: () => Promise<void>
  cancelInstall: () => void
  confirmRemoval: () => Promise<void>
  cancelRemoval: () => void
}

/**
 * Group actions run their tools sequentially under one busy key and refresh the catalog once at
 * the end. Planning happens before installing so one confirmation covers the whole group.
 */
export function useWrapperSuiteActions({
  busy,
  updateIds,
  refresh,
  clearError,
  onError,
  onSetPackageEnabled,
  onNotify
}: {
  busy: BusyKeys
  updateIds: ReadonlySet<string>
  refresh: () => Promise<void>
  clearError: () => void
  onError: (message: string) => void
  onSetPackageEnabled?: (id: string, enabled: boolean) => Promise<boolean | void> | void
  onNotify?: (message: string, severity?: SnackbarSeverity) => void
}): WrapperSuiteActions {
  const [pendingInstall, setPendingInstall] = useState<PendingSuiteInstall | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<PendingSuiteRemoval | null>(null)

  const enable = useCallback(
    async (choice: WrapperCatalogChoice): Promise<void> => {
      if (onSetPackageEnabled) {
        if ((await onSetPackageEnabled(choice.id, true)) === false)
          throw new Error(wrapperCopy.enableFailed)
        return
      }
      await window.api.setEnablement(`wrapper:${choice.id}`, true, { type: 'global' })
    },
    [onSetPackageEnabled]
  )

  const plan = useCallback(
    async (choices: readonly OfficialWrapperToolChoice[]): Promise<WrapperSuiteInstallItem[]> => {
      const plans: WrapperSuiteInstallItem[] = []
      for (const { choice } of choices) {
        if (choice.installed) continue
        if (!choice.registryPath || !choice.registryEntry)
          throw new Error(wrapperCopy.noInstallSource)
        const installPlan = await window.api.planPackageInstall(
          choice.registryPath,
          'wrapper',
          choice.id,
          choice.registryEntry.version
        )
        plans.push({
          choice,
          summary: summarizeWrapperInstallPlan(installPlan, choice.id)
        })
      }
      return plans
    },
    []
  )

  const runInstall = useCallback(
    async (
      suite: string,
      choices: readonly OfficialWrapperToolChoice[],
      planned?: readonly WrapperSuiteInstallItem[]
    ): Promise<void> => {
      const key = wrapperSuiteBusyKey(suite)
      if (busy.has(key)) return
      clearError()
      busy.start(key)
      try {
        const plans = planned ?? (await plan(choices))
        if (!planned) {
          const summary = summarizeWrapperSuiteInstall(plans)
          if (summary.needsConfirmation) {
            setPendingInstall({ suite, choices, plans, summary })
            return
          }
        }
        for (const { choice } of plans) {
          if (!choice.registryPath || !choice.registryEntry)
            throw new Error(wrapperCopy.noInstallSource)
          await installCatalogPackage(window.api, choice.registryPath, choice.registryEntry)
        }
        for (const { choice } of choices) await enable(choice)
        await refresh()
      } catch (cause) {
        onError(errorMessage(cause))
      } finally {
        busy.finish(key)
      }
    },
    [busy, clearError, enable, onError, plan, refresh]
  )

  const update = useCallback(
    async (suite: string, choices: readonly OfficialWrapperToolChoice[]): Promise<void> => {
      const key = wrapperSuiteBusyKey(suite)
      if (busy.has(key)) return
      const { updates: targets } = wrapperSuiteAction(choices, updateIds)
      if (targets.length === 0) return
      clearError()
      busy.start(key)
      try {
        for (const choice of targets) {
          await window.api.applyPackageUpdate('wrapper', choice.id)
        }
        await refresh()
      } catch (cause) {
        onError(errorMessage(cause))
      } finally {
        busy.finish(key)
      }
    },
    [busy, clearError, onError, refresh, updateIds]
  )

  const requestRemoval = useCallback(
    async (suite: string, choices: readonly OfficialWrapperToolChoice[]): Promise<void> => {
      const key = wrapperSuiteBusyKey(suite)
      if (busy.has(key)) return
      const installed = choices.filter(({ choice }) => choice.installed)
      if (installed.length === 0) return
      clearError()
      busy.start(key)
      try {
        const previews: WrapperRemovalPreview[] = []
        for (const { choice } of installed) {
          previews.push(await window.api.previewWrapperRemoval(choice.id))
        }
        setPendingRemoval({ suite, choices: installed, previews })
      } catch (cause) {
        onError(readableErrorMessage(cause, wrapperCopy.removePackagePreviewFailed))
      } finally {
        busy.finish(key)
      }
    },
    [busy, clearError, onError]
  )

  const confirmInstall = useCallback(async (): Promise<void> => {
    const pending = pendingInstall
    if (!pending) return
    setPendingInstall(null)
    await runInstall(pending.suite, pending.choices, pending.plans)
  }, [pendingInstall, runInstall])

  const confirmRemoval = useCallback(async (): Promise<void> => {
    const pending = pendingRemoval
    if (!pending) return
    const key = wrapperSuiteBusyKey(pending.suite)
    if (busy.has(key)) return
    clearError()
    busy.start(key)
    try {
      for (const { choice } of pending.choices) {
        await window.api.removeWrapperPackage(choice.id, { disableDependents: true })
      }
      setPendingRemoval(null)
      if (onNotify) onNotify(wrapperCopy.removedSuite(pending.suite), 'success')
      await refresh()
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      busy.finish(key)
    }
  }, [busy, clearError, onError, onNotify, pendingRemoval, refresh])

  const cancelInstall = useCallback(() => setPendingInstall(null), [])
  const cancelRemoval = useCallback(() => setPendingRemoval(null), [])

  return {
    pendingInstall,
    pendingRemoval,
    install: runInstall,
    update,
    requestRemoval,
    confirmInstall,
    cancelInstall,
    confirmRemoval,
    cancelRemoval
  }
}
