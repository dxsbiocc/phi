import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_RUN_HOST_METHODS, agentRunHostHandlers } from '../src/main/agent/agents/run-host'
import { subscribeToNativeTaskRunNotices } from '../src/main/agent/engine/in-process/agent-run-notices'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'
import { runningAgentRuns } from '../src/renderer/src/lib/agentRunsOverview'

class FakeEventBus {
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()

  on(channel: string, listener: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return () => listeners.delete(listener)
  }

  emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(value)
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

test('native task observer projects one read-only card lifecycle per OMP child', async () => {
  const eventBus = new FakeEventBus()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const stop = subscribeToNativeTaskRunNotices({
    eventBus,
    sessionId: 'runtime-session',
    requestHost: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      return { ok: true }
    }
  })

  eventBus.emit('task:subagent:lifecycle', {
    id: 'native-child',
    agent: 'task',
    parentToolCallId: 'outer-task',
    detached: true,
    status: 'started'
  })
  eventBus.emit('task:subagent:event', {
    id: 'native-child',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'read-1',
      toolName: 'read',
      args: { path: 'README.md' }
    }
  })
  eventBus.emit('task:subagent:progress', {
    id: 'native-child',
    agent: 'task',
    task: 'Read README.md',
    parentToolCallId: 'outer-task',
    detached: true,
    progress: {
      id: 'native-child',
      agent: 'task',
      status: 'running',
      task: 'Read README.md',
      durationMs: 25,
      toolCount: 1
    }
  })
  eventBus.emit('task:subagent:event', {
    id: 'native-child',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'read-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '# Phi' }] },
      isError: false
    }
  })
  eventBus.emit('task:subagent:event', {
    id: 'native-child',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            name: 'yield',
            arguments: { data: '# Phi\nDesktop agent' }
          }
        ]
      }
    }
  })
  eventBus.emit('task:subagent:progress', {
    id: 'native-child',
    agent: 'task',
    task: 'Read README.md',
    parentToolCallId: 'outer-task',
    detached: true,
    progress: {
      id: 'native-child',
      agent: 'task',
      status: 'completed',
      task: 'Read README.md',
      durationMs: 1250,
      toolCount: 2
    }
  })
  eventBus.emit('task:subagent:lifecycle', {
    id: 'native-child',
    agent: 'task',
    parentToolCallId: 'outer-task',
    detached: true,
    status: 'completed'
  })

  await until(
    () => calls.some((call) => call.method === AGENT_RUN_HOST_METHODS.nativeTaskFinished),
    'native task completion projection'
  )
  stop()

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      AGENT_RUN_HOST_METHODS.nativeTaskStarted,
      AGENT_RUN_HOST_METHODS.nativeTaskBackground,
      AGENT_RUN_HOST_METHODS.nativeTaskStep,
      AGENT_RUN_HOST_METHODS.nativeTaskStep,
      AGENT_RUN_HOST_METHODS.nativeTaskFinished
    ]
  )
  assert.equal(calls[0]?.params.task, 'Read README.md')
  assert.equal(calls[0]?.params.parentToolCallId, 'outer-task')
  assert.equal(calls.at(-1)?.params.report, '# Phi\nDesktop agent')
  assert.equal(calls.at(-1)?.params.durationMs, 1250)
  assert.equal(calls.at(-1)?.params.toolCalls, 2)
})

