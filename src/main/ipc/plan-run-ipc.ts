import type { IpcMain } from 'electron'

import { IPC } from '../../shared/ipcChannels'
import { isRecord } from '../../shared/guards'
import type {
  PlanRunIdInput,
  PlanRunSessionInput,
  PlanRunState,
  PlanRunStepInput
} from '../../shared/planRunTypes'

type Awaitable<T> = T | Promise<T>

export interface PlanRunIpcOperations {
  list(phiSessionId: string): Awaitable<PlanRunState[]>
  get(phiSessionId: string, runId: string): Awaitable<PlanRunState | null | undefined>
  pause(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  resume(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  stop(phiSessionId: string, runId: string): Awaitable<PlanRunState>
  retryStep(phiSessionId: string, runId: string, stepId: string): Awaitable<PlanRunState>
  skipStep(phiSessionId: string, runId: string, stepId: string): Awaitable<PlanRunState>
}

export interface PlanRunIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  planRuns: PlanRunIpcOperations
}

const MAX_IDENTIFIER_LENGTH = 512
const INVALID_REQUEST = '计划运行请求无效'

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

export function registerPlanRunIpc(options: PlanRunIpcOptions): void {
  const { ipcMain, planRuns } = options
  ipcMain.handle(IPC.planRuns.list, (_event, ...args: unknown[]) => {
    const input = readSessionInput(args)
    return planRuns.list(input.phiSessionId)
  })
  ipcMain.handle(IPC.planRuns.get, async (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return (await planRuns.get(input.phiSessionId, input.runId)) ?? null
  })
  ipcMain.handle(IPC.planRuns.pause, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return planRuns.pause(input.phiSessionId, input.runId)
  })
  ipcMain.handle(IPC.planRuns.resume, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return planRuns.resume(input.phiSessionId, input.runId)
  })
  ipcMain.handle(IPC.planRuns.stop, (_event, ...args: unknown[]) => {
    const input = readRunInput(args)
    return planRuns.stop(input.phiSessionId, input.runId)
  })
  ipcMain.handle(IPC.planRuns.retryStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    return planRuns.retryStep(input.phiSessionId, input.runId, input.stepId)
  })
  ipcMain.handle(IPC.planRuns.skipStep, (_event, ...args: unknown[]) => {
    const input = readStepInput(args)
    return planRuns.skipStep(input.phiSessionId, input.runId, input.stepId)
  })
}
