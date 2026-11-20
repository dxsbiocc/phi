import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  PlanRunFinishedEvent,
  PlanRunState,
  ResearchPlanPausedEvent
} from '../src/shared/planRunTypes'
import { projectKernelEvent } from '../src/main/agent/engine/kernel-event-projection'
import type { SessionBinding } from '../src/main/agent/engine/kernel-session-support'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { scientificReport } from '../src/main/agent/agents/research-handoff'
import { continuationPrompt } from '../src/main/agent/agents/run-continue'
import { planRunTimelineSnapshot } from '../src/main/agent/plan/plan-run-service'
import { createKernelPlanRunCompletion } from '../src/main/agent/plan/kernel-plan-run-completion'
import {
  appendSessionEvent,
  createPhiSession,
  readSessionEvents
} from '../src/main/agent/session/session-store'
import { readPhiTimelineMessages } from '../src/main/agent/session/phi-timeline-messages'
import { SessionRunnerRegistry } from '../src/main/agent/session/session-runner-registry'
import { createCreatedSessionEvents } from '../src/main/session-runtime/created-session-events'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'

const CONTINUATION_REPLY = '节点 A 到 F 的最短路径是 A → B → F。'

async function withPhiDir<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-kernel-plan-continuation-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(phiDir, { recursive: true, force: true })
  }
}

function finishedPlan(sessionId: string): PlanRunFinishedEvent {
  const state: PlanRunState = {
    id: 'plan-route',
    sessionId,
    spec: {
      version: 1,
      goal: 'Find the shortest route from A to F',
      steps: [
        {
          id: 'read-graph',
          title: 'Read the graph',
          instructions: 'Read the graph.',
          acceptance: 'Graph read.',
          dependsOn: [],
          access: 'read'
        },
        {
          id: 'compute',
          title: 'Compute the route',
          instructions: 'Compute it.',
          acceptance: 'Route computed.',
          dependsOn: ['read-graph'],
          access: 'read'
        }
      ]
    },
    status: 'completed',
    steps: {
      'read-graph': {
        status: 'done',
        attempts: 1,
        report: { status: 'completed', text: 'Read A-F.', missingInputs: [] }
      },
      compute: {
        status: 'done',
        attempts: 1,
        report: { status: 'completed', text: 'Shortest route is A-B-F.', missingInputs: [] }
      }
    },
    replans: 0,
    createdAt: '2020-11-10T00:00:00.000Z',
    updatedAt: '2020-11-10T00:01:00.000Z'
  }
  return { type: 'plan_run_finished', runId: state.id, state }
}

function remoteSession(): { sessionId: string; cwd: string } {
  const cwd = '/remote/project'
  const session = createPhiSession({
    kind: 'project',
    projectId: 'remote-project',
    projectLocation: {
      kind: 'ssh',
      hostProfileId: 'remote-host',
      remoteRoot: '/remote/project',
      canonicalRoot: '/remote/project'
    },
    cwd,
    cwdRealPath: cwd,
    permissionMode: 'auto',
    workMode: 'plan_execute'
  })
  return { sessionId: session.sessionId, cwd }
}

function continuationHarness(phiSessionId: string): {
  start: () => Promise<void>
} {
  const runId = 'continuation-1'
  const run = {
    phiSessionId,
    runId,
    recordedFailureMessage: undefined as string | undefined,
    stoppingPermanentProviderError: false,
    thinkingBlocks: new Map<number, string>(),
    thinkingBlockStartedAtMs: new Map<number, number>(),
    compactionReasons: new Map<string, string>(),
    agentToolCallIds: new Set<string>(),
    sdkToolCallIds: new Set<string>(),
    browserSdkToolCallIds: new Set<string>(),
    persistedToolCallIds: new Set<string>(),
    pendingProviderToolCalls: new Map()
  }
  const session = {
    sessionFile: undefined,
    subscribe: () => () => undefined
  }
  const createdSessionEvents = createCreatedSessionEvents({
    state: {
      promptRuns: { activeRun: () => run },
      sessionKeys: { phiSessionIdFor: () => phiSessionId }
    },
    persistence: {
      storage: {
        appendSessionEvent,
        persistToolOutput: () => ({ outputPreview: '', outputBytes: 0, truncated: false }),
        toolOutputInlineLimit: 20_000
      },
      extractAssistantText: () => '',
      redactStructuredValue: (value) => value
    },
    runtime: {
      redactSensitiveText: String,
      abortSessionWithoutCancellingApprovals: async () => undefined,
      phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
    },
    events: {
      publish: () => undefined,
      logUnexpectedError: () => undefined
    }
  })
  const context = {
    sessionKey: 'phi-session-key',
    generation: 1,
    snapshot: { path: undefined, cwd: '/remote/project', permissionMode: 'auto' as const },
    lifecycle: { isCurrentGeneration: () => true }
  }
  const registry = new SessionRunnerRegistry()
  return {
    async start() {
      await registry.startRun({
        sessionId: phiSessionId,
        runId,
        execute: async () => {
          const result = { session }
          createdSessionEvents.handleCreatedSessionEvent(context, result, {
            type: 'message_start',
            message: { role: 'assistant', content: [] }
          })
          createdSessionEvents.handleCreatedSessionEvent(context, result, {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: CONTINUATION_REPLY }]
            }
          })
        }
      }).done
    }
  }
}

