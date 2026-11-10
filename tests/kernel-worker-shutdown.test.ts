import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { KernelRequestFrame } from '../src/shared/kernel-protocol'
import type { KernelCallContext, KernelMethodHandler } from '../src/kernel/protocol'
import { createWorkerKernelAdapter } from '../src/kernel/worker'
import type { PlanRunState, PlanSpec } from '../src/shared/planRunTypes'
import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import { readPlanRun, writePlanRun } from '../src/main/agent/plan/persistence/plan-run-store'

const context: KernelCallContext = {
  controllerGeneration: 1,
  connectionId: 'test',
  trusted: true
}

const lifecycleContext: KernelCallContext = {
  ...context,
  connectionId: 'kernel-lifecycle'
}

const acquireTestGuard = (): { acquired: true; release(): void } => ({
  acquired: true,
  release: () => undefined
})

function request(method: string, sessionId?: string): KernelRequestFrame {
  return {
    kind: 'request',
    id: `${method}-request`,
    method,
    params: {},
    generation: 1,
    ...(sessionId ? { sessionId } : {})
  }
}

function handler(
  handlers: ReturnType<typeof createWorkerKernelAdapter>['handlers'],
  method: keyof typeof handlers
): KernelMethodHandler {
  const value = handlers[method]
  assert.equal(typeof value, 'function')
  return value as KernelMethodHandler
}

