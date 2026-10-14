import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWrapperJobHostScope,
  wrapperJobHostHandlers
} from '../src/main/agent/wrappers/composition/job-host-handlers'
import {
  WRAPPER_JOB_HOST_METHODS,
  type WrapperJobClient
} from '../src/main/agent/wrappers/composition/job-types'
import type { WrapperRun } from '../src/main/agent/wrappers/types'

function fixture(): {
  handlers: ReturnType<typeof wrapperJobHostHandlers>
  calls: string[]
  controller: AbortController
  origin: () => string | undefined
} {
  const origins = new Map([
    ['old-runtime', { phiSessionId: 'owner-phi' }],
    ['fresh-runtime', { phiSessionId: 'owner-phi' }],
    ['peer-runtime', { phiSessionId: 'peer-phi' }]
  ])
  const owner = {
    origin: 'composition',
    originSessionId: 'old-runtime',
    remote: {
      projectId: 'project',
      hostProfileId: 'host',
      host: 'server',
      workspaceRoot: '/server/project'
    }
  } as WrapperRun
  const records = new Map<string, WrapperRun>([
    ['owned', owner],
    ['peer', { ...owner, originSessionId: 'peer-runtime' }],
    ['wrong-project', { ...owner, remote: { ...owner.remote!, projectId: 'peer-project' } }],
    ['wrong-host', { ...owner, remote: { ...owner.remote!, hostProfileId: 'peer-host' } }],
    ['unknown-origin', { ...owner, originSessionId: 'previous-app-runtime' }]
  ])
  const calls: string[] = []
  let startedOrigin: string | undefined
  const client: WrapperJobClient = {
    start: async (input) => {
      calls.push('start')
      startedOrigin = input.originSessionId
      return { ok: false, error: 'bounded fixture' }
    },
    status: async (runId) => {
      calls.push('status:' + runId)
      return undefined
    },
    cancel: async (runId) => {
      calls.push('cancel:' + runId)
      return { ok: false, error: 'bounded fixture' }
    },
    wait: async (runId) => {
      calls.push('wait:' + runId)
      return undefined
    },
    list: async (_limit, ownsRun) =>
      [...records.keys()]
        .filter((id) => !ownsRun || ownsRun(id))
        .map((runId) => ({ runId, wrapperId: 'wrapper', state: 'completed', elapsedSeconds: 1 }))
  }
  const controller = new AbortController()
  const handlers = wrapperJobHostHandlers(client, {
    scopeFor: (context) => {
      assert.equal(context?.originSessionId, 'fresh-runtime')
      return createWrapperJobHostScope({
        originSessionId: 'fresh-runtime',
        phiSessionId: 'owner-phi',
        projectId: 'project',
        hostProfileId: 'host',
        host: 'server',
        workspaceRoot: '/server/project',
        signal: controller.signal,
        assertCurrent: () => undefined,
        readRun: (id) => records.get(id),
        resolveOrigin: (id) => origins.get(id ?? '')
      })
    }
  })
  return { handlers, calls, controller, origin: () => startedOrigin }
}

test('scoped Wrapper status/wait/cancel reject peer and unprovable old jobs before touching the manager', async () => {
  const f = fixture()
  for (const runId of ['peer', 'wrong-project', 'wrong-host', 'unknown-origin'])
    for (const method of [
      WRAPPER_JOB_HOST_METHODS.status,
      WRAPPER_JOB_HOST_METHODS.wait,
      WRAPPER_JOB_HOST_METHODS.cancel
    ])
      await assert.rejects(
        async () => f.handlers[method]({ runId }, { originSessionId: 'fresh-runtime' }),
        /not owned/
      )
  assert.deepEqual(f.calls, [])
  await f.handlers[WRAPPER_JOB_HOST_METHODS.status](
    { runId: 'owned' },
    { originSessionId: 'fresh-runtime' }
  )
  assert.deepEqual(f.calls, ['status:owned'])
  assert.deepEqual(
    await f.handlers[WRAPPER_JOB_HOST_METHODS.list]({}, { originSessionId: 'fresh-runtime' }),
    [{ runId: 'owned', wrapperId: 'wrapper', state: 'completed', elapsedSeconds: 1 }]
  )
})

test('scoped Wrapper start trusts the actual origin and never accepts explicit local execution', async () => {
  const f = fixture()
  await f.handlers[WRAPPER_JOB_HOST_METHODS.start](
    { id: 'wrapper', originSessionId: 'peer-runtime' },
    { originSessionId: 'fresh-runtime' }
  )
  assert.equal(f.origin(), 'fresh-runtime')
  await assert.rejects(
    async () =>
      f.handlers[WRAPPER_JOB_HOST_METHODS.start](
        { id: 'wrapper', target: 'local' },
        { originSessionId: 'fresh-runtime' }
      ),
    /cannot run.*desktop/
  )
  f.controller.abort(new Error('calling run stopped'))
  await assert.rejects(
    async () =>
      f.handlers[WRAPPER_JOB_HOST_METHODS.start](
        { id: 'wrapper' },
        { originSessionId: 'fresh-runtime' }
      ),
    /calling run stopped/
  )
  assert.deepEqual(f.calls, ['start'])
})

test('Wrapper run identifiers cannot traverse the desktop job store before ownership checks', async () => {
  const f = fixture()
  await assert.rejects(
    async () =>
      f.handlers[WRAPPER_JOB_HOST_METHODS.status](
        { runId: '../../private-file' },
        { originSessionId: 'fresh-runtime' }
      ),
    /Invalid Wrapper run identifier/
  )
  assert.deepEqual(f.calls, [])
})
