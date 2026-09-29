import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUN_HOST_METHODS,
  agentRunHostHandlers,
  type AgentRunHostDeps
} from '../src/main/agent/agents/run-host'
import {
  agentRunContinuationPrompt,
  continuationPrompt,
  shouldContinueAfterAgentRun
} from '../src/main/agent/agents/run-continue'
import { MAX_AUTOMATIC_CONTINUATIONS } from '../src/main/agent/wrappers/composition/job-continue'
import { agentRunNotice, type AgentRunFinishedEvent } from '../src/shared/agentRunNotice'
import type { WrapperRunFinishedEvent } from '../src/shared/wrapperRunNotice'

const DONE: AgentRunFinishedEvent = {
  type: 'agent_run_finished',
  agentRunId: 'run_1',
  agent: 'Wrapper',
  state: 'done',
  task: 'Run fastqc on /data/reads',
  elapsedSeconds: 125,
  toolCalls: 6,
  report: 'FastQC finished. Reports are in /data/qc.'
}

const FAILED: AgentRunFinishedEvent = {
  ...DONE,
  agentRunId: 'run_2',
  state: 'error',
  report: undefined,
  error: 'The Wrapper agent failed: model unavailable'
}

// ── notice ───────────────────────────────────────────────────────────────

test('the notice names the agent, the task, the time and the run id', () => {
  const notice = agentRunNotice(DONE)
  assert.equal(notice.title, 'Wrapper 后台任务已完成')
  assert.match(notice.body, /Run fastqc on \/data\/reads/)
  assert.match(notice.body, /2 分 5 秒/)
  assert.match(notice.body, /run_1/)
})

test('the notice says why a run failed and titles a cancelled one as such', () => {
  const failed = agentRunNotice(FAILED)
  assert.equal(failed.title, 'Wrapper 后台任务失败')
  assert.match(failed.body, /model unavailable/)
  assert.equal(agentRunNotice({ ...DONE, state: 'cancelled' }).title, 'Wrapper 后台任务已取消')
})

test('a long task is shortened in the notice', () => {
  const notice = agentRunNotice({ ...DONE, task: 'x'.repeat(500) })
  assert.ok(notice.body.length < 300)
})

// ── policy ───────────────────────────────────────────────────────────────

test('an ended run wakes the conversation, unless it was cancelled or the wake-up cap is reached', () => {
  assert.deepEqual(shouldContinueAfterAgentRun({ state: 'done', automaticCount: 0 }), {
    continue: true
  })
  assert.deepEqual(shouldContinueAfterAgentRun({ state: 'error', automaticCount: 0 }), {
    continue: true
  })
  assert.deepEqual(shouldContinueAfterAgentRun({ state: 'cancelled', automaticCount: 0 }), {
    continue: false,
    reason: 'cancelled'
  })
  assert.deepEqual(
    shouldContinueAfterAgentRun({ state: 'done', automaticCount: MAX_AUTOMATIC_CONTINUATIONS }),
    { continue: false, reason: 'limit' }
  )
})

// ── prompt ───────────────────────────────────────────────────────────────

test('the wake-up message tells the model it is from Phi and hands over the reports', () => {
  const text = agentRunContinuationPrompt([DONE, FAILED])
  assert.match(text, /^<phi_agent_run_finished>/)
  assert.match(text, /not from the user/)
  assert.match(text, /run_1 · Wrapper · done/)
  assert.match(text, /FastQC finished\. Reports are in \/data\/qc\./)
  assert.match(text, /run_2 · Wrapper · error/)
  assert.match(text, /model unavailable/)
  assert.match(text, /closing reply must name the new or modified files with exact paths/)
  assert.match(text, /<\/phi_agent_run_finished>$/)
})

test('the wake-up message caps a huge report', () => {
  const text = agentRunContinuationPrompt([{ ...DONE, report: 'r'.repeat(50000) }])
  assert.ok(text.length < 25000)
  assert.match(text, /truncated/)
})

test('one wake-up can carry both wrapper and agent runs', () => {
  const wrapperEvent: WrapperRunFinishedEvent = {
    type: 'wrapper_run_finished',
    wrapperRunId: 'wrun_1',
    wrapperId: 'nf-core/modules/fastqc',
    state: 'completed',
    exitCode: 0,
    outDir: '/data/qc',
    elapsedSeconds: 42
  }
  const both = continuationPrompt([wrapperEvent, DONE])
  assert.match(both, /<phi_wrapper_run_finished>/)
  assert.match(both, /<phi_agent_run_finished>/)
  assert.doesNotMatch(continuationPrompt([DONE]), /phi_wrapper_run_finished/)
  assert.doesNotMatch(continuationPrompt([wrapperEvent]), /phi_agent_run_finished/)
})

