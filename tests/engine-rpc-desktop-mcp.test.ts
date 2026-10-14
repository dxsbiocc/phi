import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  desktopMcpFixture,
  MCP_FIXTURE_SCHEMA,
  MCP_FIXTURE_SECRET
} from './helpers/desktopMcpFixture'
import { isDesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-adapter'
import type { DesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-types'
import type { PhiToolResult } from '../src/main/agent/engine/types'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('MCP fixture deadline')
    await delay(10)
  }
}

test(
  'an empty trusted MCP catalog opens no SDK auth store or server',
  { timeout: 15000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const adapter = await f.adapter({ serverNames: [] })
    assert.ok(isDesktopMcpAdapter(adapter))
    assert.deepEqual(adapter.tools, [])
    assert.equal(f.requests.length, 0)
    await assert.rejects(access(join(f.agentDir, 'agent.db')), { code: 'ENOENT' })
  }
)
function invoke(
  adapter: DesktopMcpAdapter,
  operation: string,
  signal?: AbortSignal,
  update?: (value: PhiToolResult) => void
): Promise<PhiToolResult> {
  return adapter.tools[0].execute(
    crypto.randomUUID(),
    { operation },
    update,
    { cwd: adapter.identity.cwd, recentUserImages: () => [] },
    signal
  )
}

test(
  'real HTTPS MCP catalog, auth, complete/image/structured results and write policy use the existing SDK',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const sentinel = join(f.root, 'unselected-executed')
    await f.profile({
      mcpServers: {
        fixture: {
          type: 'http',
          url: f.url,
          headers: { Authorization: MCP_FIXTURE_SECRET },
          headerPolicy: 'origin-locked'
        },
        unselected: { type: 'stdio', command: '/usr/bin/touch', args: [sentinel] }
      }
    })
    const adapter = await f.adapter()
    assert.ok(isDesktopMcpAdapter(adapter))
    assert.equal(adapter.tools.length, 1)
    assert.equal(adapter.tools[0].name, 'mcp__fixture_inspect')
    assert.deepEqual(adapter.tools[0].parameters, MCP_FIXTURE_SCHEMA)
    assert.equal(adapter.tools[0].approval, 'write', 'readOnlyHint cannot grant a lower permission')
    assert.equal(adapter.approvalFor(adapter.tools[0].name, { operation: 'write' }), 'write')
    const result = await invoke(adapter, 'image')
    assert.equal(result.content[1].type, 'image')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(MCP_FIXTURE_SECRET))
    assert.match(JSON.stringify(result), /\[redacted\]/)
    assert.ok(f.requests.every((request) => request.authorization === MCP_FIXTURE_SECRET))
    const large = await invoke(adapter, 'large')
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024)
    await assert.rejects(access(sentinel), { code: 'ENOENT' })
    assert.equal((await invoke(adapter, 'server-error')).isError, true)
    await assert.rejects(
      invoke(adapter, 'raw-error'),
      (error: Error) => !error.message.includes(MCP_FIXTURE_SECRET)
    )
  }
)

test(
  'session-private MCP managers survive idle, cancel one call, and close without stopping a peer',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const a = await f.adapter(),
      b = await f.adapter()
    await delay(2200)
    const updates: PhiToolResult[] = []
    const cancellation = new AbortController()
    const pending = invoke(a, 'hold', cancellation.signal, (value) => updates.push(value))
    void pending.catch(() => {})
    await until(() => f.requests.some((request) => request.method === 'tools/call'))
    await until(() => updates.length > 0)
    assert.doesNotMatch(JSON.stringify(updates), new RegExp(MCP_FIXTURE_SECRET))
    cancellation.abort()
    await assert.rejects(pending, /cancelled/)
    assert.match(JSON.stringify(await invoke(b, 'peer')), /Complete MCP result peer/)
    const before = f.requests.filter((request) => request.method === 'tools/call').length
    await a.close()
    await a.close()
    await assert.rejects(invoke(a, 'retired'))
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, before)
    assert.match(JSON.stringify(await invoke(b, 'peer again')), /peer again/)
    const sessions = f.requests
      .filter((request) => request.method === 'tools/call')
      .map((request) => request.session)
    assert.equal(new Set(sessions).size, 2)
  }
)

