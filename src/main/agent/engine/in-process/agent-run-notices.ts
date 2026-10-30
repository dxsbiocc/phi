import { AGENT_RUN_HOST_METHODS } from '../../agents/run-host'
import type { AgentRunRegistry, AgentRunSnapshot } from '../../agents/registry'
import { isRecord } from '../../../../shared/guards'

type HostRequester = (method: string, params: unknown) => Promise<unknown>

type EventBusLike = {
  on(channel: string, listener: (value: unknown) => void): () => void
}

type NativeTaskStep = {
  id: string
  toolName: string
  status: 'running' | 'done' | 'error'
  args?: unknown
  output?: string
  error?: string
  createdAt?: string
  completedAt?: string
  durationMs?: number
}

type NativeTaskState = {
  id: string
  agent?: string
  task?: string
  parentToolCallId?: string
  detached?: boolean
  started: boolean
  pendingSteps: NativeTaskStep[]
  stepStarts: Map<string, string>
  latestProgress?: Record<string, unknown>
  report?: string
  error?: string
  queue: Promise<void>
}

const TASK_SUBAGENT_EVENT_CHANNEL = 'task:subagent:event'
const TASK_SUBAGENT_LIFECYCLE_CHANNEL = 'task:subagent:lifecycle'
const TASK_SUBAGENT_PROGRESS_CHANNEL = 'task:subagent:progress'

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field ? field : undefined
}

function finiteNumberField(
  value: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const field = value?.[key]
  return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : undefined
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!isRecord(part)) return ''
        if (part.type === 'text' && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (!isRecord(value)) return ''
  if (Array.isArray(value.content)) {
    const content = textFromContent(value.content)
    if (content) return content
  }
  if (typeof value.output === 'string') return value.output
  if (typeof value.text === 'string') return value.text
  return ''
}

function resultText(value: unknown): string {
  const direct = textFromContent(value)
  if (direct) return direct
  if (!isRecord(value) || !isRecord(value.details)) return ''
  const data = value.details.data
  if (typeof data === 'string') return data
  if (data === undefined) return ''
  try {
    return JSON.stringify(data, null, 2) ?? ''
  } catch {
    return String(data)
  }
}

function yieldTextFromAssistant(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return ''
  const text = textFromContent(message.content)
  let yielded = ''
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== 'toolCall' || part.name !== 'yield') continue
    const args = isRecord(part.arguments) ? part.arguments : undefined
    const data = args?.data
    if (typeof data === 'string') yielded = data
    else if (data !== undefined) {
      try {
        yielded = JSON.stringify(data, null, 2) ?? ''
      } catch {
        yielded = String(data)
      }
    }
  }
  return yielded || text
}

function elapsedMs(startedAt: string | undefined, completedAt: string): number | undefined {
  if (!startedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}

function enqueueHostRequest(
  state: NativeTaskState,
  requestHost: HostRequester,
  method: string,
  params: Record<string, unknown>
): void {
  state.queue = state.queue
    .then(() => requestHost(method, params))
    .then(() => undefined)
    .catch(() => undefined)
}

function commonNativeTaskParams(
  sessionId: string,
  state: NativeTaskState
): Record<string, unknown> {
  return {
    originSessionId: sessionId,
    nativeTaskId: state.id,
    agent: state.agent ?? 'task'
  }
}

function projectNativeTaskStep(
  state: NativeTaskState,
  event: Record<string, unknown>
): NativeTaskStep | undefined {
  const toolCallId = stringField(event, 'toolCallId')
  const toolName = stringField(event, 'toolName')
  if (!toolCallId || !toolName) return undefined
  const now = new Date().toISOString()
  if (event.type === 'tool_execution_start') {
    state.stepStarts.set(toolCallId, now)
    return {
      id: toolCallId,
      toolName,
      status: 'running',
      ...(event.args !== undefined ? { args: event.args } : {}),
      createdAt: now
    }
  }
  if (event.type !== 'tool_execution_end') return undefined
  const createdAt = state.stepStarts.get(toolCallId)
  state.stepStarts.delete(toolCallId)
  const output = resultText(event.result)
  if (toolName === 'yield' && output) state.report = output
  const isError = event.isError === true
  return {
    id: toolCallId,
    toolName,
    status: isError ? 'error' : 'done',
    ...(output ? { output } : {}),
    ...(isError && output ? { error: output } : {}),
    ...(createdAt ? { createdAt } : {}),
    completedAt: now,
    ...(elapsedMs(createdAt, now) !== undefined ? { durationMs: elapsedMs(createdAt, now) } : {})
  }
}

type NativeTaskNoticeOptions = {
  eventBus: EventBusLike
  sessionId: string
  requestHost: HostRequester
}

function updateNativeTaskIdentity(state: NativeTaskState, value: Record<string, unknown>): void {
  state.agent = stringField(value, 'agent') ?? state.agent
  state.parentToolCallId = stringField(value, 'parentToolCallId') ?? state.parentToolCallId
  if (typeof value.detached === 'boolean') state.detached = value.detached
}

function nativeTaskEndState(status: unknown): 'done' | 'error' | 'cancelled' | undefined {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'aborted') return 'cancelled'
  return undefined
}

