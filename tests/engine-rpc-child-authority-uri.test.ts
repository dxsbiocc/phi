import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  childAuthority,
  childRequest,
  childScope,
  activateChild
} from './helpers/rpcChildAuthorityFixture'
import { RpcChildHostUriBridge } from '../src/main/agent/engine/rpc/subagents/host-uri-bridge'
import {
  rpcChildUri,
  createRpcChildCall
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import { validateControlFrame } from '../src/main/agent/engine/rpc/control-frame'
import type {
  RpcControlChannel,
  RpcControlFrame,
  RpcFrame
} from '../src/main/agent/engine/rpc/types'

test('URI write ACK does not wait on human approval and late cancellation emits no allow', async () => {
  let listener!: (frame: RpcFrame) => void
  const written: RpcControlFrame[] = []
  const { authority, controller } = childAuthority({
    approval: {
      shouldGate: () => true,
      requestToolApproval: (_request, abort) =>
        new Promise((r) => abort.addEventListener('abort', () => r('cancelled'), { once: true }))
    }
  })
  const channel: RpcControlChannel = {
    generation: 1,
    signal: controller.signal,
    onFrame: (fn) => {
      listener = fn
      return () => {}
    },
    sendControl: async (frame) => {
      validateControlFrame(frame)
      written.push(frame)
    }
  }
  const bridge = new RpcChildHostUriBridge({ channel, authority })
  try {
    await activateChild(authority)
    const request = childRequest('approve', 3),
      id = 'write-wire'
    listener({
      type: 'host_uri_request',
      id,
      operation: 'write',
      url: rpcChildUri('request', request.id),
      content: JSON.stringify(request)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.ok(written.some((frame) => frame.id === id))
    listener({
      type: 'host_uri_request',
      id: 'read-wire',
      operation: 'read',
      url: rpcChildUri('reply', request.id)
    })
    listener({ type: 'host_uri_cancel', id: randomUUID(), targetId: 'read-wire' })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(
      written.some((frame) => frame.id === 'read-wire'),
      false
    )
    listener({
      type: 'host_uri_request',
      id: 'late-read',
      operation: 'read',
      url: rpcChildUri('reply', request.id)
    })
    await new Promise<void>((r) => setImmediate(r))
    const late = written.find((frame) => frame.id === 'late-read')
    assert.equal(late?.type === 'host_uri_result' ? late.isError : undefined, true)
  } finally {
    bridge.dispose()
  }
})

test('generation bridge rejects a second binding and mismatched channel identity', () => {
  const { authority, controller } = childAuthority()
  const channel: RpcControlChannel = {
    generation: 1,
    signal: controller.signal,
    onFrame: () => () => {},
    sendControl: async () => {}
  }
  const bridge = new RpcChildHostUriBridge({ channel, authority })
  assert.throws(() => new RpcChildHostUriBridge({ channel, authority }), /capacity/)
  bridge.dispose()
  assert.throws(() => new RpcChildHostUriBridge({ channel, authority }), /capacity/)
  const other = childAuthority()
  try {
    assert.throws(
      () =>
        new RpcChildHostUriBridge({
          channel: { ...channel, signal: new AbortController().signal },
          authority: other.authority
        }),
      /capacity/
    )
    assert.throws(
      () =>
        new RpcChildHostUriBridge({
          channel: { ...channel, signal: other.controller.signal, generation: 2 },
          authority: other.authority
        }),
      /capacity/
    )
  } finally {
    other.authority.dispose()
  }
})

test('cross-child cancellation cannot retire another outstanding human approval', async () => {
  const waiting = new Map<
    string,
    { signal: AbortSignal; release: (decision: 'approved') => void }
  >()
  const { authority, controller } = childAuthority({
    approval: {
      shouldGate: () => true,
      requestToolApproval: (request, signal) =>
        new Promise((resolve) => waiting.set(request.toolCallId!, { signal, release: resolve }))
    }
  })
  let receive!: (frame: RpcFrame) => void
  const written: Array<Record<string, unknown>> = []
  const channel: RpcControlChannel = {
    generation: 1,
    signal: controller.signal,
    onFrame: (listener) => {
      receive = listener
      return () => {}
    },
    sendControl: async (frame) => {
      validateControlFrame(frame)
      written.push(frame)
    }
  }
  const bridge = new RpcChildHostUriBridge({ channel, authority })
  const second = {
    ...childScope,
    nativeAgentId: 'second',
    childOmpSessionId: 'second-sdk',
    childSessionFile: '/srv/history/root/second.jsonl'
  }
  try {
    await activateChild(authority)
    await activateChild(authority, second)
    const a = {
      ...childRequest('approve', 3),
      operation: 'approve' as const,
      call: createRpcChildCall(childScope, 'first-write', 'write', {
        path: '/srv/project/one',
        content: 'one'
      })
    }
    const b = {
      ...childRequest('approve', 3, second),
      operation: 'approve' as const,
      call: createRpcChildCall(second, 'second-write', 'write', {
        path: '/srv/project/two',
        content: 'two'
      })
    }
    for (const [wire, request] of [
      ['write-a', a],
      ['write-b', b]
    ] as const)
      receive({
        type: 'host_uri_request',
        id: wire,
        operation: 'write',
        url: rpcChildUri('request', request.id),
        content: JSON.stringify(request)
      })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(waiting.size, 2)
    const cross = {
      schema: 1,
      operation: 'cancel',
      id: randomUUID(),
      sequence: 4,
      scope: childScope,
      capability: a.capability,
      targetId: b.id
    }
    receive({
      type: 'host_uri_request',
      id: 'cross-cancel',
      operation: 'write',
      url: rpcChildUri('cancel', cross.id),
      content: JSON.stringify(cross)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(waiting.get('second-write')!.signal.aborted, false)
    const own = { ...cross, id: randomUUID(), sequence: 5, targetId: a.id }
    receive({
      type: 'host_uri_request',
      id: 'own-cancel',
      operation: 'write',
      url: rpcChildUri('cancel', own.id),
      content: JSON.stringify(own)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(waiting.get('first-write')!.signal.aborted, true)
    assert.equal(waiting.get('second-write')!.signal.aborted, false)
    receive({
      type: 'host_uri_request',
      id: 'second-read',
      operation: 'read',
      url: rpcChildUri('reply', b.id)
    })
    waiting.get('second-write')!.release('approved')
    await new Promise<void>((r) => setImmediate(r))
    const reply = written.find((frame) => frame.id === 'second-read')
    assert.equal(JSON.parse(String(reply?.content)).allowed, true)
    assert.equal(
      written.some((frame) => frame.id === 'read-a'),
      false
    )
  } finally {
    bridge.dispose()
  }
})
test('outstanding URI capacity refuses immediately and scoped cancellation releases its slot', async () => {
  const { authority, controller } = childAuthority()
  let receive!: (frame: RpcFrame) => void
  const written: Array<Record<string, unknown>> = []
  const channel: RpcControlChannel = {
    generation: 1,
    signal: controller.signal,
    onFrame: (listener) => {
      receive = listener
      return () => {}
    },
    sendControl: async (frame) => {
      validateControlFrame(frame)
      written.push(frame)
    }
  }
  const bridge = new RpcChildHostUriBridge({ channel, authority, maxOutstanding: 1 })
  try {
    const a = childRequest('register', 1),
      second = {
        ...childScope,
        nativeAgentId: 'second',
        childOmpSessionId: 'second-sdk',
        childSessionFile: '/srv/history/root/second.jsonl'
      },
      b = childRequest('register', 1, second)
    receive({
      type: 'host_uri_request',
      id: 'first',
      operation: 'write',
      url: rpcChildUri('request', a.id),
      content: JSON.stringify(a)
    })
    receive({
      type: 'host_uri_request',
      id: 'over-capacity',
      operation: 'write',
      url: rpcChildUri('request', b.id),
      content: JSON.stringify(b)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(written.find((frame) => frame.id === 'over-capacity')?.isError, true)
    const cancel = {
      schema: 1,
      operation: 'cancel',
      id: randomUUID(),
      sequence: 2,
      scope: childScope,
      capability: a.capability,
      targetId: a.id
    }
    receive({
      type: 'host_uri_request',
      id: 'cancel-first',
      operation: 'write',
      url: rpcChildUri('cancel', cancel.id),
      content: JSON.stringify(cancel)
    })
    await new Promise<void>((r) => setImmediate(r))
    receive({
      type: 'host_uri_request',
      id: 'second-write',
      operation: 'write',
      url: rpcChildUri('request', b.id),
      content: JSON.stringify(b)
    })
    receive({
      type: 'host_uri_request',
      id: 'second-read',
      operation: 'read',
      url: rpcChildUri('reply', b.id)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(
      JSON.parse(String(written.find((frame) => frame.id === 'second-read')?.content)).allowed,
      true
    )
    receive({
      type: 'host_uri_request',
      id: 'second-read-replay',
      operation: 'read',
      url: rpcChildUri('reply', b.id)
    })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(written.find((frame) => frame.id === 'second-read-replay')?.isError, true)
  } finally {
    bridge.dispose()
  }
})
