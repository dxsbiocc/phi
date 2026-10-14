import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir } from 'node:fs/promises'
import type { PhiTool, PhiToolResult } from '../src/main/agent/engine/types'
import { RpcHostToolBridge } from '../src/main/agent/engine/rpc/host-tool-bridge'
import { rpcHostResultFixture, resultPng } from './helpers/rpcHostResultFixture'
import { hostUntil } from './helpers/rpc-host-tool-wire'
import {
  hostProgressPlaceholder,
  HOST_RESULT_FAILURE
} from '../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'

const large = '进度🙂'.repeat(180_000)
async function attach(
  f: Awaited<ReturnType<typeof rpcHostResultFixture>>,
  execute: PhiTool['execute']
): Promise<RpcHostToolBridge> {
  const run = Object.freeze({
    id: 'run-1',
    signal: f.run.signal,
    authorizeCall: () => 'main' as const
  })
  return RpcHostToolBridge.create({
    connection: f.connection,
    resultDelivery: f.delivery,
    tools: [
      {
        name: 'desktop_echo',
        label: 'Echo',
        description: 'Progress fixture',
        site: 'host',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute
      }
    ],
    scope: {
      sessionId: f.lease.phiSessionId,
      projectId: f.lease.projectId,
      cwd: f.cwd,
      recentUserImages: () => [],
      currentRun: () => run
    }
  })
}

test(
  'actual CLI hydrates large text and image progress before final result, keeping small updates exact',
  { timeout: 30_000 },
  async (t) => {
    const f = await rpcHostResultFixture()
    t.after(() => f.close())
    const partials: PhiToolResult[] = [
      { content: [{ type: 'text', text: 'small' }], details: { step: 1 } },
      { content: [{ type: 'text', text: large }], details: { step: 2 } },
      {
        content: [{ type: 'image', data: resultPng(), mimeType: 'image/png' }],
        details: { step: 3 }
      }
    ]
    assert.ok(Buffer.byteLength(JSON.stringify(partials[1])) > 1024 * 1024)
    assert.ok(Buffer.byteLength(JSON.stringify(partials[2])) > 1024 * 1024)
    const bridge = await attach(f, async (id, _args, update) => {
      for (const partial of partials) update?.(partial)
      await hostUntil(
        () =>
          f.frames.filter(
            (frame) => frame.type === 'tool_execution_update' && frame.toolCallId === id
          ).length === 3
      )
      return { content: [{ type: 'text', text: 'complete' }] }
    })
    t.after(() => bridge.dispose())
    f.provider.enqueue(
      { tool: { id: 'large-progress', name: 'desktop_echo', args: {} } },
      { text: 'done' }
    )
    assert.equal((await f.connection.prompt('progress')).status, 'completed', f.stderr())
    assert.deepEqual(
      f.frames
        .filter((frame) => frame.type === 'tool_execution_update')
        .map((frame) => frame.partialResult),
      partials
    )
    assert.deepEqual(f.frames.find((frame) => frame.type === 'tool_execution_end')?.result, {
      content: [{ type: 'text', text: 'complete' }],
      details: {}
    })
    assert.ok(!JSON.stringify(f.frames).includes('phi_host_result_receipt'))
    await hostUntil(() => f.frames.some((frame) => frame.type === 'tool_execution_end'))
    assert.deepEqual(await readdir(f.directory), [])
  }
)