function timelineItems(
  phiSessionId: string,
  cwd: string
): ReturnType<typeof chatItemsFromSessionMessages> {
  return chatItemsFromSessionMessages(readPhiTimelineMessages(null, cwd, phiSessionId))
}

test('a finished kernel plan starts a continuation whose events are stored like a normal run', async () => {
  await withPhiDir(async () => {
    const { sessionId } = remoteSession()
    const event = finishedPlan('kernel-session-route')
    const continuation = continuationHarness(sessionId)
    let continued = 0
    let continuationDone = Promise.resolve()
    const completion = createKernelPlanRunCompletion({
      timeline: { read: readSessionEvents, append: appendSessionEvent },
      snapshot: planRunTimelineSnapshot,
      continueConversation: () => {
        continued += 1
        continuationDone = continuation.start()
      }
    })

    assert.equal(completion.handleFinished(sessionId, event), true)
    await continuationDone
    assert.equal(continued, 1)

    assert.deepEqual(
      readSessionEvents(sessionId).map((stored) => stored.type),
      ['plan_run_finished', 'run_started', 'assistant_message_finalized', 'run_completed']
    )
    const reply = readSessionEvents(sessionId).find(
      (stored) => stored.type === 'assistant_message_finalized'
    )
    assert.equal(reply?.content, CONTINUATION_REPLY)
    assert.equal(reply?.runId, 'continuation-1')
  })
})

test('reopening a remote kernel conversation restores one completed plan card and the continuation reply', async () => {
  await withPhiDir(async () => {
    const { sessionId, cwd } = remoteSession()
    const event = finishedPlan('kernel-session-route')
    const continuation = continuationHarness(sessionId)
    let continued = 0
    let continuationDone = Promise.resolve()
    const completion = createKernelPlanRunCompletion({
      timeline: { read: readSessionEvents, append: appendSessionEvent },
      snapshot: planRunTimelineSnapshot,
      continueConversation: () => {
        continued += 1
        continuationDone = continuation.start()
      }
    })

    assert.equal(completion.handleFinished(sessionId, event), true)
    await continuationDone
    // The kernel replays the same finish after a reconnect; it must not add a second card
    // and must not wake the agent a second time.
    assert.equal(completion.handleFinished(sessionId, event), false)
    assert.equal(continued, 1)

    const items = timelineItems(sessionId, cwd)
    assert.equal(
      items.filter((item) => item.role === 'plan_run').length,
      1,
      'the completed plan card appears exactly once'
    )
    const plan = items.find((item) => item.role === 'plan_run')
    assert.ok(plan && plan.role === 'plan_run')
    assert.equal(plan.run.goal, 'Find the shortest route from A to F')
    assert.deepEqual(
      items.flatMap((item) => (item.role === 'assistant' ? [item.content] : [])),
      [CONTINUATION_REPLY]
    )
  })
})

test('a stopped plan is kept in the transcript without waking the agent', async () => {
  await withPhiDir(async () => {
    const { sessionId, cwd } = remoteSession()
    const event = finishedPlan('kernel-session-route')
    event.state = { ...event.state, status: 'stopped' }
    let continued = 0
    const completion = createKernelPlanRunCompletion({
      timeline: { read: readSessionEvents, append: appendSessionEvent },
      snapshot: planRunTimelineSnapshot,
      continueConversation: () => {
        continued += 1
      }
    })

    assert.equal(completion.handleFinished(sessionId, event), true)
    assert.equal(continued, 0)
    const items = timelineItems(sessionId, cwd)
    assert.equal(items.filter((item) => item.role === 'plan_run').length, 1)
  })
})