function nativeTaskCompletionParams(
  sessionId: string,
  state: NativeTaskState,
  endState: 'done' | 'error' | 'cancelled'
): Record<string, unknown> {
  const progress = state.latestProgress
  const retryFailure = isRecord(progress?.retryFailure) ? progress.retryFailure : undefined
  const recentOutput = Array.isArray(progress?.recentOutput)
    ? progress.recentOutput.filter((item): item is string => typeof item === 'string')
    : []
  const report =
    state.report ?? (recentOutput.length ? [...recentOutput].reverse().join('\n') : undefined)
  const error =
    state.error ??
    (typeof retryFailure?.errorMessage === 'string' ? retryFailure.errorMessage : undefined)
  const durationMs = finiteNumberField(progress, 'durationMs')
  const toolCalls = finiteNumberField(progress, 'toolCount')
  return {
    ...commonNativeTaskParams(sessionId, state),
    state: endState,
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {})
  }
}

class NativeTaskNoticeProjector {
  private readonly states = new Map<string, NativeTaskState>()

  constructor(private readonly options: NativeTaskNoticeOptions) {}

  stateFor(id: string): NativeTaskState {
    let state = this.states.get(id)
    if (!state) {
      state = {
        id,
        started: false,
        pendingSteps: [],
        stepStarts: new Map(),
        queue: Promise.resolve()
      }
      this.states.set(id, state)
    }
    return state
  }

  sendStep(state: NativeTaskState, step: NativeTaskStep): void {
    if (!state.started) {
      state.pendingSteps.push(step)
      return
    }
    enqueueHostRequest(state, this.options.requestHost, AGENT_RUN_HOST_METHODS.nativeTaskStep, {
      ...commonNativeTaskParams(this.options.sessionId, state),
      step
    })
  }

  start(state: NativeTaskState): void {
    if (state.started || !state.task || !state.parentToolCallId) return
    state.started = true
    const common = commonNativeTaskParams(this.options.sessionId, state)
    enqueueHostRequest(state, this.options.requestHost, AGENT_RUN_HOST_METHODS.nativeTaskStarted, {
      ...common,
      task: state.task,
      parentToolCallId: state.parentToolCallId
    })
    if (state.detached) {
      enqueueHostRequest(
        state,
        this.options.requestHost,
        AGENT_RUN_HOST_METHODS.nativeTaskBackground,
        common
      )
    }
    for (const step of state.pendingSteps.splice(0)) this.sendStep(state, step)
  }

  readonly lifecycle = (value: unknown): void => {
    if (!isRecord(value)) return
    const id = stringField(value, 'id')
    if (!id) return
    const state = this.stateFor(id)
    updateNativeTaskIdentity(state, value)
    if (value.status === 'started') return
    const endState = nativeTaskEndState(value.status)
    if (!endState) return
    if (!state.task) state.task = stringField(value, 'description') ?? 'Native task'
    this.start(state)
    enqueueHostRequest(
      state,
      this.options.requestHost,
      AGENT_RUN_HOST_METHODS.nativeTaskFinished,
      nativeTaskCompletionParams(this.options.sessionId, state, endState)
    )
    void state.queue.finally(() => this.states.delete(id))
  }

  readonly progress = (value: unknown): void => {
    if (!isRecord(value) || !isRecord(value.progress)) return
    const id = stringField(value, 'id') ?? stringField(value.progress, 'id')
    if (!id) return
    const state = this.stateFor(id)
    state.agent = stringField(value, 'agent') ?? stringField(value.progress, 'agent') ?? state.agent
    state.task = stringField(value, 'task') ?? stringField(value.progress, 'task') ?? state.task
    updateNativeTaskIdentity(state, value)
    state.latestProgress = value.progress
    this.start(state)
  }

  readonly event = (value: unknown): void => {
    if (!isRecord(value) || !isRecord(value.event)) return
    const id = stringField(value, 'id')
    if (!id) return
    const state = this.stateFor(id)
    const event = value.event
    const step = projectNativeTaskStep(state, event)
    if (step) this.sendStep(state, step)
    if (event.type !== 'message_end' || !isRecord(event.message)) return
    const message = event.message
    if (message.role !== 'assistant') return
    const report = yieldTextFromAssistant(message)
    if (report) state.report = report
    if (message.stopReason === 'error' && typeof message.errorMessage === 'string') {
      state.error = message.errorMessage
    }
  }

  clear(): void {
    this.states.clear()
  }
}

/**
 * Projects OMP's native task EventBus feeds into the same durable card events used by Phi
 * specialists. Native children deliberately carry no Phi run-control IDs: the current desktop
 * stop/steer APIs address AgentRunRegistry, not OMP's AgentRegistry.
 */
export function subscribeToNativeTaskRunNotices(options: NativeTaskNoticeOptions): () => void {
  const projector = new NativeTaskNoticeProjector(options)
  const detachLifecycle = options.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, projector.lifecycle)
  const detachProgress = options.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, projector.progress)
  const detachEvents = options.eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, projector.event)

  return () => {
    detachEvents()
    detachProgress()
    detachLifecycle()
    projector.clear()
  }
}

function isHostRun(run: AgentRunSnapshot): boolean {
  return run.origin === 'host'
}

export function subscribeToAgentRunNotices(options: {
  registry: AgentRunRegistry
  sessionId: string
  requestHost: HostRequester
}): () => void {
  return options.registry.subscribe({
    onFinish: (run) => {
      if (!run.background) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.finished, {
          originSessionId: options.sessionId,
          run
        })
        .catch(() => undefined)
    },
    onStep: (run, step) => {
      if (!run.background || isHostRun(run)) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.step, {
          originSessionId: options.sessionId,
          run: { id: run.id, agent: run.agent, toolCallId: run.toolCallId },
          step
        })
        .catch(() => undefined)
    },
    onReported: (run) => {
      if (!run.background || isHostRun(run)) return
      void options
        .requestHost(AGENT_RUN_HOST_METHODS.reported, {
          originSessionId: options.sessionId,
          runId: run.id
        })
        .catch(() => undefined)
    }
  })
}
