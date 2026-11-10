import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { KernelLocalRuntimeRef } from './runtime-reference'

const MAX_RECEIPT_BYTES = 64 * 1024
const KERNEL_RECEIPT_FILE = 'agent-runs.jsonl'

export interface ColdKernelChildRun {
  readonly id: string
  readonly agent: string
  readonly background: true
  readonly status: 'completed' | 'failed' | 'aborted' | 'interrupted'
  readonly startedAt: number
  readonly completedAt?: number
}

interface AcceptedReceipt {
  readonly requestId: string
  readonly agent: string
  readonly background: boolean
}

interface StartedReceipt {
  readonly requestId: string
  readonly runId: string
  readonly startedAt: number
}

interface TerminalReceipt {
  readonly requestId: string
  readonly runId?: string
  readonly status: 'done' | 'error' | 'cancelled' | 'unknown'
  readonly completedAt?: number
}

interface ReceiptState {
  accepted: AcceptedReceipt
  started?: StartedReceipt
  terminal?: TerminalReceipt
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  )
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function text(value: unknown): value is string {
  return typeof value === 'string'
}

function invalid(): never {
  throw new Error('Invalid kernel agent-run receipt')
}

// eslint-disable-next-line complexity -- Mirrors the kernel receipt journal's strict state machine.
function parseReceipts(content: string): Map<string, ReceiptState> {
  const complete = content.endsWith('\n')
  const lines = content.split('\n')
  if (complete) lines.pop()
  const states = new Map<string, ReceiptState>()
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_BYTES) invalid()
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (!complete && index === lines.length - 1) break
      invalid()
    }
    const receipt = record(value)
    const state = receipt?.state
    const requestId = receipt?.requestId
    if (!receipt || !identifier(requestId) || !time(Date.parse(String(receipt.at)))) invalid()
    if (state === 'accepted') {
      if (
        states.has(requestId) ||
        !identifier(receipt.agent) ||
        !text(receipt.task) ||
        (receipt.origin !== 'tool' && receipt.origin !== 'host') ||
        typeof receipt.background !== 'boolean'
      )
        invalid()
      states.set(requestId, {
        accepted: {
          requestId,
          agent: receipt.agent,
          background: receipt.background
        }
      })
      continue
    }
    const current = states.get(requestId)
    if (!current) invalid()
    if (state === 'started') {
      if (
        current.started ||
        current.terminal ||
        !identifier(receipt.runId) ||
        !time(receipt.startedAt)
      )
        invalid()
      current.started = {
        requestId,
        runId: receipt.runId,
        startedAt: receipt.startedAt
      }
      continue
    }
    if (state === 'terminal') {
      if (current.terminal) invalid()
      const status = receipt.status
      if (status !== 'done' && status !== 'error' && status !== 'cancelled' && status !== 'unknown')
        invalid()
      if (
        (receipt.runId !== undefined && !identifier(receipt.runId)) ||
        (receipt.completedAt !== undefined && !time(receipt.completedAt)) ||
        (current.started && receipt.runId !== undefined && receipt.runId !== current.started.runId)
      )
        invalid()
      current.terminal = {
        requestId,
        ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
        status,
        ...(receipt.completedAt === undefined ? {} : { completedAt: receipt.completedAt })
      }
      continue
    }
    if (state !== 'reported' || !identifier(receipt.runId)) invalid()
  }
  return states
}

function coldStatus(status: TerminalReceipt['status'] | undefined): ColdKernelChildRun['status'] {
  if (status === 'done') return 'completed'
  if (status === 'error') return 'failed'
  if (status === 'cancelled') return 'aborted'
  return 'interrupted'
}

/** Kernel sessions persist one fsynced receipt journal per kernel session, not per Phi manifest. */
export function readColdKernelChildRuns(
  reference: KernelLocalRuntimeRef
): readonly ColdKernelChildRun[] {
  const path = join(
    reference.host.agentDir,
    'phi-kernel',
    'sessions',
    reference.kernelSessionId,
    KERNEL_RECEIPT_FILE
  )
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return [...parseReceipts(content).values()]
    .flatMap((state): ColdKernelChildRun[] => {
      if (!state.accepted.background || !state.started) return []
      return [
        {
          id: state.started.runId,
          agent: state.accepted.agent,
          background: true,
          status: coldStatus(state.terminal?.status),
          startedAt: state.started.startedAt,
          ...(state.terminal?.completedAt === undefined
            ? {}
            : { completedAt: state.terminal.completedAt })
        }
      ]
    })
    .sort((left, right) => left.startedAt - right.startedAt)
}