test(
  'actual CLI stop during progress transfer invalidates late update while a peer session completes',
  { timeout: 30_000 },
  async (t) => {
    let uploading = false
    const stopped = await rpcHostResultFixture({
      beforeCopy: async (_path, signal) => {
        uploading = true
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal?.aborted) reject(signal.reason)
        })
      }
    })
    const peer = await rpcHostResultFixture()
    t.after(() => stopped.close())
    t.after(() => peer.close())
    const partial: PhiToolResult = { content: [{ type: 'text', text: large }] }
    const stoppedBridge = await attach(stopped, async (_id, _args, update) => {
      update?.(partial)
      return { content: [{ type: 'text', text: 'must never complete' }] }
    })
    const peerBridge = await attach(peer, async (id, _args, update) => {
      update?.(partial)
      await hostUntil(() =>
        peer.frames.some(
          (frame) => frame.type === 'tool_execution_update' && frame.toolCallId === id
        )
      )
      return { content: [{ type: 'text', text: 'peer complete' }] }
    })
    t.after(() => stoppedBridge.dispose())
    t.after(() => peerBridge.dispose())
    stopped.provider.enqueue({
      tool: { id: 'large-stopped-progress', name: 'desktop_echo', args: {} }
    })
    peer.provider.enqueue(
      { tool: { id: 'large-peer-progress', name: 'desktop_echo', args: {} } },
      { text: 'peer done' }
    )
    const pending = stopped.connection.prompt('stop progress')
    const peerPending = peer.connection.prompt('peer progress')
    await hostUntil(() => uploading)
    await stopped.connection.abort()
    assert.equal((await pending).status, 'aborted')
    assert.equal((await peerPending).status, 'completed', peer.stderr())
    assert.equal(stopped.frames.filter((frame) => frame.type === 'tool_execution_update').length, 0)
    assert.ok(!JSON.stringify(stopped.frames).includes('must never complete'))
    assert.deepEqual(
      peer.frames.find((frame) => frame.type === 'tool_execution_update')?.partialResult,
      partial
    )
  }
)

test(
  'actual CLI rejects a forged progress sequence before exposing a private marker or successful final',
  { timeout: 30_000 },
  async (t) => {
    const f = await rpcHostResultFixture()
    t.after(() => f.close())
    const publish = f.delivery.publish.bind(f.delivery)
    f.delivery.publish = async (...args) => {
      const result = await publish(...args)
      return args[1].progressSequence === undefined ? result : hostProgressPlaceholder(2)
    }
    const bridge = await attach(f, async (_id, _args, update) => {
      update?.({ content: [{ type: 'text', text: large }] })
      return { content: [{ type: 'text', text: 'must fail after invalid progress' }] }
    })
    t.after(() => bridge.dispose())
    f.provider.enqueue(
      { tool: { id: 'large-forged-progress', name: 'desktop_echo', args: {} } },
      { text: 'failure handled' }
    )
    assert.equal((await f.connection.prompt('forged progress')).status, 'completed', f.stderr())
    const updates = f.frames.filter((frame) => frame.type === 'tool_execution_update')
    assert.equal(updates.length, 1)
    assert.ok(JSON.stringify(updates).includes(HOST_RESULT_FAILURE))
    assert.ok(!JSON.stringify(f.frames).includes('Phi private host progress snapshot'))
    assert.ok(!JSON.stringify(f.frames).includes(large))
    const end = f.frames.find((frame) => frame.type === 'tool_execution_end')
    assert.equal(end?.isError, true)
  }
)

test(
  'actual CLI keeps two calls in one run bound to their own progress files',
  { timeout: 30_000 },
  async (t) => {
    const f = await rpcHostResultFixture()
    t.after(() => f.close())
    const bridge = await attach(f, async (id, _args, update) => {
      update?.({ content: [{ type: 'text', text: large + id }], details: { call: id } })
      return { content: [{ type: 'text', text: 'complete ' + id }] }
    })
    t.after(() => bridge.dispose())
    const ids = ['large-first-progress', 'large-second-progress']
    f.provider.enqueue(...ids.map((id) => ({ tool: { id, name: 'desktop_echo', args: {} } })), {
      text: 'two calls complete'
    })
    assert.equal((await f.connection.prompt('two calls')).status, 'completed', f.stderr())
    for (const id of ids) {
      const update = f.frames.find(
        (frame) => frame.type === 'tool_execution_update' && frame.toolCallId === id
      )
      assert.deepEqual(update?.partialResult, {
        content: [{ type: 'text', text: large + id }],
        details: { call: id }
      })
    }
    assert.deepEqual(await readdir(f.directory), [])
  }
)
