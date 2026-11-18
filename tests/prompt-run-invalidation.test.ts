import assert from 'node:assert/strict'
import test from 'node:test'

import { stopActivePrompt } from '../src/main/agent/session/active-prompt-stop'
import type { CreateAgentSessionResult } from '../src/main/agent/runtime/runtime-adapter'
import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import type {
  PhiSessionManifest,
  SessionEventInput,
  StoredSessionEvent
} from '../src/main/agent/session/session-store'
import { PromptRunRegistry } from '../src/main/app-state/prompt-run-registry'
import {
  createPromptRunAdmission,
  PromptRunDeferredError,
  PromptRunTargetChangedError,
  type SubmitPromptInput
} from '../src/main/session-runtime/prompt-run-admission'
import {
  createPromptRunQueue,
  type PromptRunQueueDeps
} from '../src/main/session-runtime/prompt-run-queue'
import {
  createPromptRunStart,
  type PromptRunState
} from '../src/main/session-runtime/prompt-run-start'

test('a prompt replays a deferred invalidation before admitting the run', async () => {
  const calls: string[] = []
  const deps = {
    admission: {
      resolve: () => {
        calls.push('admission:resolve')
        throw new Error('stop after the admission boundary')
      },
      admit: () => {
        throw new Error('unreachable')
      }
    },
    invalidation: {
      flushPending: async (sessionKey: string) => {
        calls.push(`invalidation:flush:${sessionKey}`)
      }
    },
    runs: {
      beginSubmission: () => ({ cancelled: false }),
      endSubmission: () => undefined
    }
  } as unknown as PromptRunQueueDeps

  await assert.rejects(
    createPromptRunQueue(deps).submitPromptRun({
      sessionKey: 'session-a',
      snapshot: { path: '/a.jsonl', cwd: '/workspace', permissionMode: 'auto' },
      text: 'continue',
      promptTarget: null
    }),
    /stop after the admission boundary/
  )

  assert.deepEqual(calls, ['invalidation:flush:session-a', 'admission:resolve'])
})

test('a stop during a deferred invalidation replay cancels the submission before admission', async () => {
  const calls: string[] = []
  const runs = new PromptRunRegistry((key) => key)
  let releaseFlush: () => void = () => undefined
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  const deps = {
    admission: {
      resolve: () => {
        calls.push('admission:resolve')
        throw new Error('a cancelled submission must not be admitted')
      },
      admit: () => {
        throw new Error('unreachable')
      }
    },
    invalidation: {
      flushPending: async (sessionKey: string) => {
        calls.push(`invalidation:flush:${sessionKey}`)
        await flushGate
      }
    },
    runs: {
      beginSubmission: (sessionKey: string) => runs.beginPromptSubmission(sessionKey),
      endSubmission: (sessionKey: string, submission: { cancelled: boolean }) =>
        runs.endPromptSubmission(sessionKey, submission)
    }
  } as unknown as PromptRunQueueDeps

  const prompt = createPromptRunQueue(deps).submitPromptRun({
    sessionKey: 'session-a',
    snapshot: { path: '/a.jsonl', cwd: '/workspace', permissionMode: 'auto' },
    text: 'continue',
    promptTarget: null
  })

  await stopActivePrompt({
    getCurrentSessionKey: () => 'session-a',
    advancePromptGeneration: (sessionKey) => runs.advanceGeneration(sessionKey),
    cancelPendingPromptSubmissions: (sessionKey) => runs.cancelPendingPromptSubmissions(sessionKey),
    getActivePromptRun: (sessionKey) => runs.activeRun(sessionKey),
    getPhiSessionIdForKey: () => undefined,
    getManualCompactionOperation: () => undefined,
    stopPromptRun: async () => undefined
  })
  releaseFlush()

  assert.equal(await prompt, null)
  assert.deepEqual(calls, ['invalidation:flush:session-a'])
})

