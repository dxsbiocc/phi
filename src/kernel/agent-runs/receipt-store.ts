import { randomUUID } from 'node:crypto'
import { chmod, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentRunSnapshotDto } from '../../shared/kernel-protocol'
import type { AgentLaunchInput, AgentRunSnapshot } from '../../main/agent/agents/registry'
import { makeProtocolError } from '../protocol/errors'
import { pauseKernelTestPoint } from '../test-pause'

const RECEIPT_FILE = 'agent-runs.jsonl'
const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_REQUEST_ID_BYTES = 256

type AcceptedReceipt = {
  state: 'accepted'
  requestId: string
  agent: string
  task: string
  origin: 'tool' | 'host'
  background: boolean
  at: string
}

type StartedReceipt = {
  state: 'started'
  requestId: string
  runId: string
  startedAt: number
  toolCallId?: string
  at: string
}

type TerminalReceipt = {
  state: 'terminal'
  requestId: string
  runId?: string
  status: 'done' | 'error' | 'cancelled' | 'unknown'
  completedAt?: number
  toolCalls?: number
  report?: string
  reportStatus?: 'completed' | 'partial' | 'not_found' | 'blocked' | 'failed'
  missingInputs?: string[]
  error?: string
  lastStep?: string
  reported?: boolean
  at: string
}

type ReportedReceipt = {
  state: 'reported'
  requestId: string
  runId: string
  at: string
}

type AgentRunReceipt = AcceptedReceipt | StartedReceipt | TerminalReceipt | ReportedReceipt

type ReceiptState = {
  accepted: AcceptedReceipt
  started?: StartedReceipt
  terminal?: TerminalReceipt
  reported?: ReportedReceipt
  finishing?: Promise<void>
  reporting?: Promise<void>
}

