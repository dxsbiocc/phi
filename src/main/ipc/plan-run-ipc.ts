import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { isRecord } from '../../shared/guards'
import type { RoutedPlanRunOperations } from '../agent/engine/session-routing-engine'
import type {
  PlanRunIdInput,
  PlanRunReplanCancelInput,
  PlanRunSessionInput,
  PlanRunStepInput
} from '../../shared/planRunTypes'

export interface PlanRunIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  kernelPlanRuns(phiSessionId: string): RoutedPlanRunOperations | undefined
}

export type KernelPlanRunIpcOperations = RoutedPlanRunOperations

const MAX_IDENTIFIER_LENGTH = 512
const INVALID_REQUEST = '计划运行请求无效'
const KERNEL_PLAN_NOT_LOADED = '内核计划会话当前未加载，请先打开该会话再重试'
const REPLAN_CANCEL_BUSY = '对话仍在处理，请等它停下后再重试取消'

function loadedKernelPlanRuns(
  options: PlanRunIpcOptions,
  phiSessionId: string
): RoutedPlanRunOperations {
  const operations = options.kernelPlanRuns(phiSessionId)
  if (!operations) throw new Error(KERNEL_PLAN_NOT_LOADED)
  return operations
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function readIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return value
}

function readInput(args: unknown[], keys: readonly string[]): Record<string, unknown> {
  if (args.length !== 1 || !isRecord(args[0])) throw new Error(INVALID_REQUEST)
  const input = args[0]
  const inputKeys = Object.keys(input)
  if (inputKeys.length !== keys.length || inputKeys.some((key) => !keys.includes(key))) {
    throw new Error(INVALID_REQUEST)
  }
  return input
}

function readSessionInput(args: unknown[]): PlanRunSessionInput {
  const input = readInput(args, ['phiSessionId'])
  return { phiSessionId: readIdentifier(input.phiSessionId) }
}

function readRunInput(args: unknown[]): PlanRunIdInput {
  const input = readInput(args, ['phiSessionId', 'runId'])
  return {
    phiSessionId: readIdentifier(input.phiSessionId),
    runId: readIdentifier(input.runId)
  }
}

function readStepInput(args: unknown[]): PlanRunStepInput {
  const input = readInput(args, ['phiSessionId', 'runId', 'stepId'])
  return {
    phiSessionId: readIdentifier(input.phiSessionId),
    runId: readIdentifier(input.runId),
    stepId: readIdentifier(input.stepId)
  }
}

function readReplanCancelInput(args: unknown[]): PlanRunReplanCancelInput {
  const input = readInput(args, ['phiSessionId', 'runId', 'requestId'])
  return {
    phiSessionId: readIdentifier(input.phiSessionId),
    runId: readIdentifier(input.runId),
    requestId: readIdentifier(input.requestId)
  }
}

export function registerPlanRunIpc(options: PlanRunIpcOptions): void {
  const { ipcMain } = options

  // Kernel mapping: list/get are direct coordinator reads; unloaded sessions return empty reads.
  ipcMain.handle(IPC.planRuns.list, async (_event, ...args: unknown[]) => {
    const input = readSessionInput(args)
    return options.kernelPlanRuns(input.phiSessionId)?.list() ?? []
  })
  ipcMain.handle(IPC.planRuns.get, async (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const state = await options.kernelPlanRuns(input.phiSessionId)?.get(input.runId)
    return state ?? null
  })

  // Kernel mapping: pending replan inspection has no protocol equivalent, so it is empty.
  ipcMain.handle(IPC.planRuns.getPendingReplan, async (_event, ...args: unknown[]) => {
    readRunInput(args)
    return null
  })

  // Kernel mapping: pause/resume are unsupported rather than falling through to desktop state.
  ipcMain.handle(IPC.planRuns.pause, (_event, ...args: unknown[]) => {
    readRunInput(args)
    throw new Error('内核计划运行暂不支持暂停')
  })
  ipcMain.handle(IPC.planRuns.resume, (_event, ...args: unknown[]) => {
    readRunInput(args)
    throw new Error('内核计划运行暂不支持恢复')
  })

  // Kernel mapping: stop/retry/skip call the matching coordinator mutations.
  ipcMain.handle(IPC.planRuns.stop, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return loadedKernelPlanRuns(options, input.phiSessionId).stop(input.runId)
  })
  ipcMain.handle(IPC.planRuns.retryStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    return loadedKernelPlanRuns(options, input.phiSessionId).retryStep(input.runId, input.stepId)
  })
  ipcMain.handle(IPC.planRuns.skipStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    return loadedKernelPlanRuns(options, input.phiSessionId).skipStep(input.runId, input.stepId)
  })

  // Kernel mapping: requestReplan maps to planRuns.replan on the coordinator.
  ipcMain.handle(IPC.planRuns.requestReplan, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return loadedKernelPlanRuns(options, input.phiSessionId).requestReplan(input.runId)
  })

  // Kernel mapping: session.plan.cancel with the replan request id; it refuses while the
  // conversation turn is still running, so the renderer keeps its retry affordance.
  ipcMain.handle(IPC.planRuns.cancelReplan, async (_event, ...args: unknown[]) => {
    const input = readReplanCancelInput(args)
    const cleared = await loadedKernelPlanRuns(options, input.phiSessionId).cancelReplan(
      input.requestId
    )
    if (!cleared) throw new Error(REPLAN_CANCEL_BUSY)
  })
}
