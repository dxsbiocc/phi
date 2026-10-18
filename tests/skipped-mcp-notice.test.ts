import assert from 'node:assert/strict'
import test from 'node:test'
import { createSkippedMcpNotifier } from '../src/main/agent/mcp/skipped-notice'
import {
  MAX_SKIPPED_MCP_NOTICE_NAME,
  MAX_SKIPPED_MCP_NOTICE_SERVERS,
  skippedMcpServersValue
} from '../src/shared/mcpSkippedServers'

function harness(): {
  appended: Array<{ sessionId: string; event: Record<string, unknown> }>
  broadcast: unknown[]
  notifier: ReturnType<typeof createSkippedMcpNotifier>
} {
  const appended: Array<{ sessionId: string; event: Record<string, unknown> }> = []
  const broadcast: unknown[] = []
  const notifier = createSkippedMcpNotifier({
    append: (sessionId, event) => {
      appended.push({ sessionId, event })
      return { ...event, eventId: 'e', sessionId, createdAt: 'now' }
    },
    broadcast: (_id, stored) => broadcast.push(stored)
  })
  return { appended, broadcast, notifier }
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