test(
  'MCP cancellation during discovery and live resource revocation have no late invocation',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    f.holdList(true)
    const cancelled = new AbortController()
    const discovery = f.adapter({ signal: cancelled.signal })
    void discovery.catch(() => {})
    await until(() => f.requests.some((request) => request.method === 'tools/list'))
    cancelled.abort()
    await assert.rejects(discovery, /cancelled/)
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 0)
    f.holdList(false)
    const a = await f.adapter()
    const pending = invoke(a, 'hold')
    void pending.catch(() => {})
    await until(() => f.requests.some((request) => request.method === 'tools/call'))
    await f.profile({ mcpServers: { fixture: { type: 'http', url: f.url, enabled: false } } })
    await assert.rejects(pending)
    await assert.rejects(invoke(a, 'after revoke'))
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 1)
  }
)

test(
  'MCP catalog rejects unknown/project-dependent/stdio configurations before launching or invoking',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    await assert.rejects(f.adapter({ serverNames: ['missing'] }), /discovery failed/)
    const sentinel = join(f.root, 'stdio-executed')
    await f.profile({
      mcpServers: { stdio: { type: 'stdio', command: '/usr/bin/touch', args: [sentinel] } }
    })
    await assert.rejects(f.adapter({ serverNames: ['stdio'] }), /discovery failed/)
    await assert.rejects(access(sentinel), { code: 'ENOENT' })
    await f.profile({ mcpServers: { fixture: { type: 'http', url: f.url } } })
    const a = await f.adapter()
    await assert.rejects(invoke(a, f.resourceCwd), /failed/)
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 0)
    await f.bridge.stop()
    await assert.rejects(invoke(a, 'after worker loss'))
    assert.equal(f.requests.filter((request) => request.method === 'initialize').length, 1)
  }
)

test(
  'explicit selected configured stdio reuses the existing manager and drains its own process',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const snapshot = join(f.root, 'stdio.json')
    await f.profile({
      mcpServers: {
        stdio: {
          type: 'stdio',
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./helpers/fixtureMcpServer.mjs', import.meta.url)),
            snapshot,
            'success'
          ],
          cwd: f.agentDir,
          env: {},
          envPolicy: 'literal'
        }
      }
    })
    const adapter = await f.adapter({ serverNames: ['stdio'], allowStdio: true })
    assert.deepEqual(
      adapter.tools.map((tool) => tool.name),
      ['mcp__stdio_fixture_first', 'mcp__stdio_fixture_second']
    )
    const result = await invoke(adapter, 'explicit stdio')
    assert.match(JSON.stringify(result), /explicit stdio/)
    const { pid } = JSON.parse(await readFile(snapshot, 'utf8'))
    await adapter.close()
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  }
)

test(
  'a changed real MCP schema cannot retain an old tool signature or execute a stale call',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const adapter = await f.adapter()
    f.changeSchema()
    await until(() => f.requests.filter((request) => request.method === 'tools/list').length >= 2)
    await assert.rejects(invoke(adapter, 'stale schema'), /failed/)
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 0)
    await adapter.close()
    const fresh = await f.adapter()
    assert.deepEqual(fresh.tools[0].parameters.required, [])
    assert.match(JSON.stringify(await invoke(fresh, 'fresh schema')), /fresh schema/)
  }
)

test(
  'real SDK MCP OAuth vaults stay bound to their selected agent directory and project',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const peerAgent = join(f.root, 'peer-agent'),
      peerAnchor = join(f.root, 'peer-anchor')
    await mkdir(peerAgent)
    await mkdir(peerAnchor)
    await f.profile({
      mcpServers: { fixture: { type: 'http', url: f.url, auth: { type: 'oauth' } } }
    })
    await writeFile(
      join(peerAgent, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { type: 'http', url: f.url, auth: { type: 'oauth' } }
        }
      }),
      { mode: 0o600 }
    )
    await f.seedOAuth('synthetic-oauth-A')
    await f.seedOAuth('synthetic-oauth-B', peerAgent)
    const a = await f.adapter(),
      b = await f.adapter({ agentDir: peerAgent, resourceCwd: peerAnchor })
    const first = await invoke(a, 'A'),
      second = await invoke(b, 'B')
    assert.doesNotMatch(JSON.stringify([first, second]), /synthetic-oauth-[AB]/)
    assert.deepEqual(
      f.requests
        .filter((request) => request.method === 'tools/call')
        .map((request) => request.authorization),
      ['Bearer synthetic-oauth-A', 'Bearer synthetic-oauth-B']
    )
    await a.close()
    await invoke(b, 'B remains usable')
    assert.equal(f.requests.at(-1)?.authorization, 'Bearer synthetic-oauth-B')
  }
)

