import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import {
  RpcHostChildDispatch,
  type RpcHostChildDispatchOptions,
  type RpcHostDispatchCall
} from '../src/main/agent/engine/phi-extension/extensions/rpc-host-child-dispatch'
import {
  createRpcChildHostStartRequest,
  parseRpcChildHostCancelReceipt
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-host-start'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import { productionChildOptions } from './helpers/productionChildNodeFixture'

test('request cancellation includes a native job registered after cancellation began', async () => {
  const { config } = await createProductionChildConfig(
    productionChildOptions({ allowBackground: true })
  )
  const profile = config.profiles.find((entry) => !entry.definition.blocking)!
  const root = {
    phiSessionId: config.phiSessionId,
    projectId: config.projectId,
    cwd: config.projectRoot,
    generation: config.generation,
    rootAgentId: 'Main',
    rootOmpSessionId: 'root-sdk',
    rootSessionFile: '/srv/history/root.jsonl'
  }
  const request = createRpcChildHostStartRequest(
    config,
    root,
    randomUUID(),
    profile.definition.nativeName,
    'late native registration'
  )
  let finishDispatch!: () => void
  const dispatch = new Promise<void>((resolve) => {
    finishDispatch = resolve
  })
  let call: RpcHostDispatchCall | undefined
  const job = {
    id: 'late-child',
    ownerId: 'Main',
    status: 'running' as 'running' | 'cancelled',
    endTime: undefined as number | undefined
  }
  let nativeStatus = 'running'
  const cancelled: string[] = []
  const messages: string[] = []
  const session = {
    sessionId: root.rootOmpSessionId,
    sessionFile: root.rootSessionFile,
    asyncJobManager: {
      getRunningJobs: () => [],
      getJob: (id: string) => (id === job.id ? job : undefined),
      cancel: (id: string) => {
        cancelled.push(id)
        job.status = 'cancelled'
        void delay(10).then(() => {
          job.endTime = Date.now()
          nativeStatus = 'aborted'
        })
        return true
      }
    },
    getToolByName: () => ({
      execute: async () => {
        await dispatch
        call!.dispatchSealed = true
        return { isError: false }
      }
    })
  } as unknown as ReturnType<RpcHostChildDispatchOptions<RpcHostDispatchCall>['actual']>
  const ctx = {
    isIdle: () => true,
    ui: { notify: (message: string) => messages.push(message) }
  } as unknown as Parameters<RpcHostChildDispatchOptions<RpcHostDispatchCall>['actual']>[0]
  const dispatcher = new RpcHostChildDispatch<RpcHostDispatchCall>({
    config,
    signal: new AbortController().signal,
    actual: () => session,
    resources: () => undefined,
    assertInstalled: () => undefined,
    assertDefinition: async () => undefined,
    root: () => root,
    registry: () =>
      ({
        list: () => [],
        get: (id: string) =>
          id === job.id
            ? { status: nativeStatus, kind: 'sub', parentId: root.rootAgentId }
            : undefined
      }) as unknown as ReturnType<RpcHostChildDispatchOptions<RpcHostDispatchCall>['registry']>,
    reservations: new Map(),
    capture: () => {
      call = {
        toolCallId: request.id,
        dispatchSealed: false,
        admitted: new Map(),
        registeredJobs: new Map()
      }
      return call
    },
    cleanup: () => undefined
  })
  const starting = dispatcher.start(request, ctx)
  await delay(0)
  assert.ok(call)
  const cancellation = dispatcher.cancel(request, ctx)
  await delay(10)
  call.registeredJobs.set(job.id, true)
  finishDispatch()
  await assert.rejects(starting, /cancelled/)
  await cancellation
  assert.deepEqual(cancelled, [job.id])
  const receipt = messages
    .map((message) => JSON.parse(message) as { type: string })
    .find((value) => value.type === 'phi_rpc_child_host_cancel_receipt')
  assert.ok(receipt)
  const verified = parseRpcChildHostCancelReceipt(JSON.stringify(receipt), request, config)
  assert.equal(verified.state, 'quiescent')
  assert.deepEqual(verified.nativeIds, [job.id])
})
