import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import type { PlanSpec } from '../src/shared/planRunTypes'
import { KernelPlanCoordinator } from '../src/kernel/plans/coordinator'
import { agentRunCompletions } from '../src/main/agent/plan/execution/agent-run-completions'
import { createPlanRunState, reducePlanRun } from '../src/main/agent/plan/model/plan-run-state'
import { readPlanRun, writePlanRun } from '../src/main/agent/plan/persistence/plan-run-store'
import { writeMigrationAtomic } from '../src/kernel/sessions/migration'
import { kernelSessionMigrationPaths } from '../src/kernel/sessions/paths'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function eventually(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await tick()
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function plan(): PlanSpec {
  return {
    version: 1,
    goal: 'Read two inputs before writing the result',
    steps: [
      {
        id: 'read-a',
        title: 'Read A',
        instructions: 'Read A.',
        acceptance: 'A inspected.',
        dependsOn: [],
        access: 'read'
      },
      {
        id: 'read-b',
        title: 'Read B',
        instructions: 'Read B.',
        acceptance: 'B inspected.',
        dependsOn: [],
        access: 'read'
      },
      {
        id: 'write-c',
        title: 'Write C',
        instructions: 'Write C from A and B.',
        acceptance: 'C written.',
        dependsOn: ['read-a', 'read-b'],
        access: 'write',
        writes: ['C.txt']
      }
    ]
  }
}

test('kernel plan coordinator schedules dependencies and asks the main session for the final summary', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-'))
  const sessionId = 'kernel-plan-session'
  const starts: Array<{ runId: string; requestId?: string; task: string }> = []
  const summaryPrompts: string[] = []
  let sequence = 0
  const coordinator = new KernelPlanCoordinator(
    agentDir,
    async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'agentRun.start') {
        const runId = `child-${++sequence}`
        starts.push({
          runId,
          ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {}),
          task: String(input.task)
        })
        return { runId }
      }
      if (method === 'session.prompt') {
        summaryPrompts.push(String(input.text))
        return {}
      }
      if (method === 'agentRun.stop') return { ok: true }
      if (method === 'session.plan.enter') return { enabled: true }
      if (method === 'session.plan.cancel') return true
      throw new Error(`Unexpected worker method: ${method}`)
    },
    () => undefined
  )
  try {
    await coordinator.openSession(sessionId)
    await coordinator.approved(sessionId, plan())
    assert.equal(starts.length, 2, 'independent reads start together')
    assert.ok(
      starts.every((start) => start.requestId),
      'each step has a durable request id'
    )

    for (const start of starts.slice(0, 2)) {
      agentRunCompletions.deliver(sessionId, {
        id: start.runId,
        state: 'done',
        report: `${start.runId} complete`,
        reportStatus: 'completed',
        missingInputs: []
      })
    }
    await eventually(() => starts.length === 3, 'dependent write dispatch')
    assert.match(starts[2].task, /Write C/)

    agentRunCompletions.deliver(sessionId, {
      id: starts[2].runId,
      state: 'done',
      report: 'write complete',
      reportStatus: 'completed',
      missingInputs: []
    })
    await eventually(() => summaryPrompts.length === 1, 'final summary turn')
    const [state] = await coordinator.list(sessionId)
    assert.equal(state.status, 'completed')
    assert.deepEqual(
      state.spec.steps.map((step) => state.steps[step.id]?.status),
      ['done', 'done', 'done']
    )
    assert.match(summaryPrompts[0], /Summarize the outcome/)
  } finally {
    coordinator.closeSession(sessionId)
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('kernel plan retry and replan never repeat a completed step', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-replan-'))
  const sessionId = 'kernel-replan-session'
  const starts: Array<{ runId: string; task: string; requestId?: string }> = []
  let replanRequestId = ''
  let sequence = 0
  const coordinator = new KernelPlanCoordinator(
    agentDir,
    async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'agentRun.start') {
        const runId = `replan-child-${++sequence}`
        starts.push({
          runId,
          task: String(input.task),
          ...(typeof input.requestId === 'string' ? { requestId: input.requestId } : {})
        })
        return { runId }
      }
      if (method === 'session.plan.enter') {
        replanRequestId = String(input.replanRequestId)
        return { enabled: true }
      }
      if (method === 'session.plan.cancel') return true
      if (method === 'agentRun.stop') return { ok: true }
      if (method === 'session.prompt') return {}
      throw new Error(`Unexpected worker method: ${method}`)
    },
    () => undefined
  )
  const original: PlanSpec = {
    version: 1,
    goal: 'Read once, then write',
    steps: [
      {
        id: 'read',
        title: 'Read once',
        instructions: 'Read.',
        acceptance: 'Read.',
        dependsOn: [],
        access: 'read'
      },
      {
        id: 'write',
        title: 'Write',
        instructions: 'Write.',
        acceptance: 'Written.',
        dependsOn: ['read'],
        access: 'write'
      }
    ]
  }
  try {
    await coordinator.openSession(sessionId)
    const run = await coordinator.approved(sessionId, original)
    agentRunCompletions.deliver(sessionId, {
      id: starts[0].runId,
      state: 'done',
      report: 'read complete',
      reportStatus: 'completed',
      missingInputs: []
    })
    await eventually(() => starts.length === 2, 'write dispatch')
    agentRunCompletions.deliver(sessionId, {
      id: starts[1].runId,
      state: 'error',
      error: 'injected write failure'
    })
    await eventually(() => starts.length === 3, 'automatic write retry')
    agentRunCompletions.deliver(sessionId, {
      id: starts[2].runId,
      state: 'error',
      error: 'injected write retry failure'
    })
    let paused = await coordinator.get(sessionId, run.id)
    for (let attempt = 0; paused?.status !== 'paused' && attempt < 100; attempt += 1) {
      await tick()
      paused = await coordinator.get(sessionId, run.id)
    }
    assert.equal(paused?.status, 'paused')

    await coordinator.retryStep(sessionId, run.id, 'write')
    await eventually(() => starts.length === 4, 'explicit write retry')
    agentRunCompletions.deliver(sessionId, {
      id: starts[3].runId,
      state: 'error',
      error: 'injected explicit retry failure'
    })
    paused = await coordinator.get(sessionId, run.id)
    for (let attempt = 0; paused?.status !== 'paused' && attempt < 100; attempt += 1) {
      await tick()
      paused = await coordinator.get(sessionId, run.id)
    }
    assert.equal(paused?.status, 'paused')

    const request = await coordinator.replan(sessionId, run.id)
    assert.equal(request.requestId, replanRequestId)
    const replacement: PlanSpec = {
      ...original,
      steps: [
        ...original.steps,
        {
          id: 'verify',
          title: 'Verify instead',
          instructions: 'Verify without another write.',
          acceptance: 'Verified.',
          dependsOn: ['read'],
          access: 'read'
        }
      ]
    }
    await coordinator.approved(sessionId, replacement, request.requestId)
    await eventually(() => starts.length === 5, 'replacement step dispatch')
    assert.match(starts[4].task, /Verify instead/)
    const replaced = await coordinator.get(sessionId, run.id)
    assert.equal(replaced?.steps.read?.attempts, 1)
    assert.notEqual(starts[0].requestId, starts[4].requestId)
  } finally {
    coordinator.closeSession(sessionId)
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('adopted desktop plan records are imported without changing completed work', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-adopt-'))
  const legacySessionId = 'legacy-phi-session'
  const kernelSessionId = 'adopt-kernel-session'
  const at = '2026-10-26T01:00:00.000Z'
  const spec: PlanSpec = {
    version: 1,
    goal: 'Preserve adopted plan state',
    steps: [
      {
        id: 'step',
        title: 'One step',
        instructions: 'Do it.',
        acceptance: 'Done.',
        dependsOn: [],
        access: 'read'
      }
    ]
  }
  let completed = createPlanRunState({
    id: 'completed-plan',
    sessionId: legacySessionId,
    spec,
    now: at
  })
  completed = reducePlanRun(completed, {
    type: 'step_launched',
    stepId: 'step',
    agentRunId: 'legacy-child-1',
    at
  })
  completed = reducePlanRun(completed, {
    type: 'step_succeeded',
    stepId: 'step',
    report: { status: 'completed', text: 'done', missingInputs: [] },
    at
  })
  let interrupted = createPlanRunState({
    id: 'interrupted-plan',
    sessionId: legacySessionId,
    spec,
    now: at
  })
  interrupted = reducePlanRun(interrupted, {
    type: 'step_launched',
    stepId: 'step',
    agentRunId: 'legacy-child-2',
    at
  })
  writePlanRun(completed, agentDir)
  writePlanRun(interrupted, agentDir)

  const paths = kernelSessionMigrationPaths(agentDir, kernelSessionId)
  mkdirSync(paths.directory, { recursive: true })
  await writeMigrationAtomic(paths.migration, {
    schemaVersion: 1,
    migrationVersion: 1,
    source: {
      kind: 'omp-journal',
      path: join(agentDir, 'legacy.jsonl'),
      cwd: join(agentDir, 'project'),
      size: 0,
      mtime: at,
      sha256: 'a'.repeat(64),
      origin: 'desktop-local',
      phiSessionId: legacySessionId,
      ompSessionId: 'omp-legacy',
      headerVersion: 3,
      headerTimestamp: at
    },
    target: {},
    backup: 'source-backup.jsonl',
    state: 'complete',
    startedAt: at,
    copiedAt: at,
    verifiedAt: at,
    completedAt: at
  })
  const coordinator = new KernelPlanCoordinator(
    agentDir,
    async () => {
      throw new Error('Recovered interrupted work must not dispatch automatically.')
    },
    () => undefined
  )
  try {
    await coordinator.openSession(kernelSessionId)
    const imported = await coordinator.list(kernelSessionId)
    assert.equal(imported.length, 2)
    assert.equal(
      imported.find((state) => state.id === 'completed-plan')?.steps.step?.status,
      'done'
    )
    assert.equal(
      imported.find((state) => state.id === 'interrupted-plan')?.steps.step?.status,
      'interrupted'
    )
    assert.equal(
      readPlanRun(legacySessionId, 'interrupted-plan', agentDir)?.steps.step?.status,
      'running'
    )
  } finally {
    coordinator.closeSession(kernelSessionId)
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('kernel plan skip and stop controls settle only their targeted run', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-controls-'))
  const starts: Array<{ sessionId: string; runId: string }> = []
  let sequence = 0
  const coordinator = new KernelPlanCoordinator(
    agentDir,
    async (method, params) => {
      const input = params as Record<string, unknown>
      if (method === 'agentRun.start') {
        const runId = `control-child-${++sequence}`
        starts.push({ sessionId: String(input.sessionId), runId })
        return { runId }
      }
      if (method === 'agentRun.stop') return { ok: true }
      if (method === 'session.prompt') return {}
      throw new Error(`Unexpected worker method: ${method}`)
    },
    () => undefined
  )
  const spec: PlanSpec = {
    version: 1,
    goal: 'Control one step',
    steps: [
      {
        id: 'only',
        title: 'Only step',
        instructions: 'Run.',
        acceptance: 'Settled.',
        dependsOn: [],
        access: 'read'
      }
    ]
  }
  try {
    await coordinator.openSession('skip-session')
    const skippedRun = await coordinator.approved('skip-session', spec)
    agentRunCompletions.deliver('skip-session', {
      id: starts[0].runId,
      state: 'error',
      error: 'first failure'
    })
    await eventually(() => starts.length === 2, 'automatic retry before skip')
    agentRunCompletions.deliver('skip-session', {
      id: starts[1].runId,
      state: 'error',
      error: 'second failure'
    })
    let skipped = await coordinator.get('skip-session', skippedRun.id)
    for (let attempt = 0; skipped?.status !== 'paused' && attempt < 100; attempt += 1) {
      await tick()
      skipped = await coordinator.get('skip-session', skippedRun.id)
    }
    skipped = await coordinator.skipStep('skip-session', skippedRun.id, 'only')
    assert.equal(skipped.status, 'completed')
    assert.equal(skipped.steps.only?.status, 'skipped')

    await coordinator.openSession('stop-session')
    const stoppedRun = await coordinator.approved('stop-session', spec)
    const stopped = await coordinator.stop('stop-session', stoppedRun.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.steps.only?.status, 'cancelled')
    assert.equal((await coordinator.get('skip-session', skippedRun.id))?.status, 'completed')
  } finally {
    coordinator.closeSession('skip-session')
    coordinator.closeSession('stop-session')
    rmSync(agentDir, { recursive: true, force: true })
  }
})
