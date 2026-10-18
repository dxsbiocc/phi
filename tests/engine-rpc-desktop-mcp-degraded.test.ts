import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { desktopMcpFixture, MCP_FIXTURE_SECRET } from './helpers/desktopMcpFixture'

async function logEvents(agentDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(agentDir, 'logs')
  const files = await readdir(dir).catch(() => [] as string[])
  const lines = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf-8')))
  return lines
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test(
  'one unusable MCP server (stdio, dead endpoint, unknown) does not fail the others',
  { timeout: 60000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const sentinel = join(f.root, 'stdio-executed')
    await f.profile({
      mcpServers: {
        fixture: {
          type: 'http',
          url: f.url,
          headers: { Authorization: MCP_FIXTURE_SECRET },
          headerPolicy: 'origin-locked'
        },
        dead: {
          type: 'http',
          url: 'https://127.0.0.1:9/mcp',
          headers: { Authorization: MCP_FIXTURE_SECRET }
        },
        stdio: { type: 'stdio', command: '/usr/bin/touch', args: [sentinel] }
      }
    })
    const adapter = await f.adapter({ serverNames: ['fixture', 'dead', 'stdio', 'missing'] })
    assert.deepEqual(
      adapter.tools.map((tool) => tool.name),
      ['mcp__fixture_inspect']
    )
    await assert.rejects(access(sentinel), { code: 'ENOENT' })
    const byName = new Map(adapter.skipped.map((server) => [server.name, server.reason]))
    assert.equal(byName.get('stdio'), 'stdio_not_allowed')
    assert.equal(byName.get('missing'), 'unavailable')
    assert.ok(byName.has('dead'))
    assert.equal(byName.has('fixture'), false)
    const events = await logEvents(f.agentDir)
    const skipped = new Map(
      events
        .filter((event) => event.event === 'desktop_mcp_server_skipped')
        .map((event) => {
          const metadata = event.metadata as { server: string; reason: string }
          return [metadata.server, metadata.reason]
        })
    )
    assert.equal(skipped.get('stdio'), 'stdio_not_allowed')
    assert.equal(skipped.get('missing'), 'unavailable')
    assert.ok(skipped.has('dead'))
    assert.equal(skipped.has('fixture'), false)
    assert.doesNotMatch(JSON.stringify(events), new RegExp(MCP_FIXTURE_SECRET))
  }
)

test(
  'a tampered remote project server list stays fatal and names the failed stage',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    await assert.rejects(
      f.adapter({
        remoteProjectMcpServers: [{ name: 'forged' }] as never
      }),
      /MCP discovery failed while checking the MCP server list/
    )
    const failed = (await logEvents(f.agentDir)).find(
      (event) => event.event === 'desktop_mcp_discovery_failed'
    )
    assert.deepEqual(failed?.metadata, { stage: 'profile' })
  }
)

test(
  'a dead MCP server is skipped with reason backoff on the next run, and retried after its config changes',
  { timeout: 90000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const dead = (url: string): Record<string, unknown> => ({
      type: 'http',
      url,
      headers: { Authorization: MCP_FIXTURE_SECRET }
    })
    await f.profile({ mcpServers: { dead: dead('https://127.0.0.1:9/mcp') } })
    const first = await f.adapter({ serverNames: ['dead'] })
    assert.ok(first.skipped.some((s) => s.name === 'dead' && s.reason !== 'backoff'))
    const second = await f.adapter({ serverNames: ['dead'] })
    assert.deepEqual(second.skipped, [{ name: 'dead', reason: 'backoff' }])
    await f.profile({ mcpServers: { dead: dead('https://127.0.0.1:9/changed') } })
    const third = await f.adapter({ serverNames: ['dead'] })
    assert.ok(third.skipped.some((s) => s.name === 'dead' && s.reason !== 'backoff'))
    assert.doesNotMatch(JSON.stringify(await logEvents(f.agentDir)), new RegExp(MCP_FIXTURE_SECRET))
  }
)