// ── host handlers ────────────────────────────────────────────────────────

interface Calls {
  appended: Array<{ phiSessionId: string; event: Record<string, unknown> }>
  sent: Array<Record<string, unknown>>
  notifications: Array<{ title: string; body: string }>
  continued: Array<{ phiSessionId: string; event: AgentRunFinishedEvent }>
  reported: string[]
  cleared: string[]
  persisted: Array<{ phiSessionId: string; toolCallId: string; stepId: string; output: string }>
}

function harness(overrides: Partial<AgentRunHostDeps> = {}): {
  calls: Calls
  handlers: ReturnType<typeof agentRunHostHandlers>
} {
  const calls: Calls = {
    appended: [],
    sent: [],
    notifications: [],
    continued: [],
    reported: [],
    cleared: [],
    persisted: []
  }
  const handlers = agentRunHostHandlers({
    resolveSession: (origin) =>
      origin === 'runtime-1' ? { phiSessionId: 'phi-1', cwd: '/projects/x' } : undefined,
    appendToSession: (phiSessionId, event) => {
      calls.appended.push({ phiSessionId, event })
      return { ...event, eventId: 'e1' }
    },
    sendToWindow: (payload) => calls.sent.push(payload),
    isAppFocused: () => true,
    showOsNotification: (notification) => calls.notifications.push(notification),
    continueConversation: (phiSessionId, event) => calls.continued.push({ phiSessionId, event }),
    redact: (text) => text.replace(/sk-\w+/g, '[redacted]'),
    markReported: (phiSessionId, agentRunId) =>
      calls.reported.push(`${phiSessionId}/${agentRunId}`),
    clearReported: (phiSessionId, agentRunId) =>
      calls.cleared.push(`${phiSessionId}/${agentRunId}`),
    persistStepOutput: (phiSessionId, toolCallId, stepId, output) => {
      calls.persisted.push({ phiSessionId, toolCallId, stepId, output })
      return output.length > 20
        ? {
            outputPreview: `${output.slice(0, 20)}…`,
            outputBytes: output.length,
            truncated: true,
            outputPath: '/tmp/out.txt'
          }
        : { outputPreview: output, outputBytes: output.length, truncated: false }
    },
    redactValue: (value) => JSON.parse(JSON.stringify(value).replace(/sk-\w+/g, '[redacted]')),
    ...overrides
  })
  return { calls, handlers }
}

const finishedParams = (overrides: Record<string, unknown> = {}): unknown => ({
  originSessionId: 'runtime-1',
  run: {
    id: 'run_1',
    agent: 'Wrapper',
    task: 'align reads',
    state: 'done',
    background: true,
    startedAt: 1_000,
    completedAt: 43_000,
    toolCalls: 3,
    report: 'Aligned. Output in /data/bam.',
    ...overrides
  }
})

test('a finished run is recorded in the conversation, pushed to the window, and wakes it', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams())

  assert.equal(calls.appended.length, 1)
  assert.equal(calls.appended[0].phiSessionId, 'phi-1')
  const event = calls.appended[0].event as unknown as AgentRunFinishedEvent
  assert.equal(event.type, 'agent_run_finished')
  assert.equal(event.agentRunId, 'run_1')
  assert.equal(event.agent, 'Wrapper')
  assert.equal(event.state, 'done')
  assert.equal(event.elapsedSeconds, 42)
  assert.equal(event.report, 'Aligned. Output in /data/bam.')

  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].phiSessionId, 'phi-1')
  assert.equal(calls.sent[0].cwd, '/projects/x')
  assert.equal(calls.sent[0].source, 'phi')

  assert.deepEqual(
    calls.continued.map((entry) => [entry.phiSessionId, entry.event.agentRunId]),
    [['phi-1', 'run_1']]
  )
  assert.deepEqual(calls.notifications, [], 'the window is focused')
  assert.deepEqual(
    calls.cleared,
    ['phi-1/run_1'],
    'stale receipts from an older session are dropped'
  )
})