async function exerciseDurableStart(
  duringPreparation: 'continue' | 'defer' | 'delete' | 'stop' | 'invalidate'
): Promise<void> {
  const lifecycle = new SessionLifecycle<CreateAgentSessionResult>()
  const runs = new PromptRunRegistry<PromptRunState>((key) => key)
  const sessionId = 'associated-session'
  const sessionKey = 'bound-session-key'
  const attemptId = 'attempt-1'
  const cwd = '/isolated/work'
  const projectId = 'project-1'
  let waitingForSkills!: () => void
  let releaseSkills!: () => void
  const skillsRequested = new Promise<void>((resolve) => {
    waitingForSkills = resolve
  })
  const permitStart = new Promise<void>((resolve) => {
    releaseSkills = resolve
  })
  const writes: SessionEventInput[] = []
  const delivered: string[] = []
  const append = (event: SessionEventInput): StoredSessionEvent => {
    writes.push(event)
    return {
      ...event,
      eventId: 'user-event',
      sessionId,
      createdAt: '2026-11-18T00:00:00.000Z'
    }
  }
  const deleteRun = (key: string, run: PromptRunState): void => {
    runs.deleteActiveRunIfCurrent(key, run)
  }
  const admission = createPromptRunAdmission<CreateAgentSessionResult>({
    keys: { canonicalize: (key) => key },
    lifecycles: { forKey: () => lifecycle },
    resolution: {
      projectForSession: () => ({
        id: projectId,
        name: 'Project',
        location: {
          kind: 'ssh',
          hostProfileId: 'host-profile',
          remoteRoot: '/isolated/work',
          canonicalRoot: '/isolated/work'
        },
        workingDirectory: cwd,
        workingDirectoryRealPath: cwd,
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-11-18T00:00:00.000Z'
      }),
      resolveSessionModelSelection: () => null
    },
    linking: { ensurePhiSessionId: () => assert.fail('durable submission created a session') },
    sessions: {
      findById: () => ({ sessionId, projectId, cwd, permissionMode: 'ask' }) as PhiSessionManifest
    },
    runs: {
      hasActiveRun: (key) => runs.hasActiveRun(key),
      manualCompactionIds: runs.manualCompactionIds
    },
    paths: {
      phiOnlySessionPath: (id) => `phi-session:${id}`,
      isRemoteAnchorPath: () => false
    },
    createRunId: () => assert.fail('durable submission created another attempt')
  })
  const start = createPromptRunStart({
    runs: {
      advanceGeneration: (key) => runs.advanceGeneration(key),
      setActiveRun: (key, run) => runs.setActiveRun(key, run),
      activeRuns: () => runs.activeRuns()
    },
    continuations: { delete: () => undefined },
    images: { persist: () => assert.fail('unexpected image write') },
    events: { append: (_, event) => append(event) },
    cleanup: { deleteActiveRun: deleteRun },
    notify: { parallelRun: () => undefined }
  })
  const queue = createPromptRunQueue({
    admission: { resolve: admission.resolveTarget, admit: admission.admit },
    start,
    runs: {
      queueFor: (key) => runs.queueFor(key),
      generationFor: (key) => runs.generationFor(key),
      setQueue: (key, pending) => runs.setQueue(key, pending),
      beginSubmission: (key) => runs.beginPromptSubmission(key),
      endSubmission: (key, submission) => runs.endPromptSubmission(key, submission)
    },
    execution: {
      runner: {
        startRun: (run) => {
          assert.equal(run.sessionId, sessionId)
          assert.equal(run.runId, attemptId)
          append({ type: 'run_started', runId: run.runId })
          return { done: run.execute({ signal: new AbortController().signal }) }
        }
      },
      execute: async (context, _signal, result) => {
        result({
          path: context.stableSessionPath,
          phiSessionId: context.phiSessionId,
          sessionGeneration: context.runSessionGeneration
        })
      }
    },
    skills: {
      get: () => undefined,
      set: () => undefined,
      resolve: async () => {
        waitingForSkills()
        await permitStart
        return []
      }
    },
    timeline: {
      append: (_, event) => append(event),
      broadcast: (_, event) => delivered.push(event.eventId),
      logUnexpected: (error) => assert.fail(String(error)),
      logSkillLookupFailure: (_, error) => assert.fail(String(error))
    },
    invalidation: { flushPending: () => undefined },
    events: {
      notifySessionChanged: () => undefined,
      flushContinuations: () => undefined,
      scheduleTitle: () => undefined
    },
    cleanup: { deleteActiveRun: deleteRun },
    sleep: { sync: () => undefined }
  })

  let guardCalls = 0
  const prompt: SubmitPromptInput = {
    sessionKey,
    snapshot: { path: undefined, cwd, permissionMode: 'ask' },
    text: 'durable input',
    promptTarget: null,
    durable: {
      sessionId,
      submissionId: 'submission-1',
      attemptId,
      workMode: 'auto',
      revalidate() {
        guardCalls += 1
        if (guardCalls === 1) return
        if (duringPreparation === 'defer') throw new PromptRunDeferredError()
        if (duringPreparation === 'delete') throw new PromptRunTargetChangedError()
      }
    }
  }
  const result = queue.submitPromptRun(prompt)
  await skillsRequested
  assert.equal(guardCalls, 1)
  assert.deepEqual(writes, [])
  if (duringPreparation === 'stop') {
    const active = runs.activeRun(sessionKey)
    assert.ok(active)
    active.cancelled = true
  }
  if (duringPreparation === 'invalidate') lifecycle.advance()
  releaseSkills()

  if (duringPreparation === 'defer' || duringPreparation === 'invalidate') {
    await assert.rejects(result, PromptRunDeferredError)
  } else if (duringPreparation === 'delete') {
    await assert.rejects(result, PromptRunTargetChangedError)
  } else if (duringPreparation === 'stop') {
    assert.equal(await result, null)
  } else {
    assert.equal((await result)?.phiSessionId, sessionId)
  }
  if (duringPreparation === 'continue') {
    assert.deepEqual(writes, [
      {
        type: 'user_message',
        content: 'durable input',
        runId: attemptId,
        submissionId: 'submission-1'
      },
      { type: 'run_started', runId: attemptId }
    ])
    assert.deepEqual(delivered, ['user-event'])
  } else {
    assert.deepEqual(writes, [])
    assert.deepEqual(delivered, [])
  }
  assert.equal(runs.activeRun(sessionKey), undefined)
}

test('durable prompts validate ownership again around delayed run preparation', async (t) => {
  for (const action of ['continue', 'defer', 'delete', 'stop', 'invalidate'] as const) {
    await t.test(action, () => exerciseDurableStart(action))
  }
})
