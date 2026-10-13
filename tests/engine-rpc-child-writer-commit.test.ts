import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { RpcApprovalEvent } from '../src/main/agent/engine/rpc/approval-bridge'
import { RpcChildHostUriBridge } from '../src/main/agent/engine/rpc/subagents/host-uri-bridge'
import { rpcChildUri } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import { activateChild, childAuthority, childRequest } from './helpers/rpcChildAuthorityFixture'
import { hostToolWire, hostTurns, hostUntil } from './helpers/rpc-host-tool-wire'

async function fixture(): Promise<{
  wire: Awaited<ReturnType<typeof hostToolWire>>
  channel: ReturnType<Awaited<ReturnType<typeof hostToolWire>>['connection']['bindControl']>
  events: RpcApprovalEvent[]
  authority: ReturnType<typeof childAuthority>['authority']
  bridge: RpcChildHostUriBridge
  read(): void
  cancel(): void
  policyLoss(): void
}> {
  const wire = await hostToolWire(),
    channel = wire.connection.bindControl(),
    events: RpcApprovalEvent[] = []
  let gate = true
  const { authority } = childAuthority({
    signal: channel.signal,
    approval: {
      shouldGate: () => gate,
      requestToolApproval: () => 'approved',
      onEvent: (event) => {
        events.push(event)
      }
    }
  })
  const bridge = new RpcChildHostUriBridge({ channel, authority })
  await activateChild(authority)
  const request = childRequest('approve', 3)
  wire.emit({
    type: 'host_uri_request',
    id: 'request-write',
    operation: 'write',
    url: rpcChildUri('request', request.id),
    content: JSON.stringify(request)
  })
  await hostUntil(() => wire.commands.some((command) => command.id === 'request-write'))
  await hostTurns()
  return {
    wire,
    channel,
    events,
    authority,
    bridge,
    read: () =>
      wire.emit({
        type: 'host_uri_request',
        id: 'permission-read',
        operation: 'read',
        url: rpcChildUri('reply', request.id)
      }),
    cancel: () =>
      wire.emit({ type: 'host_uri_cancel', id: randomUUID(), targetId: 'permission-read' }),
    policyLoss: () => {
      gate = false
    }
  }
}
function terminals(events: RpcApprovalEvent[]): string[] {
  return events.filter((event) => event.type !== 'approval_requested').map((event) => event.type)
}
for (const change of ['policy', 'cancel'] as const)
  test(`real ordered writer never submits a queued old allow after ${change} changes`, async () => {
    const f = await fixture(),
      other = await hostToolWire()
    let release!: () => void
    try {
      f.wire.intercept((command, done) => {
        if (command.id === 'queue-blocker') {
          let released = false
          release = (error?: Error) => {
            if (released) return
            released = true
            done(error)
          }
          return true
        }
        return false
      })
      const blocker = f.channel.sendControl({
        type: 'host_tool_result',
        id: 'queue-blocker',
        result: { content: [] }
      })
      void blocker.catch(() => undefined)
      await hostUntil(() => !!release)
      f.read()
      await hostTurns()
      assert.equal(
        f.wire.commands.some((command) => command.id === 'permission-read'),
        false
      )
      if (change === 'policy') f.policyLoss()
      else f.cancel()
      const sibling = f.channel.sendControl({
        type: 'extension_ui_response',
        id: 'same-generation-sibling',
        confirmed: true
      })
      await other.connection
        .bindControl()
        .sendControl({ type: 'extension_ui_response', id: 'other-session', confirmed: true })
      release()
      await Promise.all([blocker, sibling])
      await hostTurns()
      assert.equal(
        f.wire.commands.some(
          (command) =>
            command.id === 'permission-read' &&
            typeof command.content === 'string' &&
            (JSON.parse(command.content) as { allowed: boolean }).allowed
        ),
        false
      )
      assert.deepEqual(terminals(f.events), ['approval_cancelled'])
      assert.equal(f.wire.connection.isReady, true)
      assert.equal(other.connection.isReady, true)
      assert.ok(f.wire.commands.some((command) => command.id === 'same-generation-sibling'))
    } finally {
      release?.()
      f.bridge.dispose()
      await f.wire.connection.close()
      await other.connection.close()
    }
  })
for (const late of ['cancel', 'dispose', 'io-failure'] as const)
  test(`physical allow submission is finalized by the writer once despite late ${late}`, async () => {
    const f = await fixture()
    let release!: (error?: Error) => void
    try {
      f.wire.intercept((command, done) => {
        if (command.id === 'permission-read') {
          let released = false
          release = (error?: Error) => {
            if (released) return
            released = true
            done(error)
          }
          return true
        }
        return false
      })
      f.read()
      await hostUntil(() => !!release)
      assert.ok(
        f.wire.commands.some(
          (command) =>
            command.id === 'permission-read' &&
            typeof command.content === 'string' &&
            (JSON.parse(command.content) as { allowed: boolean }).allowed
        )
      )
      if (late === 'cancel') f.cancel()
      else f.bridge.dispose()
      await hostTurns()
      assert.deepEqual(
        terminals(f.events),
        [],
        'Already submitted bytes await their actual writer result'
      )
      release(late === 'io-failure' ? new Error('Private physical write failure') : undefined)
      await hostTurns()
      assert.deepEqual(terminals(f.events), [
        late === 'io-failure' ? 'approval_cancelled' : 'approval_approved'
      ])
    } finally {
      release?.()
      f.bridge.dispose()
      await f.wire.connection.close()
    }
  })
