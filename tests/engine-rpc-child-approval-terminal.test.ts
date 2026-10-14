import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { RpcApprovalEvent } from '../src/main/agent/engine/rpc/approval-bridge'
import type {
  RpcControlChannel,
  RpcControlFrame,
  RpcFrame
} from '../src/main/agent/engine/rpc/types'
import { validateControlFrame } from '../src/main/agent/engine/rpc/control-frame'
import { RpcChildHostUriBridge } from '../src/main/agent/engine/rpc/subagents/host-uri-bridge'
import { rpcChildUri } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import {
  activateChild,
  childAuthority,
  childRequest,
  childScope
} from './helpers/rpcChildAuthorityFixture'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
function wire(beforeWrite?: (frame: RpcControlFrame) => void | Promise<void>): {
  authority: ReturnType<typeof childAuthority>['authority']
  bridge: RpcChildHostUriBridge
  events: RpcApprovalEvent[]
  written: RpcControlFrame[]
  receive(frame: RpcFrame): void
} {
  const events: RpcApprovalEvent[] = [],
    written: RpcControlFrame[] = []
  const { authority, controller } = childAuthority({
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => 'approved',
      onEvent: (event) => {
        events.push(event)
      }
    }
  })
  let receive!: (frame: RpcFrame) => void
  const channel: RpcControlChannel = {
    generation: 1,
    signal: controller.signal,
    onFrame: (listener) => {
      receive = listener
      return () => {}
    },
    sendControl: async (frame) => {
      validateControlFrame(frame)
      await beforeWrite?.(frame)
      written.push(frame)
    }
  }
  return {
    authority,
    bridge: new RpcChildHostUriBridge({ channel, authority }),
    events,
    written,
    receive: (frame) => receive(frame)
  }
}
function terminals(events: RpcApprovalEvent[]): string[] {
  return events.filter((event) => event.type !== 'approval_requested').map((event) => event.type)
}

test('prepared child allow has no terminal until the actual URI result writer commits', async () => {
  let release!: () => void
  const f = wire((frame) =>
    frame.id === 'read-wire' && frame.type === 'host_uri_result' && frame.content
      ? new Promise<void>((resolve) => {
          release = resolve
        })
      : undefined
  )
  try {
    await activateChild(f.authority)
    const request = childRequest('approve', 3)
    f.receive({
      type: 'host_uri_request',
      id: 'write-wire',
      operation: 'write',
      url: rpcChildUri('request', request.id),
      content: JSON.stringify(request)
    })
    await tick()
    assert.deepEqual(terminals(f.events), [], 'Preparing an allow is not an approval commit')
    f.receive({
      type: 'host_uri_request',
      id: 'read-wire',
      operation: 'read',
      url: rpcChildUri('reply', request.id)
    })
    await tick()
    assert.deepEqual(terminals(f.events), [], 'Blocked output is not committed')
    release()
    await tick()
    assert.deepEqual(terminals(f.events), ['approval_approved'])
    f.bridge.dispose()
    assert.deepEqual(terminals(f.events), ['approval_approved'])
  } finally {
    release?.()
    f.bridge.dispose()
  }
})
test('cancel between request write and reply read finalizes one cancelled approval', async () => {
  const f = wire()
  try {
    await activateChild(f.authority)
    const request = childRequest('approve', 3)
    f.receive({
      type: 'host_uri_request',
      id: 'write-wire',
      operation: 'write',
      url: rpcChildUri('request', request.id),
      content: JSON.stringify(request)
    })
    await tick()
    const cancel = {
      schema: 1,
      id: randomUUID(),
      operation: 'cancel',
      capability: request.capability,
      sequence: 4,
      scope: childScope,
      targetId: request.id
    }
    f.receive({
      type: 'host_uri_request',
      id: 'cancel-wire',
      operation: 'write',
      url: rpcChildUri('cancel', cancel.id),
      content: JSON.stringify(cancel)
    })
    await tick()
    f.bridge.dispose()
    f.bridge.dispose()
    assert.deepEqual(terminals(f.events), ['approval_cancelled'])
  } finally {
    f.bridge.dispose()
  }
})
test('failed child URI allow write reports only cancellation and retires its grant', async () => {
  const f = wire((frame) => {
    if (frame.id === 'read-wire') throw new Error('Private writer refused')
  })
  try {
    await activateChild(f.authority)
    const request = childRequest('approve', 3)
    f.receive({
      type: 'host_uri_request',
      id: 'write-wire',
      operation: 'write',
      url: rpcChildUri('request', request.id),
      content: JSON.stringify(request)
    })
    await tick()
    f.receive({
      type: 'host_uri_request',
      id: 'read-wire',
      operation: 'read',
      url: rpcChildUri('reply', request.id)
    })
    await tick()
    f.bridge.dispose()
    assert.deepEqual(terminals(f.events), ['approval_cancelled'])
  } finally {
    f.bridge.dispose()
  }
})
