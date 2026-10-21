import assert from 'node:assert/strict'
import test from 'node:test'

import { createCreatedSessionEvents } from '../src/main/session-runtime/created-session-events'

test('created-session events stop permanent provider failures, persist, then broadcast', async () => {
  const log: string[] = []
  const run = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
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
  let listener: ((event: TestEvent) => void) | undefined
  const session = {
    sessionFile: '/runtime.jsonl',
    subscribe: (next: (event: TestEvent) => void) => {
      listener = next
      return () => undefined
    }
  }
  const events = createCreatedSessionEvents({
    state: {
      promptRuns: { activeRun: () => run },
      sessionKeys: { phiSessionIdFor: () => 'phi-1' }
    },
    persistence: {
      storage: {
        appendSessionEvent: (_sessionId, event) => {
          log.push('persist')
          return {
            ...event,
            eventId: 'event-1',
            sessionId: 'phi-1',
            createdAt: '2026-10-21T00:00:00.000Z'
          }
        },
        persistToolOutput: () => ({ output: '', truncated: false }),
        toolOutputInlineLimit: 20_000
      },
      extractAssistantText: () => '',
      redactStructuredValue: (value) => value
    },
    runtime: {
      redactSensitiveText: (message) => `redacted:${message}`,
      abortSessionWithoutCancellingApprovals: async () => {
        log.push('abort')
      },
      phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
    },
    events: {
      publish: (payload) => {
        log.push('broadcast')
        assert.equal(payload.sessionPath, 'phi-session:phi-1')
        assert.ok(Number.isFinite(Date.parse(String(payload.createdAt))))
      },
      logUnexpectedError: () => log.push('unexpected')
    }
  })
  const context = {
    sessionKey: 'session-key',
    generation: 7,
    snapshot: { path: undefined, cwd: '/work', permissionMode: 'auto' },
    lifecycle: { isCurrentGeneration: () => true }
  }

  events.subscribeToCreatedSession(context, { session })
  listener?.({
    type: 'auto_retry_start',
    errorMessage: 'provider is not available in your region'
  })
  await Promise.resolve()

  assert.deepEqual(log, ['abort', 'broadcast'])
  assert.equal(run.stoppingPermanentProviderError, true)
  assert.equal(run.recordedFailureMessage, 'redacted:provider is not available in your region')

  log.length = 0
  listener?.({ type: 'notice', source: 'compaction', message: 'context saved' })
  assert.deepEqual(log, ['persist', 'broadcast'])
})

test('created-session events ignore stale generations before persistence or broadcast', () => {
  let listener: ((event: TestEvent) => void) | undefined
  const events = createCreatedSessionEvents({
    state: {
      promptRuns: { activeRun: () => undefined },
      sessionKeys: { phiSessionIdFor: () => undefined }
    },
    persistence: {
      storage: {
        appendSessionEvent: () => {
          throw new Error('must not persist')
        },
        persistToolOutput: () => ({ output: '', truncated: false }),
        toolOutputInlineLimit: 20_000
      },
      extractAssistantText: () => '',
      redactStructuredValue: (value) => value
    },
    runtime: {
      redactSensitiveText: String,
      abortSessionWithoutCancellingApprovals: async () => undefined,
      phiOnlySessionPath: String
    },
    events: {
      publish: () => {
        throw new Error('must not broadcast')
      },
      logUnexpectedError: () => undefined
    }
  })
  const context = {
    sessionKey: 'session-key',
    generation: 7,
    snapshot: { path: undefined, cwd: '/work', permissionMode: 'auto' },
    lifecycle: { isCurrentGeneration: () => false }
  }
  const session = {
    subscribe: (next: (event: TestEvent) => void) => {
      listener = next
      return () => undefined
    }
  }

  events.subscribeToCreatedSession(context, { session })
  listener?.({ type: 'message_update' })
})

interface TestEvent {
  type: string
  errorMessage?: string
  [key: string]: unknown
}