test('secrets in the task, report or error are redacted before anything is stored', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](
    finishedParams({
      task: 'use key sk-abc123',
      report: 'token sk-def456 worked',
      state: 'error',
      error: 'bad key sk-ghi789'
    })
  )
  const event = calls.appended[0].event as unknown as AgentRunFinishedEvent
  assert.doesNotMatch(JSON.stringify(event), /sk-/)
})

test('an oversized report is capped before it is stored', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams({ report: 'r'.repeat(90000) }))
  const event = calls.appended[0].event as unknown as AgentRunFinishedEvent
  assert.ok((event.report ?? '').length <= 20100)
})

test('an unfocused Phi also raises a system notification, except for a cancellation', async () => {
  const { calls, handlers } = harness({ isAppFocused: () => false })
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams())
  assert.equal(calls.notifications.length, 1)
  assert.equal(calls.notifications[0].title, 'Wrapper 后台任务已完成')

  await handlers[AGENT_RUN_HOST_METHODS.finished](
    finishedParams({ id: 'run_2', state: 'cancelled', report: undefined })
  )
  assert.equal(calls.notifications.length, 1)
})

test('a run from a conversation Phi does not know only gets the system notification', async () => {
  const { calls, handlers } = harness({ isAppFocused: () => false })
  await handlers[AGENT_RUN_HOST_METHODS.finished]({
    ...(finishedParams() as Record<string, unknown>),
    originSessionId: 'runtime-unknown'
  })
  assert.equal(calls.appended.length, 0)
  assert.equal(calls.continued.length, 0)
  assert.equal(calls.notifications.length, 1)
})

test('a failure in one channel never stops the others', async () => {
  const { calls, handlers } = harness({
    appendToSession: () => {
      throw new Error('disk full')
    },
    continueConversation: () => {
      throw new Error('cannot wake')
    },
    isAppFocused: () => false
  })
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams())
  assert.equal(calls.notifications.length, 1)
})

test('malformed worker input is rejected', async () => {
  const { calls, handlers } = harness()
  const finished = handlers[AGENT_RUN_HOST_METHODS.finished]
  await assert.rejects(finished(undefined), /originSessionId/)
  await assert.rejects(finished({ originSessionId: 'runtime-1' }), /run/)
  await assert.rejects(finished(finishedParams({ state: 'running' })), /state/)
  await assert.rejects(finished(finishedParams({ id: '' })), /id/)
  assert.equal(calls.appended.length, 0)
})

test('the worker reports that the main agent has already been handed a run', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.reported]({ originSessionId: 'runtime-1', runId: 'run_1' })
  assert.deepEqual(calls.reported, ['phi-1/run_1'])

  await handlers[AGENT_RUN_HOST_METHODS.reported]({
    originSessionId: 'runtime-unknown',
    runId: 'run_9'
  })
  assert.deepEqual(calls.reported, ['phi-1/run_1'])
  await assert.rejects(handlers[AGENT_RUN_HOST_METHODS.reported]({ originSessionId: 'x' }), /runId/)
})

// ── the card in the chat: progress and completion of a background run ────

const stepParams = (
  step: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): unknown => ({
  originSessionId: 'runtime-1',
  run: { id: 'run_1', agent: 'Wrapper', toolCallId: 'call-9', ...overrides },
  step
})

test('a background run’s tool step becomes a step event for its card', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.step](
    stepParams({
      id: 's1',
      toolName: 'wrapper_run',
      status: 'running',
      args: { id: 'fastqc', token: 'sk-abc123' },
      createdAt: '2026-09-20T10:00:00.000Z'
    })
  )

  assert.equal(calls.appended.length, 1)
  assert.equal(calls.appended[0].phiSessionId, 'phi-1')
  const event = calls.appended[0].event as Record<string, unknown>
  assert.equal(event.type, 'agent_execution_step')
  assert.equal(event.toolCallId, 'call-9')
  assert.equal(event.agentName, 'Wrapper')
  assert.equal(event.agentRunId, 'run_1')
  assert.equal(event.agentSessionId, 'runtime-1')
  const step = event.step as Record<string, unknown>
  assert.equal(step.id, 's1')
  assert.equal(step.status, 'running')
  assert.doesNotMatch(JSON.stringify(step.args), /sk-/)
  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].phiSessionId, 'phi-1')
  assert.deepEqual(calls.notifications, [])
  assert.deepEqual(calls.continued, [], 'progress never wakes the agent')
})

