import assert from 'node:assert/strict'
import test from 'node:test'

import type { CreateAgentSessionResult } from '../src/main/agent/runtime/runtime-adapter'
import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import type { AdmittedPromptRun } from '../src/main/session-runtime/prompt-run-admission'
import {
  createPromptRunQueue,
  type PromptRunQueueDeps
} from '../src/main/session-runtime/prompt-run-queue'
import type { PromptRunContext, PromptRunState } from '../src/main/session-runtime/prompt-run-start'

test('a queued prompt insertion follows up the active run instead of admitting a replacement', async () => {
  const lifecycle = new SessionLifecycle<CreateAgentSessionResult>()
  const target = {
    input: {
      sessionKey: 'session-a',
      snapshot: { path: '/phi/phi-1', cwd: '/workspace', permissionMode: 'auto' as const },
      text: 'inserted',
      promptTarget: {
        path: '/phi/phi-1',
        phiSessionId: 'phi-1',
        cwd: '/workspace',
        sessionGeneration: lifecycle.currentGeneration,
        followUp: true
      }
    },
    normalizedText: 'inserted',
    promptTarget: {
      path: '/phi/phi-1',
      phiSessionId: 'phi-1',
      cwd: '/workspace',
      sessionGeneration: lifecycle.currentGeneration,
      followUp: true
    },
    runSessionKey: 'session-a',
    runLifecycle: lifecycle,
    runSessionGeneration: lifecycle.currentGeneration,
    runSnapshot: { path: '/phi/phi-1', cwd: '/workspace', permissionMode: 'auto' as const },
    automaticModelSelection: false,
    project: undefined
  }
  const followUps: string[] = []
  const followUpRunIds: Array<string | undefined> = []
  const unexpected: unknown[] = []
  let followUpFailure: Error | undefined
  const prepareFailure = { error: undefined as Error | undefined }
  let prepareCalls = 0
  const activeRun = {
    sessionKey: 'session-a',
    phiSessionId: 'phi-1',
    runId: 'run-original',
    cwd: '/workspace',
    generation: 1,
    sessionGeneration: lifecycle.currentGeneration,
    cancelled: false,
    session: {
      prompt: async (text: string, options?: { hostRunId?: string }) => {
        followUps.push(text)
        followUpRunIds.push(options?.hostRunId)
        if (followUpFailure) throw followUpFailure
      }
    }
  } as unknown as PromptRunState
  let admittedRunId: string | undefined
  let prepared: PromptRunContext | undefined
  const deps = {
    admission: {
      resolve: () => target,
      admit: (_target: unknown, existingRunId?: string) => {
        if (!existingRunId) throw new Error('会话正在运行')
        admittedRunId = existingRunId
        return {
          ...target,
          phiSessionId: 'phi-1',
          stableSessionPath: '/phi/phi-1',
          runId: existingRunId,
          workMode: 'direct'
        } satisfies AdmittedPromptRun<CreateAgentSessionResult>
      }
    },
    runs: {
      activeRun: () => activeRun,
      beginSubmission: () => ({ cancelled: false }),
      endSubmission: () => undefined
    },
    start: {
      allocateFollowUp: (
        admission: AdmittedPromptRun<CreateAgentSessionResult>,
        promptRun: PromptRunState
      ): PromptRunContext =>
        ({
          ...admission,
          runGeneration: promptRun.generation,
          storedImages: [],
          otherActiveProjectRuns: 0,
          promptRun
        }) as PromptRunContext,
      prepareFollowUp: (context: PromptRunContext) => {
        prepareCalls += 1
        if (prepareFailure.error) throw prepareFailure.error
        prepared = context
        context.userMessageEventId = 'user-follow-up'
      }
    },
    timeline: {
      logUnexpected: (error: unknown) => unexpected.push(error)
    },
    invalidation: {
      flushPending: () => {
        throw new Error('a follow-up must not reload the active session')
      }
    }
  } as unknown as PromptRunQueueDeps

  const result = await createPromptRunQueue(deps).submitPromptRun(target.input)

  assert.equal(admittedRunId, 'run-original')
  assert.equal(prepared?.promptRun, activeRun)
  assert.deepEqual(followUps, ['inserted'])
  assert.deepEqual(followUpRunIds, ['run-original'])
  assert.deepEqual(result, {
    path: '/phi/phi-1',
    phiSessionId: 'phi-1',
    sessionGeneration: lifecycle.currentGeneration,
    userMessageEventId: 'user-follow-up'
  })

  followUpFailure = new Error('original run settled')
  await assert.rejects(createPromptRunQueue(deps).submitPromptRun(target.input), /settled/)
  assert.equal(prepareCalls, 1, 'a rejected follow-up does not persist a user event')

  followUpFailure = undefined
  prepareFailure.error = new Error('timeline unavailable')
  const accepted = await createPromptRunQueue(deps).submitPromptRun(target.input)
  assert.deepEqual(accepted, {
    path: '/phi/phi-1',
    phiSessionId: 'phi-1',
    sessionGeneration: lifecycle.currentGeneration
  })
  assert.deepEqual(
    unexpected,
    [prepareFailure.error],
    'an accepted follow-up is not reported as rejected'
  )
})
