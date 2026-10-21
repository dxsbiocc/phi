import assert from 'node:assert/strict'
import test from 'node:test'

import type { CreateAgentSessionResult } from '../src/main/agent/runtime/runtime-adapter'
import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import type { PromptTargetInput } from '../src/main/agent/session/prompt-target-control'
import type { AdmittedPromptRun } from '../src/main/session-runtime/prompt-run-admission'
import {
  createPromptRunStart,
  type PromptRunStartDeps,
  type PromptRunState
} from '../src/main/session-runtime/prompt-run-start'

type Result = CreateAgentSessionResult

function admitted(overrides: Partial<AdmittedPromptRun<Result>> = {}): AdmittedPromptRun<Result> {
  const lifecycle = new SessionLifecycle<Result>()
  return {
    input: {
      sessionKey: 'key',
      snapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
      text: 'hello',
      promptTarget: null
    },
    normalizedText: 'hello',
    promptTarget: null,
    runSessionKey: '/canonical',
    runLifecycle: lifecycle,
    runSessionGeneration: 3,
    runSnapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
    automaticModelSelection: false,
    project: {
      id: 'project-1',
      name: 'Project',
      location: { kind: 'local', path: '/work', realPath: '/work' },
      workingDirectory: '/work',
      workingDirectoryRealPath: '/work',
      permissionMode: 'ask',
      pathAvailable: true,
      createdAt: '2026-10-21T00:00:00.000Z'
    },
    phiSessionId: 'phi-1',
    stableSessionPath: '/phi/phi-1',
    runId: 'run-1',
    ...overrides
  }
}

function existingRun(projectId: string, sessionKey: string): PromptRunState {
  return {
    sessionKey,
    phiSessionId: `phi-${sessionKey}`,
    runId: `run-${sessionKey}`,
    cwd: '/work',
    projectId,
    generation: 1,
    sessionGeneration: 1,
    cancelled: false,
    thinkingBlocks: new Map(),
    thinkingBlockStartedAtMs: new Map(),
    compactionReasons: new Map(),
    agentToolCallIds: new Set(),
    sdkToolCallIds: new Set(),
    browserSdkToolCallIds: new Set(),
    persistedToolCallIds: new Set(),
    pendingProviderToolCalls: new Map()
  }
}

function createDeps(): {
  deps: PromptRunStartDeps
  calls: string[]
  state: { active: PromptRunState[] }
} {
  const calls: string[] = []
  const active = [existingRun('project-1', 'other-key'), existingRun('project-2', 'third-key')]
  const deps: PromptRunStartDeps = {
    runs: {
      advanceGeneration: (key) => {
        calls.push(`advance:${key}`)
        return 5
      },
      setActiveRun: (key, run) => {
        calls.push(`set-active:${key}:${run.runId}`)
        active.push(run)
      },
      activeRuns: () => active
    },
    continuations: {
      delete: (phiSessionId) => calls.push(`continuation-delete:${phiSessionId}`)
    },
    images: {
      persist: (phiSessionId, images) => {
        calls.push(`images:${phiSessionId}:${images.length}`)
        return images.map((image, index) => ({
          sessionId: phiSessionId,
          id: `image-${index}`,
          mimeType: image.mimeType
        }))
      }
    },
    events: {
      append: (phiSessionId, event) => {
        calls.push(`append:${phiSessionId}:${String(event.type)}`)
        return { ...event, eventId: 'event-1', sessionId: phiSessionId, createdAt: '' }
      }
    },
    cleanup: {
      deleteActiveRun: (key, run) => calls.push(`delete-active:${key}:${run.runId}`)
    },
    notify: {
      parallelRun: (generation, path, cwd, count) =>
        calls.push(`parallel:${generation}:${path}:${cwd}:${count}`)
    }
  }
  return { deps, calls, state: { active } }
}

test('allocatePromptRun sets up the run state and counts other project runs', () => {
  const { deps, calls } = createDeps()
  const start = createPromptRunStart(deps)
  const context = start.allocate(
    admitted({
      input: {
        sessionKey: 'key',
        snapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
        text: 'hello',
        promptTarget: null,
        images: [{ mimeType: 'image/png', data: 'AAAA' }]
      }
    })
  )

  assert.equal(context.runGeneration, 5)
  assert.equal(context.otherActiveProjectRuns, 1)
  assert.equal(context.promptRun.generation, 5)
  assert.equal(context.promptRun.sessionGeneration, 3)
  assert.equal(context.promptRun.projectId, 'project-1')
  assert.equal(context.promptRun.sessionPath, '/phi/phi-1')
  assert.equal(context.storedImages.length, 1)
  assert.deepEqual(calls, [
    'advance:/canonical',
    'continuation-delete:phi-1',
    'images:phi-1:1',
    'set-active:/canonical:run-1'
  ])
})

test('automatic prompts keep the continuation count and do not count as user messages', () => {
  const { deps, calls } = createDeps()
  const start = createPromptRunStart(deps)
  const context = start.allocate(
    admitted({
      input: {
        sessionKey: 'key',
        snapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
        text: 'hello',
        promptTarget: null,
        automatic: true
      }
    })
  )

  start.prepare(context)

  assert.ok(!calls.some((call) => call.startsWith('continuation-delete')))
  assert.ok(!calls.some((call) => call.startsWith('append:')))
  assert.ok(!calls.some((call) => call.startsWith('parallel:')))
})

test('preparePromptRunForQueue records user and retry messages and reports parallel runs', () => {
  const { deps, calls } = createDeps()
  const start = createPromptRunStart(deps)
  const retry: PromptTargetInput = {
    path: '/phi/phi-1',
    cwd: '/work',
    suppressUserMessageEvent: true,
    retryUserMessageId: 'user-1'
  }
  const context = start.allocate(
    admitted({
      promptTarget: retry,
      input: {
        sessionKey: 'key',
        snapshot: { path: undefined, cwd: '/work', permissionMode: 'ask' },
        text: 'hello',
        promptTarget: retry
      }
    })
  )

  start.prepare(context)

  assert.ok(calls.includes('append:phi-1:user_message_retry'))
  assert.ok(calls.includes('parallel:3:/phi/phi-1:/work:1'))
})

test('a failed user-message append removes the active run and rethrows', () => {
  const { deps, calls } = createDeps()
  deps.events.append = () => {
    throw new Error('write failed')
  }
  const start = createPromptRunStart(deps)
  const context = start.allocate(admitted())

  assert.throws(() => start.prepare(context), /write failed/)
  assert.ok(calls.includes('delete-active:/canonical:run-1'))
  assert.ok(!calls.some((call) => call.startsWith('parallel:')))
})