test('a long step output is stored aside and only its preview goes into the event', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.step](
    stepParams({ id: 's1', toolName: 'bash', status: 'done', output: 'o'.repeat(100) })
  )
  assert.deepEqual(calls.persisted, [
    { phiSessionId: 'phi-1', toolCallId: 'call-9', stepId: 's1', output: 'o'.repeat(100) }
  ])
  const step = (calls.appended[0].event as { step: Record<string, unknown> }).step
  assert.equal(step.outputTruncated, true)
  assert.equal(step.outputPath, '/tmp/out.txt')
  assert.equal(step.outputBytes, 100)
  assert.ok(String(step.output).length < 40)
})

test('a failed step keeps its redacted error', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.step](
    stepParams({ id: 's1', toolName: 'bash', status: 'error', error: 'bad key sk-zzz' })
  )
  const step = (calls.appended[0].event as { step: Record<string, unknown> }).step
  assert.equal(step.status, 'error')
  assert.doesNotMatch(String(step.error), /sk-/)
})

test('steps from an unknown conversation, or from a run with no card, are dropped', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.step]({
    ...(stepParams({ id: 's1', toolName: 'read', status: 'running' }) as Record<string, unknown>),
    originSessionId: 'runtime-unknown'
  })
  await handlers[AGENT_RUN_HOST_METHODS.step](
    stepParams({ id: 's1', toolName: 'read', status: 'running' }, { toolCallId: undefined })
  )
  assert.equal(calls.appended.length, 0)
})

test('malformed step input is rejected', async () => {
  const { handlers } = harness()
  const step = handlers[AGENT_RUN_HOST_METHODS.step]
  await assert.rejects(
    step({ originSessionId: 'runtime-1', run: { id: 'run_1', agent: 'W' } }),
    /step/
  )
  await assert.rejects(step(stepParams({ toolName: 'read', status: 'running' })), /step\.id/)
})

test('a finished run also completes its card with the report', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams({ toolCallId: 'call-9' }))

  const completion = calls.appended.find(
    (entry) => entry.event.type === 'agent_execution_completed'
  )?.event as Record<string, unknown>
  assert.ok(completion, 'the card is completed')
  assert.equal(completion.toolCallId, 'call-9')
  assert.equal(completion.agentName, 'Wrapper')
  assert.equal(completion.agentRunId, 'run_1')
  assert.equal(completion.isError, false)
  assert.equal(completion.finalReport, 'Aligned. Output in /data/bam.')
  assert.equal(completion.toolCalls, 3)
  assert.ok(
    calls.appended.findIndex((entry) => entry.event.type === 'agent_execution_completed') <
      calls.appended.findIndex((entry) => entry.event.type === 'agent_run_finished'),
    'the card is completed before the notice'
  )
})

test('a failed run completes its card as an error with the reason', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](
    finishedParams({
      toolCallId: 'call-9',
      state: 'error',
      report: undefined,
      error: 'The Wrapper agent failed: boom'
    })
  )
  const completion = calls.appended
    .map((entry) => entry.event)
    .find((event) => event.type === 'agent_execution_completed')
  assert.ok(completion)
  assert.equal(completion.isError, true)
  assert.match(String(completion.error), /boom/)
  assert.equal(completion.cancelled, undefined)
})

test('a cancelled run completes its card as cancelled, not as a failure', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](
    finishedParams({
      toolCallId: 'call-10',
      state: 'cancelled',
      report: undefined,
      error: 'The Wrapper agent was cancelled.'
    })
  )
  const completion = calls.appended
    .map((entry) => entry.event)
    .find((event) => event.type === 'agent_execution_completed')
  assert.ok(completion)
  assert.equal(completion.cancelled, true)
  assert.equal(completion.isError, false)
  assert.equal(completion.error, undefined, 'the English cancellation text is not for the card')
})

test('a run without a card is still announced, just not completed', async () => {
  const { calls, handlers } = harness()
  await handlers[AGENT_RUN_HOST_METHODS.finished](finishedParams())
  assert.equal(
    calls.appended.some((entry) => entry.event.type === 'agent_execution_completed'),
    false
  )
  assert.equal(
    calls.appended.some((entry) => entry.event.type === 'agent_run_finished'),
    true
  )
})
