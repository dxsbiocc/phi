import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PhiRuntimeRef } from '../src/main/agent/session/runtime-reference'
import type { RemoteSessionRuntime } from '../src/main/agent/engine/rpc/remote-session-runtime'
import { createFacadeHostChildStarter } from '../src/main/agent/engine/rpc/facade-host-child-start'

const reference = {
  projectId: 'project-a',
  projectRoot: '/srv/project-a',
  ompSessionId: 'root-a',
  bindingHash: 'binding-a',
  durableSessionKey: 'durable-a'
} as PhiRuntimeRef

test('facade host start requires an enabled plan, durable ID and exact runtime owner', async () => {
  const calls: unknown[][] = []
  const runtime = {
    isReady: true,
    startHostChild: async (...args: unknown[]) => {
      calls.push(args)
      return { runId: 'verified-child' }
    }
  } as unknown as RemoteSessionRuntime
  let pending = false
  const options = {
    enabled: true,
    workMode: 'plan_execute' as const,
    allowedAgents: ['PlanStep'],
    phiSessionId: 'phi-a',
    projectId: 'project-a',
    cwd: '/srv/project-a',
    capture: () => ({ runtime, reference, epoch: 1, busy: pending }),
    assertCurrent: () => undefined,
    setPending: (value: boolean) => {
      pending = value
    }
  }
  const disabled = createFacadeHostChildStarter({ ...options, enabled: false })
  await assert.rejects(disabled({ task: 'step', requestId: randomUUID() }), /not enabled/)
  const start = createFacadeHostChildStarter(options)
  await assert.rejects(start({ task: 'step', requestId: '' }), /persisted UUID/)
  await assert.rejects(
    start({ agent: 'Other', task: 'step', requestId: randomUUID() }),
    /not enabled/
  )
  const requestId = randomUUID()
  assert.deepEqual(await start({ task: 'step', requestId }), { runId: 'verified-child' })
  assert.equal(pending, false)
  assert.deepEqual(calls, [
    [
      'PlanStep',
      'step',
      requestId,
      {
        phiSessionId: 'phi-a',
        projectId: 'project-a',
        cwd: '/srv/project-a',
        rootOmpSessionId: 'root-a'
      }
    ]
  ])
  await assert.rejects(
    createFacadeHostChildStarter({
      ...options,
      capture: () => ({
        runtime,
        reference: { ...reference, projectId: 'project-b' },
        epoch: 1,
        busy: false
      })
    })({ task: 'step', requestId: randomUUID() }),
    /运行归属不可用/
  )
})

test('facade host start rejects a runtime generation replaced during launch', async () => {
  let finish!: (value: { runId: string }) => void
  const launched = new Promise<{ runId: string }>((resolve) => {
    finish = resolve
  })
  const runtime = {
    isReady: true,
    startHostChild: () => launched
  } as unknown as RemoteSessionRuntime
  let epoch = 1
  let pending = false
  const start = createFacadeHostChildStarter({
    enabled: true,
    workMode: 'plan_execute',
    allowedAgents: ['PlanStep'],
    phiSessionId: 'phi-a',
    projectId: 'project-a',
    cwd: '/srv/project-a',
    capture: () => ({ runtime, reference, epoch, busy: pending }),
    assertCurrent: () => undefined,
    setPending: (value) => {
      pending = value
    }
  })
  const running = start({ task: 'step', requestId: randomUUID() })
  assert.equal(pending, true)
  epoch = 2
  finish({ runId: 'old-child' })
  await assert.rejects(
    running,
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === 'TIMEOUT_UNKNOWN'
  )
  assert.equal(pending, false)
})
