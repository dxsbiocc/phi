import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { isRecord } from '../../shared/guards'
import type { RoutedPlanRunOperations } from '../agent/engine/session-routing-engine'
import { planExecutionOwner } from '../agent/plan/plan-ownership'
import type { KernelRuntimeRef } from '../agent/session/runtime-reference'
import type {
  PlanRunIdInput,
  PlanRunPendingReplan,
  PlanRunReplanCancelInput,
  PlanRunReplanRequest,
  PlanRunSessionInput,
  PlanRunState,
  PlanRunStepInput
} from '../../shared/planRunTypes'

type Awaitable<T> = T | Promise<T>

export interface PlanRunIpcOperations {
  list(phiSessionId: string): Awaitable<PlanRunState[]>
  get(phiSessionId: string, runId: string): Awaitable<PlanRunState | null | undefined>
  pendingReplanForRun(phiSessionId: string, runId: string): Awaitable<PlanRunPendingReplan | null>
  pause(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  resume(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  stop(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  retryStep(phiSessionId: string, runId: string, stepId: string): Awaitable<PlanRunState>
  skipStep(phiSessionId: string, runId: string, stepId: string): Awaitable<PlanRunState>
  requestReplan(phiSessionId: string, runId: string): Awaitable<PlanRunReplanRequest>
  cancelRequestedReplan(phiSessionId: string, runId: string, requestId: string): Awaitable<void>
}

export interface PlanRunIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  planRuns: PlanRunIpcOperations
  findSessionById(phiSessionId: string): { kernelRuntimeRef?: KernelRuntimeRef } | null | undefined
  kernelPlanRuns(phiSessionId: string): RoutedPlanRunOperations | undefined
}

export type KernelPlanRunIpcOperations = RoutedPlanRunOperations

const MAX_IDENTIFIER_LENGTH = 512
const INVALID_REQUEST = '计划运行请求无效'
const KERNEL_PLAN_NOT_LOADED = '内核计划会话当前未加载，请先打开该会话再重试'

type PlanRunRoute =
  | { kind: 'desktop'; operations: PlanRunIpcOperations }
  | { kind: 'kernel'; operations: RoutedPlanRunOperations | undefined }

function planRunRoute(options: PlanRunIpcOptions, phiSessionId: string): PlanRunRoute {
  return planExecutionOwner(options.findSessionById(phiSessionId)) === 'kernel'
    ? { kind: 'kernel', operations: options.kernelPlanRuns(phiSessionId) }
    : { kind: 'desktop', operations: options.planRuns }
}

function loadedKernelPlanRuns(
  route: Extract<PlanRunRoute, { kind: 'kernel' }>
): RoutedPlanRunOperations {
  if (!route.operations) throw new Error(KERNEL_PLAN_NOT_LOADED)
  return route.operations
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
    const route = planRunRoute(options, input.phiSessionId)
    return route.kind === 'desktop'
      ? route.operations.list(input.phiSessionId)
      : (route.operations?.list() ?? [])
  })
  ipcMain.handle(IPC.planRuns.get, async (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    const state =
      route.kind === 'desktop'
        ? await route.operations.get(input.phiSessionId, input.runId)
        : await route.operations?.get(input.runId)
    return state ?? null
  })

  // Kernel mapping: pending replan inspection has no protocol equivalent, so it is empty.
  ipcMain.handle(IPC.planRuns.getPendingReplan, async (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    if (route.kind === 'kernel') return null
    const pending = await route.operations.pendingReplanForRun(input.phiSessionId, input.runId)
    return pending?.runId === input.runId
      ? { requestId: pending.requestId, runId: pending.runId }
      : null
  })

  // Kernel mapping: pause/resume are unsupported rather than falling through to desktop state.
  ipcMain.handle(IPC.planRuns.pause, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    if (route.kind === 'kernel') throw new Error('内核计划运行暂不支持暂停')
    return route.operations.pause(input.phiSessionId, input.runId)
  })
  ipcMain.handle(IPC.planRuns.resume, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    if (route.kind === 'kernel') throw new Error('内核计划运行暂不支持恢复')
    return route.operations.resume(input.phiSessionId, input.runId)
  })

  // Kernel mapping: stop/retry/skip call the matching coordinator mutations.
  ipcMain.handle(IPC.planRuns.stop, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    return route.kind === 'desktop'
      ? route.operations.stop(input.phiSessionId, input.runId)
      : loadedKernelPlanRuns(route).stop(input.runId)
  })
  ipcMain.handle(IPC.planRuns.retryStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    return route.kind === 'desktop'
      ? route.operations.retryStep(input.phiSessionId, input.runId, input.stepId)
      : loadedKernelPlanRuns(route).retryStep(input.runId, input.stepId)
  })
  ipcMain.handle(IPC.planRuns.skipStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    return route.kind === 'desktop'
      ? route.operations.skipStep(input.phiSessionId, input.runId, input.stepId)
      : loadedKernelPlanRuns(route).skipStep(input.runId, input.stepId)
  })

  // Kernel mapping: requestReplan maps to planRuns.replan on the coordinator.
  ipcMain.handle(IPC.planRuns.requestReplan, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    return route.kind === 'desktop'
      ? route.operations.requestReplan(input.phiSessionId, input.runId)
      : loadedKernelPlanRuns(route).requestReplan(input.runId)
  })

  // Kernel mapping: cancelling a requested replan has no safe coordinator equivalent.
  ipcMain.handle(IPC.planRuns.cancelReplan, (_event, ...args: unknown[]) => {
    const input = readReplanCancelInput(args)
    const route = planRunRoute(options, input.phiSessionId)
    if (route.kind === 'kernel') throw new Error('内核计划运行暂不支持取消重新规划')
    return route.operations.cancelRequestedReplan(input.phiSessionId, input.runId, input.requestId)
  })
}
