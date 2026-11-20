import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { KernelPlanCoordinator } from '../src/kernel/plans/coordinator'
import type { KernelProtocolCore } from '../src/kernel/protocol'
import { scientificReport } from '../src/main/agent/agents/research-handoff'
import { KernelSessionFactory } from '../src/main/agent/engine/kernel-session-factory'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import { createKernelPlanRunCompletion } from '../src/main/agent/plan/kernel-plan-run-completion'
import { planRunTimelineSnapshot } from '../src/main/agent/plan/plan-run-service'
import { writePlanRun } from '../src/main/agent/plan/persistence/plan-run-store'
import {
  appendSessionEvent,
  createPhiSession,
  readSessionEvents,
  recordKernelRuntimeReference
} from '../src/main/agent/session/session-store'
import type { JsonValue } from '../src/shared/kernel-protocol'
import type { PlanRunState } from '../src/shared/planRunTypes'
import { FakeKernelClient, legacyEngine, params } from './helpers/kernelSessionFactoryFake'

test('a cold reopen delivers an unclaimed scientific pause after binding and honors the admitted receipt on subsequent opens', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-cold-research-pause-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { force: true, recursive: true })
  })
  const desktop = createPhiSession({
    kind: 'ordinary',
    cwd: '/project',
    cwdRealPath: '/project',
    permissionMode: 'ask',
    workMode: 'plan_execute'
  })
  const kernelSessionId = 'kernel-research-reopen'
  recordKernelRuntimeReference(desktop.sessionId, {
    kind: 'phi-kernel',
    version: 1,
    kernelSessionId,
    host: { kind: 'local', agentDir: root }
  })
  const question = 'Which genes changed across donors?'
  const report = scientificReport(question, 'blocked', {
    missingInputs: ['donor-to-sample mapping'],
    research: {
      subquestion: 'Is the primary contrast estimable?',
      answer: 'Donor mapping is missing.',
      interpretation: 'We cannot determine the independent biological units.',
      rationale: 'Request sample identifiers before estimation.',
      evidence: ['qc/inventory.tsv']
    }
  })
  const state: PlanRunState = {
    id: 'plan-reopen',
    sessionId: kernelSessionId,
    spec: {
      version: 1,
      goal: 'Evaluate the contrast',
      researchQuestion: question,
      steps: [
        {
          id: 'screen',
          title: 'Screen',
          instructions: 'Estimate.',
          acceptance: 'Report evidence.',
          dependsOn: [],
          access: 'read'
        }
      ]
    },
    status: 'paused',
    pause: { reason: 'needs_input', stepId: 'screen' },
    steps: { screen: { status: 'failed', attempts: 1, report } },
    replans: 0,
    createdAt: '2026-11-19T00:00:00Z',
    updatedAt: '2026-11-19T00:01:00Z'
  }
  writePlanRun(state, root)
  const admitted: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const completion = createKernelPlanRunCompletion({
      timeline: { read: readSessionEvents, append: appendSessionEvent },
      snapshot: planRunTimelineSnapshot,
      continueConversation: () => assert.fail('Paused plan treated as complete')
    })
    const client = new FakeKernelClient()
    client.localAgentDir = root
    const coordinator = new KernelPlanCoordinator(
      root,
      async () => assert.fail('Recovery must not launch another step'),
      () => undefined
    )
    let emissions = 0
    let projected = 0
    coordinator.bind({
      emitEvent: (type: string, payload: JsonValue) => {
        emissions++
        client.emit({ kind: 'event', seq: emissions, type, payload, sessionId: kernelSessionId })
      }
    } as unknown as KernelProtocolCore)
    client.onOpen = async (id) => {
      await coordinator.openSession(id)
      assert.ok(emissions > 0, 'a fresh coordinator must replay an unchanged actionable pause')
      assert.equal(projected, 0, 'an early recovery event waits for the desktop binding')
    }
    const factory = new KernelSessionFactory({
      launchLocal: async () => ({
        client,
        greeting: {
          protocol: { major: 1, minor: 0 },
          kernel: { version: 'test', ompVersion: 'test' },
          kernelInstanceId: 'test-instance',
          controllerGeneration: 1,
          capabilities: [],
          lastSeq: 0,
          runtime: { home: '/home/test', agentDir: root }
        },
        close: async () => undefined
      }),
      onResearchPlanUpdate: (sessionId, _, pause) => {
        if (!pause) return
        projected++
        assert.equal(sessionId, desktop.sessionId)
        assert.equal(pause.originalQuestion, question)
        assert.match(pause.report ?? '', /donor-to-sample mapping/)
        if (attempt === 0) return // Queued in a busy desktop, which exits before admission.
        if (completion.claimResearchPause(sessionId, pause)) {
          admitted.push(pause.runId)
          appendSessionEvent(sessionId, {
            type: 'run_started',
            runId: 'prompt-run',
            researchPauses: [
              {
                runId: pause.runId,
                stepId: pause.stepId,
                attempt: pause.attempt
              }
            ]
          })
        }
      }
    })
    const engine = new SessionRoutingEngine(legacyEngine(), () => factory)
    const logicalId = `desktop-open-${attempt}`
    await engine.sessions.create({
      ...params(logicalId),
      agentDir: root,
      phiSessionId: desktop.sessionId,
      sessionManager: { kind: 'open', cwd: '/project', path: `phi-session:${desktop.sessionId}` }
    })
    assert.equal(projected, 1)
    await coordinator.replayResearchPauses(kernelSessionId)
    assert.equal(projected, 2, 'a warm rebind is eligible to recover an unclaimed notice too')
    await engine.sessions.dispose({ sessionId: logicalId })
  }
  assert.deepEqual(admitted, [state.id])
})