test(
  'main binding assertions reject calls before dispatch and retire progress after rebind',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    let current = true
    const a = await f.adapter({
      beforeDispatch: () => {
        if (!current) throw new Error('binding retired')
      }
    })
    current = false
    await assert.rejects(invoke(a, 'wrong project'), /binding retired/)
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 0)
    current = true
    const updates: PhiToolResult[] = []
    const pending = invoke(a, 'hold', undefined, (value) => updates.push(value))
    void pending.catch(() => {})
    await until(() => updates.length > 0)
    a.retire()
    current = false
    await assert.rejects(pending)
    const count = updates.length
    await delay(30)
    assert.equal(updates.length, count)
  }
)

for (const status of [401, 403] as const)
  test(
    `real MCP OAuth ${status} failure never replays a tools/call`,
    { timeout: 45000 },
    async (t) => {
      const f = await desktopMcpFixture()
      t.after(() => f.close())
      await f.profile({
        mcpServers: {
          fixture: {
            type: 'http',
            url: f.url,
            auth: { type: 'oauth', credentialId: `mcp_oauth:profile:default:${f.url}` }
          }
        }
      })
      await f.seedOAuth(`synthetic-oauth-no-replay-${status}`)
      const adapter = await f.adapter()
      f.failNextToolCall(status)
      await assert.rejects(invoke(adapter, 'one approved effect'), /MCP tool call failed/)
      assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 1)
      assert.match(
        JSON.stringify(await invoke(adapter, 'next explicit call')),
        /next explicit call/
      )
      assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 2)
      assert.doesNotMatch(f.stdout(), new RegExp(`synthetic-oauth-no-replay-${status}`))
    }
  )

test(
  'concurrent MCP OAuth failures keep replay disabled for the owned connection',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    await f.profile({
      mcpServers: {
        fixture: {
          type: 'http',
          url: f.url,
          auth: { type: 'oauth', credentialId: `mcp_oauth:profile:default:${f.url}` }
        }
      }
    })
    await f.seedOAuth('synthetic-oauth-concurrent')
    const adapter = await f.adapter()
    f.failNextToolCall(401)
    f.failNextToolCall(403)
    const results = await Promise.allSettled([
      invoke(adapter, 'first effect'),
      invoke(adapter, 'second effect')
    ])
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected']
    )
    assert.equal(f.requests.filter((request) => request.method === 'tools/call').length, 2)
  }
)

test(
  'structured MCP keys redact recursively without losing ordinary collisions or polluting prototypes',
  { timeout: 45000 },
  async (t) => {
    const f = await desktopMcpFixture()
    t.after(() => f.close())
    const adapter = await f.adapter()
    assert.deepEqual(adapter.tools[0].parameters, MCP_FIXTURE_SCHEMA)
    const result = await invoke(adapter, 'secret-keys-unsafe')
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, new RegExp(MCP_FIXTURE_SECRET))
    assert.doesNotMatch(f.stdout(), new RegExp(MCP_FIXTURE_SECRET))
    const structured = (result.details as { structuredContent: Record<string, unknown> })
      .structuredContent
    assert.equal(structured['[redacted]'], 'ordinary key value')
    assert.equal(structured['[redacted] (2)'], 'ordinary second value')
    assert.equal(structured['[__proto__]'], 'ordinary proto alias value')
    for (const value of [
      'private key value',
      'suffix key value',
      'constructor value',
      'prototype value'
    ])
      assert.ok(Object.values(structured).includes(value))
    assert.match(serialized, /nested key value|unchanged nested value|polluted/)
    assert.equal(Object.hasOwn(structured, '__proto__'), false)
    assert.equal(Object.hasOwn(structured, 'constructor'), false)
    assert.equal(Object.hasOwn(structured, 'prototype'), false)
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined)
  }
)
