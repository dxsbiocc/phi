import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { createKernelFixture } from './engine-contract/kernel-factory'

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected object')
  }
  return value
}

function waitForApproval(
  events: KernelEventFrame[],
  predicate: (payload: Record<string, JsonValue>) => boolean
): Promise<{ event: KernelEventFrame; payload: Record<string, JsonValue> }> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const tick = (): void => {
      const found = events.find((event) => {
        if (event.type !== 'approval.requested') return false
        const payload = event.payload
        return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          ? predicate(payload as Record<string, JsonValue>)
          : false
      })
      if (found) {
        resolve({ event: found, payload: record(found.payload) })
        return
      }
      if (Date.now() >= deadline) reject(new Error('approval.requested timeout'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

async function startChildAndApproval(
  f: Awaited<ReturnType<typeof createKernelFixture>>,
  sessionId: string
): Promise<{ runId: string }> {
  f.provider.enqueue({
    tool: {
      name: 'bash',
      id: 'child-bash',
      args: { command: '/bin/bash true', cwd: f.cwd }
    }
  })
  const started = record(
    await f.client.request(
      'agentRuns.start',
      { requestId: 'child-request', agent: 'PlanStep', task: 'Run the controlled child command.' },
      { sessionId }
    )
  )
  const runId = String(started.runId)
  assert.ok(runId)
  return { runId }
}

test(
  'session.abort without a parent cancels a child approval in the session',
  { timeout: 30_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    const events: KernelEventFrame[] = []
    const stop = f.client.onEvent((event) => events.push(event))
    t.after(stop)
    await f.createSession('child-abort', { cwd: f.cwd, enableToolApproval: true, phiAgents: true })
    const sessionId = f.kernelSessionId('child-abort')!
    const { runId } = await startChildAndApproval(f, sessionId)
    const approval = await waitForApproval(events, (payload) => payload.agentRunId === runId)
    assert.equal(record(approval.event.payload).toolName, 'bash')

    await f.client.request('session.abort', {}, { sessionId })
    const cancelled = events.find(
      (event) =>
        event.type === 'interaction.cancelled' &&
        record(event.payload).id === approval.payload.approvalId
    )
    assert.ok(cancelled, 'child approval cancellation event')
    assert.equal(record(cancelled.payload).reason, 'session aborted')
    const runs = (await f.client.request('agentRuns.list', {}, { sessionId })) as unknown as Array<
      Record<string, JsonValue>
    >
    assert.equal(runs.find((run) => run.runId === runId)?.state, 'cancelled')
  }
)

test(
  'session.abort with a live parent leaves child cleanup to the real child registry stop chain',
  { timeout: 30_000 },
  async (t) => {
    const f = await createKernelFixture()
    t.after(() => f.close())
    const events: KernelEventFrame[] = []
    const stop = f.client.onEvent((event) => events.push(event))
    t.after(stop)
    await f.createSession('child-abort-parent', {
      cwd: f.cwd,
      enableToolApproval: true,
      phiAgents: true
    })
    const sessionId = f.kernelSessionId('child-abort-parent')!
    f.provider.enqueue(
      { text: 'Hold the parent prompt.', hold: true, match: 'Hold the parent.' },
      {
        match: 'Run the controlled child command.',
        tool: {
          name: 'bash',
          id: 'child-bash',
          args: { command: '/bin/bash true', cwd: f.cwd }
        }
      }
    )
    const parent = f.sessions.prompt({ sessionId: 'child-abort-parent', text: 'Hold the parent.' })
    void parent.catch(() => undefined)
    let observedParentRunId: string | undefined
    const activeDeadline = Date.now() + 10_000
    while (Date.now() < activeDeadline) {
      const snapshot = record(await f.client.request('session.snapshot', {}, { sessionId }))
      if (typeof snapshot.activeRunId === 'string') {
        observedParentRunId = snapshot.activeRunId
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    assert.ok(observedParentRunId, 'parent prompt must be active before starting its child')
    const started = record(
      await f.client.request(
        'agentRuns.start',
        {
          requestId: 'child-parent-request',
          agent: 'PlanStep',
          task: 'Run the controlled child command.'
        },
        { sessionId }
      )
    )
    const runId = String(started.runId)
    const approval = await waitForApproval(events, (payload) => payload.agentRunId === runId)
    const activeBeforeAbort = record(await f.client.request('session.snapshot', {}, { sessionId }))
    assert.equal(
      activeBeforeAbort.activeRunId,
      observedParentRunId,
      'same parent remains active at abort'
    )
    await f.client.request('session.abort', {}, { sessionId })
    const cancelled = events.find(
      (event) =>
        event.type === 'interaction.cancelled' &&
        record(event.payload).id === approval.payload.approvalId
    )
    assert.ok(cancelled, 'child approval cancellation event')
    assert.equal(record(cancelled.payload).reason, 'agent run ended')
    const runs = (await f.client.request('agentRuns.list', {}, { sessionId })) as unknown as Array<
      Record<string, JsonValue>
    >
    assert.equal(runs.find((run) => run.runId === runId)?.state, 'cancelled')
    await parent.catch(() => undefined)
  }
)
