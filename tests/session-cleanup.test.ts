import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionCleanup,
  type SessionCleanupDeps
} from '../src/main/session-runtime/session-cleanup'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('session cleanup registers its barrier before settlement and releases it after disposal', async () => {
  const log: string[] = []
  const pending = deferred<{ session: TestSession }>()
  const session: TestSession = {
    sessionFile: '/resolved.jsonl',
    abort: async () => {
      log.push('abort')
    },
    dispose: async () => {
      log.push('dispose')
    }
  }
  const cleanup = createSessionCleanup({
    lifecycles: {
      abortControllerFor: () => ({ abort: () => log.push('controller.abort') }),
      deleteAbortController: () => log.push('controller.delete'),
      registerCleanupForPath: (path) => log.push(`register:${path}`),
      registerUnknownPathCleanup: () => log.push('register:unknown'),
      replaceCleanupForPathIfDifferent: (path) => log.push(`replace:${path}`),
      releaseUnknownPathCleanup: () => log.push('release:unknown'),
      releaseCleanupForPath: (path) => log.push(`release:${path}`)
    },
    sessions: {
      abortSession: async (value) => value.abort(),
      abortSessionWithoutCancellingApprovals: async (value) => value.abort()
    },
    errors: {
      isCleanupStarted: () => false,
      reportUnexpectedCleanupError: () => log.push('unexpected')
    }
  })

  const finished = cleanup.cleanupSessionRecord({
    generation: 4,
    snapshot: { path: '/captured.jsonl', cwd: '/work', permissionMode: 'auto' },
    promise: pending.promise
  })

  assert.deepEqual(log, ['controller.abort', 'register:/captured.jsonl'])
  pending.resolve({ session })
  await finished

  assert.deepEqual(log, [
    'controller.abort',
    'register:/captured.jsonl',
    'replace:/resolved.jsonl',
    'abort',
    'dispose',
    'controller.delete',
    'release:unknown',
    'release:/resolved.jsonl'
  ])
})

test('abortAndDisposeSession always aborts before disposal and preserves approval mode', async () => {
  const log: string[] = []
  const session: TestSession = {
    abort: async () => {
      log.push('session.abort')
    },
    dispose: async () => {
      log.push('session.dispose')
    }
  }
  const cleanup = createSessionCleanup({
    lifecycles: inertLifecycles(),
    sessions: {
      abortSession: async () => {
        log.push('abort:cancel')
      },
      abortSessionWithoutCancellingApprovals: async () => {
        log.push('abort:preserve')
      }
    },
    errors: inertErrors()
  })

  await cleanup.abortAndDisposeSession(session, { cancelApprovals: false })
  await cleanup.abortAndDisposeSession(session, { cancelApprovals: true })

  assert.deepEqual(log, ['abort:preserve', 'session.dispose', 'abort:cancel', 'session.dispose'])
})

interface TestSession {
  sessionFile?: string
  abort(): Promise<void>
  dispose(): Promise<void>
}

function inertLifecycles(): SessionCleanupDeps<
  TestSession,
  { session: TestSession }
>['lifecycles'] {
  return {
    abortControllerFor: () => undefined,
    deleteAbortController: () => undefined,
    registerCleanupForPath: () => undefined,
    registerUnknownPathCleanup: () => undefined,
    replaceCleanupForPathIfDifferent: () => undefined,
    releaseUnknownPathCleanup: () => undefined,
    releaseCleanupForPath: () => undefined
  }
}

function inertErrors(): SessionCleanupDeps<TestSession, { session: TestSession }>['errors'] {
  return {
    isCleanupStarted: () => false,
    reportUnexpectedCleanupError: () => undefined
  }
}