test('lifecycle abort persists a terminal receipt before prompt completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-lifecycle-abort-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const never = new Promise<void>(() => undefined)
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await never
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'held', clientRunKey: 'grace-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string }

    await handler(adapter.handlers, 'session.abort')(
      {},
      lifecycleContext,
      request('session.abort', created.sessionId)
    )

    const receipts = readFileSync(
      join(agentDir, 'phi-kernel', 'sessions', created.sessionId, 'runs.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(receipts.at(-1), {
      runId: started.runId,
      state: 'terminal',
      status: 'cancelled',
      at: receipts.at(-1).at
    })
  } finally {
    await adapter.closeAll().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('lifecycle approval denial makes cancelled authoritative before releasing the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-lifecycle-approval-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  let releasePrompt!: () => void
  const promptReleased = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      if (method === 'session.prompt') await promptReleased
      if (method === 'toolApproval.result') {
        releasePrompt()
        return true
      }
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'approval blocked', clientRunKey: 'approval-grace-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string; completion: PromiseLike<string> }
    const denialRequest = request('approval.respond', created.sessionId)
    denialRequest.runId = started.runId
    await handler(adapter.handlers, 'approval.respond')(
      {
        approvalId: 'approval-grace',
        decision: 'denied',
        reason: 'client did not return'
      },
      lifecycleContext,
      denialRequest
    )
    assert.equal(await started.completion, 'cancelled')

    const abortRequest = request('session.abort', created.sessionId)
    abortRequest.runId = started.runId
    await handler(adapter.handlers, 'session.abort')({}, lifecycleContext, abortRequest)

    const receipts = readFileSync(
      join(agentDir, 'phi-kernel', 'sessions', created.sessionId, 'runs.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.filter((receipt) => receipt.state === 'terminal').length, 1)
    assert.equal(receipts.at(-1).status, 'cancelled')
  } finally {
    await adapter.closeAll().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('closeAll disposes loaded sessions, terminalizes active receipts, and releases locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-worker-close-all-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const never = new Promise<void>(() => undefined)
  const calls: string[] = []
  const adapter = createWorkerKernelAdapter({
    agentDir,
    processStartedAt: 'darwin:test-process',
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method) => {
      calls.push(method)
      if (method === 'session.prompt') await never
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'persistent' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }
    const started = (await handler(adapter.handlers, 'session.prompt')(
      { text: 'held', clientRunKey: 'shutdown-key' },
      context,
      request('session.prompt', created.sessionId)
    )) as unknown as { runId: string }
    const directory = join(agentDir, 'phi-kernel', 'sessions', created.sessionId)

    await adapter.closeAll()
    await adapter.closeAll()

    const receipts = readFileSync(join(directory, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(receipts.at(-1).runId, started.runId)
    assert.equal(receipts.at(-1).status, 'cancelled')
    assert.equal(existsSync(join(directory, 'writer.lock')), false)
    assert.equal(calls.filter((method) => method === 'session.abort').length, 1)
    assert.equal(calls.filter((method) => method === 'session.dispose').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const planSpec: PlanSpec = {
  version: 1,
  goal: 'Run one slow step',
  steps: [
    {
      id: 'slow',
      title: 'Slow step',
      instructions: 'Run slowly.',
      acceptance: 'Finished.',
      dependsOn: [],
      access: 'read'
    }
  ]
}

/** A paused plan whose single step already failed twice, ready for an explicit retry. */
function retryablePlan(sessionId: string, runId: string): PlanRunState {
  const at = '2026-11-20T00:00:00.000Z'
  let state = createPlanRunState({ id: runId, sessionId, spec: planSpec, now: at })
  for (const attempt of [1, 2]) {
    state = reducePlanRun(state, {
      type: 'step_launched',
      stepId: 'slow',
      agentRunId: `prior-${attempt}`,
      at
    })
    state = reducePlanRun(state, {
      type: 'step_failed',
      stepId: 'slow',
      error: `prior failure ${attempt}`,
      at
    })
  }
  return state
}

async function startRetriedPlan(
  adapter: ReturnType<typeof createWorkerKernelAdapter>,
  sessionId: string,
  runId: string
): Promise<PlanRunState> {
  const started = await handler(adapter.handlers, 'planRuns.retryStep')(
    { runId, stepId: 'slow' },
    context,
    request('planRuns.retryStep', sessionId)
  )
  return started as unknown as PlanRunState
}

test('session.abort interrupts a running plan step instead of retrying it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-abort-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const planRunId = 'abort-plan'
  const starts: string[] = []
  const adapter = createWorkerKernelAdapter({
    agentDir,
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'session.create') {
        writePlanRun(retryablePlan(String(input.sessionId), planRunId), agentDir)
        return undefined
      }
      if (method === 'agentRun.start') {
        const runId = `plan-child-${starts.length + 1}`
        starts.push(runId)
        return { runId }
      }
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }

    const running = await startRetriedPlan(adapter, created.sessionId, planRunId)
    assert.equal(running.status, 'running')
    assert.equal(running.steps.slow?.status, 'running')
    assert.equal(starts.length, 1)

    await handler(adapter.handlers, 'session.abort')(
      {},
      context,
      request('session.abort', created.sessionId)
    )

    const aborted = (await handler(adapter.handlers, 'planRuns.get')(
      { runId: planRunId },
      context,
      request('planRuns.get', created.sessionId)
    )) as unknown as PlanRunState
    assert.equal(aborted.status, 'paused')
    assert.equal(aborted.steps.slow?.status, 'interrupted')
    assert.equal(aborted.steps.slow?.attempts, 3, 'cancellation is not another attempt')
    assert.deepEqual(aborted.pause, { reason: 'interrupted', stepId: 'slow' })
    assert.equal(starts.length, 1, 'no automatic retry after session.abort')
  } finally {
    await adapter.closeAll().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('closeAll interrupts a running plan step and keeps the session suspended', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-close-all-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(cwd)
  const planRunId = 'close-plan'
  const starts: string[] = []
  const atDispose: { state: PlanRunState | null } = { state: null }
  const adapter = createWorkerKernelAdapter({
    agentDir,
    acquireSessionLockGuard: acquireTestGuard,
    callWorker: async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'session.create') {
        writePlanRun(retryablePlan(String(input.sessionId), planRunId), agentDir)
        return undefined
      }
      if (method === 'agentRun.start') {
        const runId = `plan-child-${starts.length + 1}`
        starts.push(runId)
        return { runId }
      }
      if (method === 'session.dispose') {
        // Disposal runs after stopAll, so the interruption must already be recorded.
        atDispose.state = readPlanRun(String(input.sessionId), planRunId, agentDir)
      }
      return undefined
    }
  })
  try {
    const created = (await handler(adapter.handlers, 'session.create')(
      {
        cwd,
        model: { provider: 'provider', id: 'model' },
        sessionManager: { kind: 'memory' }
      },
      context,
      request('session.create')
    )) as { sessionId: string }

    const running = await startRetriedPlan(adapter, created.sessionId, planRunId)
    assert.equal(running.steps.slow?.status, 'running')
    assert.equal(starts.length, 1)

    await adapter.closeAll()

    assert.equal(atDispose.state?.status, 'paused')
    assert.equal(atDispose.state?.steps.slow?.status, 'interrupted')
    assert.equal(atDispose.state?.steps.slow?.attempts, 3)
    const closed = readPlanRun(created.sessionId, planRunId, agentDir)
    assert.equal(closed?.status, 'paused')
    assert.equal(closed?.steps.slow?.status, 'interrupted')
    assert.equal(closed?.steps.slow?.attempts, 3)
    assert.deepEqual(closed?.pause, { reason: 'interrupted', stepId: 'slow' })
    assert.equal(starts.length, 1, 'no automatic retry during shutdown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
