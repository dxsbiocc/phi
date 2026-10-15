import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcTaskLaunchTracker } from '../src/main/agent/engine/phi-extension/extensions/rpc-task-launch-tracker'

test('queued public task job keeps exact dispatch context after execute seal and rejects retired or replaced owners', async () => {
  type Call = { id: string; active: boolean; sealed: boolean; registered: Set<string> }
  const calls = new Map<string, Call>(),
    observed: string[] = []
  const jobs = new Map<string, { agentId: string; ownerId: string; type: string }>()
  const queue = new Map<string, () => Promise<unknown>>()
  const manager = {
    register(
      type: string,
      _label: string,
      run: (context: unknown) => Promise<unknown>,
      metadata: { id: string; agentId: string; ownerId: string }
    ): string {
      jobs.set(metadata.id, { agentId: metadata.agentId, ownerId: metadata.ownerId, type })
      queue.set(metadata.id, () => run({}))
      return metadata.id
    },
    getJob: (id: string) => jobs.get(id),
    cancel: () => true
  }
  const tool = {
    execute: async (id: string) => {
      manager.register(
        'task',
        id,
        async () => {
          observed.push(tracker.current()?.id ?? 'missing')
          return 'complete'
        },
        { id: 'child-' + id, agentId: 'child-' + id, ownerId: 'Main' }
      )
      return { content: [] }
    }
  }
  const session = {
    getToolByName: () => tool,
    getAgentId: () => 'Main',
    asyncJobManager: manager
  } as unknown as Parameters<ReturnType<typeof createRpcTaskLaunchTracker>['install']>[0]
  const tracker = createRpcTaskLaunchTracker<Call>({
    capture: (_session, id) => {
      const call = { id, active: true, sealed: false, registered: new Set<string>() }
      calls.set(id, call)
      return call
    },
    active: (call) => call.active,
    registering: (call, id) => {
      assert.equal(call.sealed, false)
      call.registered.add(id)
    },
    registered: (call, id) => assert.ok(call.registered.has(id)),
    registrationFailed: (call, id) => {
      call.registered.delete(id)
    },
    seal: (call) => {
      call.sealed = true
    }
  })
  tracker.install(session)
  await Promise.all([tool.execute('A'), tool.execute('B')])
  assert.equal(calls.get('A')?.sealed, true)
  assert.equal(calls.get('B')?.sealed, true)
  await queue.get('child-B')!()
  await queue.get('child-A')!()
  assert.deepEqual(observed, ['B', 'A'])
  calls.get('A')!.active = false
  await assert.rejects(async () => queue.get('child-A')!(), /retired/)
  assert.deepEqual(observed, ['B', 'A'])
  manager.register = () => 'replaced'
  assert.throws(() => tracker.assertInstalled(session), /replaced/)
})