test('a paused research stage asks for a missing donor map once across replay and desktop restart', async () => {
  await withPhiDir(async () => {
    const { sessionId } = remoteSession()
    const question = 'Which genes changed across donors?'
    const state = finishedPlan('kernel-session-1').state
    state.spec = { ...state.spec, researchQuestion: question, steps: [state.spec.steps[0]] }
    state.status = 'paused'
    state.pause = { reason: 'needs_input', stepId: 'read-graph' }
    const report = scientificReport(question, 'blocked', {
      missingInputs: ['donor-to-sample mapping'],
      research: {
        subquestion: 'Can we estimate the planned contrast?',
        answer: 'The donor column is missing.',
        interpretation: 'Independent biological replicates cannot be determined.',
        rationale: 'Complete the sample mapping before inference.',
        evidence: ['qc/sample_inventory.tsv']
      }
    })
    assert.ok(report.structured)
    state.steps = { 'read-graph': { status: 'failed', attempts: 1, report } }
    const prompts: string[] = []
    const bind = (): ReturnType<typeof createKernelPlanRunCompletion> =>
      createKernelPlanRunCompletion({
        timeline: { read: readSessionEvents, append: appendSessionEvent },
        snapshot: planRunTimelineSnapshot,
        continueConversation: () => assert.fail('A paused plan has not finished')
      })
    const binding = {
      params: { phiSessionId: sessionId },
      logicalSessionId: 'kernel-session-1',
      kernelSessionId: state.sessionId,
      sink: { event: () => undefined }
    } as unknown as SessionBinding
    function deliver(completion: ReturnType<typeof bind>): void {
      const payload = JSON.parse(
        JSON.stringify({
          event: 'plan_run_updated',
          fullState: state,
          state: planRunTimelineSnapshot(state)
        })
      ) as Record<string, JsonValue>
      const frame: KernelEventFrame = {
        kind: 'event',
        seq: 1,
        type: 'planRun.updated',
        sessionId: state.sessionId,
        payload
      }
      projectKernelEvent(binding, frame, payload, undefined, (target, _, pause) => {
        assert.equal(target, sessionId)
        if (pause && completion.claimResearchPause(target, pause)) {
          const { runId, stepId, attempt } = pause
          appendSessionEvent(target, {
            type: 'run_started',
            runId: 'continuation-' + attempt,
            researchPauses: [{ runId, stepId, attempt }]
          })
          prompts.push(continuationPrompt([pause]))
          completion.releaseResearchPause(target, pause)
        }
      })
    }
    const completion = bind()
    deliver(completion)
    deliver(completion)
    deliver(bind())
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].includes(question))
    assert.match(prompts[0], /donor-to-sample mapping/)
    assert.match(prompts[0], /qc\/sample_inventory\.tsv/)
    assert.match(prompts[0], /ask a focused question/)
    assert.equal(readSessionEvents(sessionId).filter((e) => e.type === 'run_started').length, 1)
    state.pause = { reason: 'user' }
    deliver(completion)
    delete state.spec.researchQuestion
    state.pause = { reason: 'step_failed', stepId: 'read-graph' }
    deliver(completion)
    assert.equal(prompts.length, 1)
    state.spec.researchQuestion = question
    state.steps['read-graph'] = {
      status: 'failed',
      attempts: 2,
      error: 'PRIVATE-INTERMEDIATE-FAILURE-LOG'
    }
    deliver(completion)
    deliver(bind())
    assert.equal(prompts.length, 2)
    assert.match(prompts[1], /No verified scientific handoff/)
    assert.doesNotMatch(prompts[1], /PRIVATE-INTERMEDIATE/)
  })
})

test('a failed research wake admission can replay; admitted or explicitly dismissed attempts cannot', async () => {
  await withPhiDir(async () => {
    const { sessionId } = remoteSession()
    const busy = remoteSession().sessionId
    const paused: ResearchPlanPausedEvent = {
      type: 'research_plan_paused',
      runId: 'research-7',
      stepId: 'de',
      attempt: 1,
      reason: 'needs_input',
      originalQuestion: 'Which genes changed?'
    }
    const bind = (): ReturnType<typeof createKernelPlanRunCompletion> =>
      createKernelPlanRunCompletion({
        timeline: { read: readSessionEvents, append: appendSessionEvent },
        snapshot: planRunTimelineSnapshot,
        continueConversation: () => assert.fail('not a finished plan')
      })
    const registry = new SessionRunnerRegistry({ maxActiveRuns: 1 })
    const block = Promise.withResolvers<void>()
    const occupied = registry.startRun({
      sessionId: busy,
      runId: 'occupied',
      execute: () => block.promise
    })
    const delivery = {
      sessionId,
      runId: 'wake',
      researchPauses: [{ runId: paused.runId, stepId: paused.stepId, attempt: paused.attempt }],
      execute: async () => undefined
    }
    const original = bind()
    assert.equal(original.claimResearchPause(sessionId, paused), true)
    assert.equal(original.claimResearchPause(sessionId, paused), false)
    assert.throws(() => registry.startRun(delivery), /上限/)
    original.releaseResearchPause(sessionId, paused)
    assert.equal(readSessionEvents(sessionId).length, 0)
    block.resolve()
    await occupied.done

    const restarted = bind()
    assert.equal(restarted.claimResearchPause(sessionId, paused), true)
    await registry.startRun(delivery).done
    restarted.releaseResearchPause(sessionId, paused)
    assert.equal(bind().claimResearchPause(sessionId, paused), false)
    const differentAttempt = { ...paused, attempt: 2 }
    assert.equal(restarted.claimResearchPause(sessionId, differentAttempt), true)
    restarted.dismissResearchPause(sessionId, differentAttempt)
    restarted.releaseResearchPause(sessionId, differentAttempt)
    assert.equal(bind().claimResearchPause(sessionId, differentAttempt), false)
    assert.equal(
      readSessionEvents(sessionId).filter((event) => event.type === 'run_started').length,
      1
    )
  })
})
