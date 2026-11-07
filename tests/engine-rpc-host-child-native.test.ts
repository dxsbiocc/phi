import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { RpcHostChildDispatch, type RpcHostDispatchCall } from '../src/main/agent/engine/phi-extension/extensions/rpc-host-child-dispatch'
import {
  createRpcChildHostStartRequest,
  parseRpcChildHostCancelReceipt,
  parseRpcChildHostStartReceipt
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-host-start'
import { childConfig, childProfile, childScope } from './helpers/rpcChildAuthorityFixture'

const backgroundAgent = 'phi_background_native'
const root = {
  phiSessionId: childScope.phiSessionId,
  projectId: childScope.projectId,
  cwd: childScope.cwd,
  generation: childScope.generation,
  rootAgentId: childScope.rootAgentId,
  rootOmpSessionId: childScope.rootOmpSessionId,
  rootSessionFile: childScope.rootSessionFile
}
const config = {
  ...childConfig,
  profiles: [
    {
      ...childProfile,
      definition: { ...childProfile.definition, nativeName: backgroundAgent, blocking: false }
    }
  ],
  policy: { ...childConfig.policy, allowBackground: true }
}

interface Call extends RpcHostDispatchCall {
  readonly toolCallId: string
  dispatchSealed: boolean
  hostStart?: boolean
  readonly admitted: Map<string, string>
  readonly registeredJobs: Map<string, boolean>
}

function fixture(definitionDelayMs = 0): {
  dispatch: RpcHostChildDispatch<Call>
  request: ReturnType<typeof createRpcChildHostStartRequest>
  context: never
  notifications: Array<Record<string, unknown>>
} {
  const notifications: Array<Record<string, unknown>> = []
  let activeCall: Call | undefined
  const session = {
    sessionId: root.rootOmpSessionId,
    sessionFile: root.rootSessionFile,
    asyncJobManager: {
      getRunningJobs: () => [],
      cancel: () => undefined
    },
    getToolByName: (name: string) =>
      name === 'task'
        ? {
            execute: async () => {
              activeCall?.registeredJobs.set('native-child', true)
              return { content: [{ type: 'text', text: 'started' }] }
            }
          }
        : undefined
  }
  const context = {
    isIdle: () => true,
    ui: {
      notify: (message: string) => notifications.push(JSON.parse(message))
    }
  } as never
  const dispatch = new RpcHostChildDispatch<Call>({
    config,
    signal: new AbortController().signal,
    actual: () => session as never,
    resources: () => undefined,
    assertInstalled: () => undefined,
    assertDefinition: async () => {
      if (definitionDelayMs) await delay(definitionDelayMs)
    },
    root: () => root,
    registry: () =>
      ({
        list: () => [],
        get: (id: string) =>
          id === 'native-child'
            ? {
                kind: 'sub',
                parentId: root.rootAgentId,
                displayName: backgroundAgent,
                sessionFile: '/srv/history/root/native-child.jsonl'
              }
            : undefined
      }) as never,
    reservations: new Map(),
    capture: (request) => {
      activeCall = {
        toolCallId: request.id,
        dispatchSealed: false,
        admitted: new Map(),
        registeredJobs: new Map()
      }
      return activeCall
    },
    cleanup: () => undefined
  })
  return {
    dispatch,
    request: createRpcChildHostStartRequest(
      config,
      root,
      randomUUID(),
      backgroundAgent,
      'Return a plain final response'
    ),
    context,
    notifications
  }
}

test('direct host dispatch starts the exact background child and emits an authenticated receipt', async () => {
  const f = fixture()
  await f.dispatch.start(f.request, f.context)
  const receipt = parseRpcChildHostStartReceipt(
    JSON.stringify(f.notifications[0]),
    f.request,
    config
  )
  assert.equal(receipt.agent, backgroundAgent)
  assert.equal(receipt.nativeId, 'native-child')
  assert.equal(receipt.parentToolCallId, f.request.id)
})

test('cancellation tombstones both a future start and a concurrently validating start', async () => {
  const before = fixture()
  await before.dispatch.cancel(before.request, before.context)
  assert.equal(before.dispatch.isCancelled(before.request.id), true)
  assert.equal(
    parseRpcChildHostCancelReceipt(
      JSON.stringify(before.notifications[0]),
      before.request,
      config
    ).state,
    'quiescent'
  )
  await assert.rejects(before.dispatch.start(before.request, before.context), /exact idle root/)

  const concurrent = fixture(25)
  const starting = concurrent.dispatch.start(concurrent.request, concurrent.context)
  await delay(1)
  await concurrent.dispatch.cancel(concurrent.request, concurrent.context)
  await assert.rejects(starting, /root changed/)
  assert.equal(concurrent.dispatch.isCancelled(concurrent.request.id), true)
  assert.equal(
    parseRpcChildHostCancelReceipt(
      JSON.stringify(concurrent.notifications[0]),
      concurrent.request,
      config
    ).state,
    'quiescent'
  )
})