type SessionReceipts = {
  path?: string
  requests: Map<string, ReceiptState>
  runs: Map<string, ReceiptState>
  assigned: Map<string, string>
  tail: Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

type ReceiptBase = { requestId: string; at: string }

function parseAccepted(
  input: Record<string, unknown>,
  base: ReceiptBase
): AcceptedReceipt | undefined {
  const agent = string(input.agent)
  const validOrigin = input.origin === 'tool' || input.origin === 'host'
  if (!agent || typeof input.task !== 'string' || !validOrigin) return undefined
  if (typeof input.background !== 'boolean') return undefined
  return {
    state: 'accepted',
    ...base,
    agent,
    task: input.task,
    origin: input.origin as 'tool' | 'host',
    background: input.background
  }
}

function parseStarted(
  input: Record<string, unknown>,
  base: ReceiptBase
): StartedReceipt | undefined {
  const runId = string(input.runId)
  if (!runId || typeof input.startedAt !== 'number') return undefined
  if (!Number.isFinite(input.startedAt)) return undefined
  const toolCallId = string(input.toolCallId)
  return {
    state: 'started',
    ...base,
    runId,
    startedAt: input.startedAt,
    ...(toolCallId ? { toolCallId } : {})
  }
}

function parseReported(
  input: Record<string, unknown>,
  base: ReceiptBase
): ReportedReceipt | undefined {
  const runId = string(input.runId)
  return runId ? { state: 'reported', ...base, runId } : undefined
}

function parseTerminal(
  input: Record<string, unknown>,
  base: ReceiptBase
): TerminalReceipt | undefined {
  const status = input.status
  if (status !== 'done' && status !== 'error' && status !== 'cancelled' && status !== 'unknown') {
    return undefined
  }
  return { ...(input as unknown as TerminalReceipt), ...base, state: 'terminal', status }
}

function parseReceipt(value: unknown): AgentRunReceipt | undefined {
  const input = record(value)
  if (!input) return undefined
  const state = string(input.state)
  const requestId = string(input.requestId)
  const at = string(input.at)
  if (!requestId || !at) return undefined
  const base = { requestId, at }
  if (state === 'accepted') return parseAccepted(input, base)
  if (state === 'started') return parseStarted(input, base)
  if (state === 'reported') return parseReported(input, base)
  return state === 'terminal' ? parseTerminal(input, base) : undefined
}

function indexReceipts(receipts: readonly AgentRunReceipt[]): SessionReceipts {
  const requests = new Map<string, ReceiptState>()
  const runs = new Map<string, ReceiptState>()
  for (const receipt of receipts) {
    if (receipt.state === 'accepted') {
      if (requests.has(receipt.requestId)) throw new Error('agent-run receipt repeats requestId')
      requests.set(receipt.requestId, { accepted: receipt })
      continue
    }
    const state = requests.get(receipt.requestId)
    if (!state) throw new Error('agent-run receipt has no accepted request')
    if (receipt.state === 'started') {
      if (state.started || state.terminal || runs.has(receipt.runId)) {
        throw new Error('agent-run receipt repeats a child start')
      }
      state.started = receipt
      runs.set(receipt.runId, state)
    } else if (receipt.state === 'terminal') {
      if (state.terminal) throw new Error('agent-run receipt repeats a terminal state')
      state.terminal = receipt
    } else {
      if (!state.started || state.started.runId !== receipt.runId || state.reported) {
        throw new Error('agent-run reported receipt is unmatched')
      }
      state.reported = receipt
    }
  }
  return { requests, runs, assigned: new Map(), tail: Promise.resolve() }
}

async function append(path: string, receipt: AgentRunReceipt): Promise<void> {
  const content = `${JSON.stringify(receipt)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_RECEIPT_BYTES) {
    throw new Error('agent-run receipt exceeds its size limit')
  }
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

async function readReceipts(path: string): Promise<AgentRunReceipt[]> {
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return []
    throw error
  }
  const complete = content.endsWith('\n')
  const lines = content.split('\n')
  if (complete) lines.pop()
  const receipts: AgentRunReceipt[] = []
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    const receipt = (() => {
      try {
        return parseReceipt(JSON.parse(line))
      } catch {
        return undefined
      }
    })()
    if (!receipt && !complete && index === lines.length - 1) break
    if (!receipt) throw new Error(`agent-run receipt ${index + 1} is corrupt`)
    if (Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_BYTES) {
      throw new Error(`agent-run receipt ${index + 1} exceeds its size limit`)
    }
    receipts.push(receipt)
  }
  return receipts
}

async function repairTail(path: string): Promise<void> {
  let content: Buffer
  try {
    content = await readFile(path)
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return
    throw error
  }
  if (content.length === 0 || content[content.length - 1] === 0x0a) return
  const lastNewline = content.lastIndexOf(0x0a)
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(lastNewline + 1)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function terminalReceipt(requestId: string, snapshot: AgentRunSnapshot): TerminalReceipt {
  return {
    state: 'terminal',
    requestId,
    runId: snapshot.id,
    status: snapshot.state as TerminalReceipt['status'],
    ...(snapshot.completedAt === undefined ? {} : { completedAt: snapshot.completedAt }),
    ...(snapshot.toolCalls === undefined ? {} : { toolCalls: snapshot.toolCalls }),
    ...(snapshot.report ? { report: snapshot.report } : {}),
    ...(snapshot.reportStatus ? { reportStatus: snapshot.reportStatus } : {}),
    ...(snapshot.missingInputs?.length ? { missingInputs: [...snapshot.missingInputs] } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.lastStep ? { lastStep: snapshot.lastStep } : {}),
    ...(snapshot.reported ? { reported: true } : {}),
    at: new Date().toISOString()
  }
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined)
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function currentState(
  live: AgentRunSnapshot | undefined,
  terminal: TerminalReceipt | undefined,
  started: StartedReceipt | undefined
): AgentRunSnapshotDto['state'] {
  if (live) return live.state
  if (terminal) return terminal.status
  return started ? 'started' : 'accepted'
}

function timingFields(
  live: AgentRunSnapshot | undefined,
  started: StartedReceipt | undefined,
  terminal: TerminalReceipt | undefined
): Record<string, unknown> {
  return {
    ...optional('startedAt', firstDefined(live?.startedAt, started?.startedAt)),
    ...optional('completedAt', firstDefined(live?.completedAt, terminal?.completedAt))
  }
}

function outcomeFields(
  live: AgentRunSnapshot | undefined,
  terminal: TerminalReceipt | undefined
): Record<string, unknown> {
  const missingInputs = firstDefined(live?.missingInputs, terminal?.missingInputs)
  return {
    ...optional('toolCalls', firstDefined(live?.toolCalls, terminal?.toolCalls)),
    ...optional('report', firstDefined(live?.report, terminal?.report)),
    ...optional('reportStatus', firstDefined(live?.reportStatus, terminal?.reportStatus)),
    ...optional('missingInputs', missingInputs ? [...missingInputs] : undefined),
    ...optional('error', firstDefined(live?.error, terminal?.error)),
    ...optional('lastStep', firstDefined(live?.lastStep, terminal?.lastStep))
  }
}

function bookkeepingFields(
  state: ReceiptState,
  live: AgentRunSnapshot | undefined,
  started: StartedReceipt | undefined,
  terminal: TerminalReceipt | undefined
): Record<string, unknown> {
  const reported = live?.reported || terminal?.reported || state.reported ? true : undefined
  return {
    ...optional('reported', reported),
    ...optional('toolCallId', firstDefined(live?.toolCallId, started?.toolCallId))
  }
}

function view(state: ReceiptState, live?: AgentRunSnapshot): AgentRunSnapshotDto {
  const terminal = state.terminal
  const started = state.started
  const runId = firstDefined(live?.id, started?.runId, terminal?.runId)
  return {
    requestId: state.accepted.requestId,
    ...optional('runId', runId),
    agent: state.accepted.agent,
    task: state.accepted.task,
    state: currentState(live, terminal, started),
    origin: state.accepted.origin,
    background: state.accepted.background,
    acceptedAt: state.accepted.at,
    ...timingFields(live, started, terminal),
    ...outcomeFields(live, terminal),
    ...bookkeepingFields(state, live, started, terminal)
  } as AgentRunSnapshotDto
}

export class KernelAgentRunReceiptStore {
  private readonly sessions = new Map<string, SessionReceipts>()

  constructor(private readonly agentDir: string) {}

  async openSession(sessionId: string, directory?: string): Promise<void> {
    if (this.sessions.has(sessionId)) return
    const path = directory ? join(directory, RECEIPT_FILE) : undefined
    if (path) {
      const handle = await open(path, 'a', 0o600)
      await handle.sync()
      await handle.close()
      await chmod(path, 0o600)
      await repairTail(path)
    }
    const session = indexReceipts(path ? await readReceipts(path) : [])
    session.path = path
    this.sessions.set(sessionId, session)
    for (const state of session.requests.values()) {
      if (state.terminal) continue
      const terminal: TerminalReceipt = {
        state: 'terminal',
        requestId: state.accepted.requestId,
        ...(state.started ? { runId: state.started.runId } : {}),
        status: 'unknown',
        error: 'kernel exited before the child reached a proven terminal state',
        at: new Date().toISOString()
      }
      await this.append(session, terminal)
      state.terminal = terminal
    }
  }

  private require(sessionId: string): SessionReceipts {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Agent-run receipts are unavailable for session ${sessionId}`)
    return session
  }

  private async append(session: SessionReceipts, receipt: AgentRunReceipt): Promise<void> {
    if (!session.path) return
    const operation = session.tail.then(() => append(session.path!, receipt))
    session.tail = operation.catch(() => undefined)
    await operation
  }

  async accept(sessionId: string, runId: string, input: AgentLaunchInput): Promise<void> {
    const session = this.require(sessionId)
    const requestId = input.requestId?.trim() || randomUUID()
    if (Buffer.byteLength(requestId, 'utf8') > MAX_REQUEST_ID_BYTES) {
      throw makeProtocolError('INVALID_PARAMS', 'agentRuns.start requestId is too long.')
    }
    const duplicate = session.requests.get(requestId)
    if (duplicate) {
      throw makeProtocolError(
        'DUPLICATE_REQUEST',
        'The agent-run request was already accepted.',
        view(duplicate)
      )
    }
    const receipt: AcceptedReceipt = {
      state: 'accepted',
      requestId,
      agent: input.agent,
      task: input.task,
      origin: input.origin ?? 'tool',
      background: input.background,
      at: new Date().toISOString()
    }
    await this.append(session, receipt)
    session.requests.set(requestId, { accepted: receipt })
    session.assigned.set(runId, requestId)
    pauseKernelTestPoint('agent-accepted', this.agentDir)
  }

  async started(sessionId: string, runId: string, snapshot: AgentRunSnapshot): Promise<void> {
    const session = this.require(sessionId)
    const requestId = session.assigned.get(runId)
    const state = requestId ? session.requests.get(requestId) : undefined
    if (!requestId || !state || state.terminal) throw new Error('agent-run acceptance is missing')
    const receipt: StartedReceipt = {
      state: 'started',
      requestId,
      runId,
      startedAt: snapshot.startedAt,
      ...(snapshot.toolCallId ? { toolCallId: snapshot.toolCallId } : {}),
      at: new Date().toISOString()
    }
    await this.append(session, receipt)
    state.started = receipt
    session.runs.set(runId, state)
    pauseKernelTestPoint('agent-started', this.agentDir)
  }

  async unknown(sessionId: string, runId: string, error: unknown): Promise<void> {
    const session = this.sessions.get(sessionId)
    const requestId = session?.assigned.get(runId)
    const state = requestId ? session?.requests.get(requestId) : undefined
    if (!session || !requestId || !state || state.terminal) return
    const receipt: TerminalReceipt = {
      state: 'terminal',
      requestId,
      ...(state.started ? { runId } : {}),
      status: 'unknown',
      error: error instanceof Error ? error.message : 'child registration failed',
      at: new Date().toISOString()
    }
    await this.append(session, receipt)
    state.terminal = receipt
  }

  async finish(sessionId: string, snapshot: AgentRunSnapshot): Promise<AgentRunSnapshotDto | null> {
    const session = this.require(sessionId)
    const state = session.runs.get(snapshot.id)
    if (!state) return null
    state.finishing ??= (async () => {
      if (state.terminal) return
      const receipt = terminalReceipt(state.accepted.requestId, snapshot)
      await this.append(session, receipt)
      state.terminal = receipt
    })()
    await state.finishing
    return view(state, snapshot)
  }

  async reported(sessionId: string, runId: string): Promise<AgentRunSnapshotDto | null> {
    const session = this.require(sessionId)
    const state = session.runs.get(runId)
    if (!state?.started) return null
    state.reporting ??= (async () => {
      if (state.reported) return
      const receipt: ReportedReceipt = {
        state: 'reported',
        requestId: state.accepted.requestId,
        runId,
        at: new Date().toISOString()
      }
      await this.append(session, receipt)
      state.reported = receipt
    })()
    await state.reporting
    return view(state)
  }

  getByRequest(sessionId: string, requestId: string): AgentRunSnapshotDto | undefined {
    const state = this.require(sessionId).requests.get(requestId)
    return state ? view(state) : undefined
  }

  getByRun(
    sessionId: string,
    runId: string,
    live?: AgentRunSnapshot
  ): AgentRunSnapshotDto | undefined {
    const state = this.require(sessionId).runs.get(runId)
    return state ? view(state, live) : undefined
  }

  list(sessionId: string, live: readonly AgentRunSnapshot[] = []): AgentRunSnapshotDto[] {
    const session = this.require(sessionId)
    const liveRuns = new Map(live.map((run) => [run.id, run]))
    return [...session.requests.values()].map((state) =>
      view(state, state.started ? liveRuns.get(state.started.runId) : undefined)
    )
  }

  hasUnfinished(sessionId: string): boolean {
    return [...this.require(sessionId).requests.values()].some((state) => !state.terminal)
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await session.tail
    this.sessions.delete(sessionId)
  }

  async flush(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.tail))
  }
}
