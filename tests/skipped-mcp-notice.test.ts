import assert from 'node:assert/strict'
import test from 'node:test'
import { createSkippedMcpNotifier } from '../src/main/agent/mcp/skipped-notice'
import type { SessionEventInput } from '../src/main/agent/session/session-store'
import {
  MAX_SKIPPED_MCP_NOTICE_NAME,
  MAX_SKIPPED_MCP_NOTICE_SERVERS,
  skippedMcpServersValue
} from '../src/shared/mcpSkippedServers'

function harness(existing: SessionEventInput[] = []): {
  appended: Array<{ sessionId: string; event: SessionEventInput }>
  broadcast: unknown[]
  notifier: ReturnType<typeof createSkippedMcpNotifier>
  restart: () => ReturnType<typeof createSkippedMcpNotifier>
} {
  const appended: Array<{ sessionId: string; event: SessionEventInput }> = []
  const broadcast: unknown[] = []
  const make = (): ReturnType<typeof createSkippedMcpNotifier> =>
    createSkippedMcpNotifier({
      append: (sessionId, event) => {
        appended.push({ sessionId, event })
        return { ...event, eventId: 'e', sessionId, createdAt: 'now' }
      },
      broadcast: (_id, stored) => broadcast.push(stored),
      readEvents: (sessionId) => [
        ...existing,
        ...appended.filter((a) => a.sessionId === sessionId).map((a) => a.event)
      ]
    })
  return { appended, broadcast, notifier: make(), restart: make }
}

test('the same skipped set is announced once per session, a changed set again', () => {
  const { appended, broadcast, notifier } = harness()
  const a = [{ name: 'biomcp', reason: 'stdio_not_allowed' as const }]
  notifier.notify('s1', a)
  notifier.notify('s1', a)
  notifier.notify('s2', a)
  assert.equal(appended.length, 2)
  assert.equal(broadcast.length, 2)
  assert.equal(appended[0].event.type, 'mcp_servers_skipped')
  assert.deepEqual(appended[0].event.skippedMcpServers, a)
  notifier.notify('s1', [...a, { name: 'x', reason: 'connect_failed' as const }])
  assert.equal(appended.length, 3)
  notifier.notify('s1', [])
  assert.equal(appended.length, 3)
})

test('the stored notice is bounded', () => {
  const { appended, notifier } = harness()
  const many = Array.from({ length: 30 }, (_, i) => ({
    name: `${'n'.repeat(200)}${i}`,
    reason: 'connect_failed' as const
  }))
  notifier.notify('s1', many)
  const event = appended[0].event
  const servers = event.skippedMcpServers as Array<{ name: string }>
  assert.equal(servers.length, MAX_SKIPPED_MCP_NOTICE_SERVERS)
  assert.ok(servers.every((server) => server.name.length <= MAX_SKIPPED_MCP_NOTICE_NAME))
  assert.equal(event.skippedMcpOmitted, 10)
})

test('a changed omitted count is announced and survives restart', () => {
  const servers = Array.from({ length: MAX_SKIPPED_MCP_NOTICE_SERVERS + 2 }, (_, i) => ({
    name: `connector-${i}`,
    reason: 'connect_failed' as const
  }))
  for (const restart of [false, true]) {
    const f = harness()
    f.notifier.notify('s1', servers.slice(0, MAX_SKIPPED_MCP_NOTICE_SERVERS))
    const notifier = restart ? f.restart() : f.notifier
    notifier.notify('s1', servers.slice(0, -1))
    assert.equal(f.appended.length, 2)
    assert.equal(f.appended.at(-1)?.event.skippedMcpOmitted, 1)
    f.restart().notify('s1', servers.slice(0, -1))
    assert.equal(f.appended.length, 2, 'restart retains the announced omitted count')
    f.restart().notify('s1', servers)
    assert.equal(f.appended.length, 3)
    assert.equal(f.appended.at(-1)?.event.skippedMcpOmitted, 2)
  }
})

test('wire validation rejects unknown reasons, extra fields and duplicates', () => {
  assert.deepEqual(skippedMcpServersValue([{ name: 'a', reason: 'not_connected' }]), [
    { name: 'a', reason: 'not_connected' }
  ])
  assert.equal(skippedMcpServersValue([{ name: 'a', reason: 'boom' }]), undefined)
  assert.equal(skippedMcpServersValue([{ name: 'a', reason: 'not_connected', x: 1 }]), undefined)
  assert.equal(
    skippedMcpServersValue([
      { name: 'a', reason: 'not_connected' },
      { name: 'a', reason: 'not_connected' }
    ]),
    undefined
  )
  assert.equal(skippedMcpServersValue('nope'), undefined)
})

test('a restart does not repeat the last announced set', () => {
  const a = [{ name: 'biomcp', reason: 'connect_failed' as const }]
  const first = harness()
  first.notifier.notify('s1', a)
  first.restart().notify('s1', a)
  assert.equal(first.appended.length, 1)
  const seeded = harness([{ type: 'mcp_servers_skipped', skippedMcpServers: a }])
  seeded.notifier.notify('s1', a)
  assert.equal(seeded.appended.length, 0)
})

test('a reason flip within the same user-facing category is not re-announced', () => {
  const { appended, notifier } = harness()
  notifier.notify('s1', [{ name: 'x', reason: 'startup_failed' }])
  notifier.notify('s1', [{ name: 'x', reason: 'backoff' }])
  notifier.notify('s1', [{ name: 'x', reason: 'not_connected' }])
  assert.equal(appended.length, 1)
  notifier.notify('s1', [{ name: 'x', reason: 'api_key_missing' }])
  assert.equal(appended.length, 2)
})

test('a newly skipped server is announced', () => {
  const { appended, notifier } = harness()
  notifier.notify('s1', [{ name: 'x', reason: 'backoff' }])
  notifier.notify('s1', [
    { name: 'x', reason: 'backoff' },
    { name: 'y', reason: 'backoff' }
  ])
  assert.equal(appended.length, 2)
})

test('an empty set is quiet and the same set afterwards is not repeated', () => {
  const { appended, notifier } = harness()
  const a = [{ name: 'x', reason: 'connect_failed' as const }]
  notifier.notify('s1', a)
  notifier.notify('s1', [])
  notifier.notify('s1', a)
  assert.equal(appended.length, 1)
  notifier.notify('s1', [])
  notifier.notify('s1', [{ name: 'z', reason: 'connect_failed' }])
  assert.equal(appended.length, 2)
})