test('native task host events persist a durable card without Phi run controls', async () => {
  const appended: Record<string, unknown>[] = []
  const sent: Record<string, unknown>[] = []
  const handlers = agentRunHostHandlers({
    resolveSession: (originSessionId) =>
      originSessionId === 'runtime-session'
        ? { phiSessionId: 'phi-session', cwd: '/project' }
        : undefined,
    appendToSession: (_sessionId, event) => {
      const stored = {
        ...event,
        eventId: `event-${appended.length + 1}`,
        createdAt: '2026-10-29T00:00:00.000Z'
      }
      appended.push(stored)
      return stored
    },
    sendToWindow: (payload) => sent.push(payload),
    isAppFocused: () => true,
    showOsNotification: () => undefined,
    redact: (text) => text.replaceAll('secret', '[redacted]'),
    persistStepOutput: (_sessionId, _toolCallId, stepId, output) => ({
      outputPreview: output,
      outputBytes: output.length,
      truncated: false,
      outputPath: `/outputs/${stepId}.txt`
    }),
    redactValue: (value) => value,
    markReported: () => undefined,
    clearReported: () => undefined,
    deliverHostRun: () => false
  })

  const common = {
    originSessionId: 'runtime-session',
    nativeTaskId: 'native-child',
    agent: 'task'
  }
  await handlers[AGENT_RUN_HOST_METHODS.nativeTaskStarted]?.({
    ...common,
    task: 'Read secret README',
    parentToolCallId: 'outer-task'
  })
  await handlers[AGENT_RUN_HOST_METHODS.nativeTaskBackground]?.(common)
  await handlers[AGENT_RUN_HOST_METHODS.nativeTaskStep]?.({
    ...common,
    step: {
      id: 'read-1',
      toolName: 'read',
      status: 'done',
      args: { path: 'README.md' },
      output: 'secret output'
    }
  })
  await handlers[AGENT_RUN_HOST_METHODS.nativeTaskFinished]?.({
    ...common,
    state: 'done',
    report: 'secret result',
    durationMs: 1250,
    toolCalls: 2
  })

  assert.deepEqual(
    appended.map((event) => event.type),
    [
      'agent_execution_started',
      'agent_execution_background',
      'agent_execution_step',
      'agent_execution_completed'
    ]
  )
  assert.ok(appended.every((event) => event.toolCallId === 'native-task:native-child'))
  assert.equal(appended[0]?.task, 'Read [redacted] README')
  assert.equal(appended[2]?.agentRunId, undefined)
  assert.equal(appended[2]?.agentSessionId, undefined)
  assert.equal(appended[3]?.finalReport, '[redacted] result')
  assert.equal(appended[3]?.durationMs, 1250)
  assert.equal(sent.length, 4)
})

test('persisted native task events restore into the live overview as a read-only child card', () => {
  const events = [
    {
      source: 'phi',
      type: 'agent_execution_started',
      eventId: 'native-started',
      toolCallId: 'native-task:native-child',
      agentName: 'task',
      task: 'Read README.md',
      args: { task: 'Read README.md', parentToolCallId: 'outer-task' },
      createdAt: '2026-10-29T00:00:00.000Z'
    },
    {
      source: 'phi',
      type: 'agent_execution_background',
      eventId: 'native-background',
      toolCallId: 'native-task:native-child',
      agentName: 'task',
      createdAt: '2026-10-29T00:00:00.001Z'
    },
    {
      source: 'phi',
      type: 'agent_execution_step',
      eventId: 'native-step',
      toolCallId: 'native-task:native-child',
      agentName: 'task',
      step: { id: 'read-1', toolName: 'read', status: 'running' },
      createdAt: '2026-10-29T00:00:00.002Z'
    }
  ]
  const items = chatItemsFromSessionMessages(events)
  const [entry] = runningAgentRuns(items, new Set())

  assert.equal(entry.id, 'native-task:native-child')
  assert.equal(entry.agentName, 'task')
  assert.equal(entry.background, true)
  assert.equal(entry.currentStep, 'read')
  assert.equal(entry.control, null)

  const restored = chatItemsFromSessionMessages([
    ...events,
    {
      source: 'phi',
      type: 'agent_execution_completed',
      eventId: 'native-finished',
      toolCallId: 'native-task:native-child',
      agentName: 'task',
      isError: false,
      finalReport: '# Phi',
      toolCalls: 2,
      createdAt: '2026-10-29T00:00:01.250Z'
    }
  ])
  const card = restored.find((item) => item.role === 'agent_execution')
  assert.equal(card?.role, 'agent_execution')
  if (card?.role !== 'agent_execution') return
  assert.equal(card.status, 'done')
  assert.equal(card.finalReport, '# Phi')
  assert.equal(card.durationMs, 1250)
  assert.deepEqual(runningAgentRuns(restored, new Set()), [])
})
