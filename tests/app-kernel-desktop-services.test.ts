import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AppKernelDesktopServices } from '../src/main/agent/app-kernel-desktop-services'
import type { KernelHostRequestContext } from '../src/main/agent/engine/kernel-client'
import type { DesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-types'
import type { PhiSessionCreateParams } from '../src/main/agent/engine/types'
import type { PhiTool } from '../src/main/agent/engine/types'
import { createKernelFixture } from './engine-contract/kernel-factory'
import { desktopMcpFixture } from './helpers/desktopMcpFixture'

const LOCAL_MCP_SERVER = fileURLToPath(new URL('./helpers/kernelA13McpServer.mjs', import.meta.url))

function desktopAdapter(runtimeSessionId: string): DesktopMcpAdapter {
  const tool: PhiTool = {
    name: 'mcp__remote__echo',
    label: 'Remote echo',
    description: 'Echo through a desktop MCP server.',
    parameters: { type: 'object' },
    site: 'host',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
  }
  return {
    identity: {
      runtimeSessionId,
      sessionId: 'phi-remote',
      projectId: 'project-remote',
      cwd: '/remote/project'
    },
    tools: [tool],
    catalog: [
      {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        signature: 'a'.repeat(64)
      }
    ],
    skipped: [{ name: 'stdio-only', reason: 'stdio_not_allowed' }],
    approvalFor: () => 'write',
    retire: () => undefined,
    close: async () => undefined
  }
}

test('remote desktop MCP keeps its logical owner while binding the broker to the kernel session', async () => {
  const logicalSessionId = 'logical-session'
  const kernelSessionId = 'kernel-session'
  const adapter = desktopAdapter(logicalSessionId)
  const handlers = new Map<
    string,
    (params: never, context: KernelHostRequestContext) => unknown | Promise<unknown>
  >()
  const client = {
    registerHostCapability(
      capability: string,
      handler: (params: never, context: KernelHostRequestContext) => unknown | Promise<unknown>
    ) {
      handlers.set(capability, handler)
      return () => handlers.delete(capability)
    }
  }
  let loadedRuntimeSessionId: string | undefined
  const services = new AppKernelDesktopServices(
    {
      loadDesktopTools: async (identity: { runtimeSessionId: string }) => {
        loadedRuntimeSessionId = identity.runtimeSessionId
        return { desktopMcp: adapter }
      }
    } as never,
    { hostServices: { invoke: async () => undefined } } as never
  )
  const remove = services.configureClient(
    client as never,
    {
      hostKey: 'ssh:remote',
      resolveSession: (candidate) =>
        candidate === kernelSessionId
          ? {
              logicalSessionId,
              kernelSessionId,
              params: {
                sessionId: logicalSessionId,
                phiSessionId: 'phi-remote',
                agentDir: '/agent',
                cwd: '/remote/project',
                desktopMcp: { bindingId: 'desktop-binding' },
                remoteProject: {
                  phiSessionId: 'phi-remote',
                  projectId: 'project-remote',
                  location: {
                    kind: 'ssh',
                    hostProfileId: 'remote',
                    canonicalRoot: '/remote/project'
                  }
                }
              }
            }
          : undefined,
      snapshotSession: () => undefined
    } as never
  )

  try {
    const list = handlers.get('mcp.desktop.list')
    assert.ok(list)
    const result = (await list(
      {
        bindingId: 'desktop-binding',
        cwd: '/remote/project',
        registeredToolNames: ['read']
      } as never,
      { sessionId: kernelSessionId, signal: new AbortController().signal }
    )) as { tools: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> }

    assert.equal(loadedRuntimeSessionId, logicalSessionId)
    assert.equal(adapter.identity.runtimeSessionId, logicalSessionId)
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ['mcp__remote__echo']
    )
    assert.deepEqual(result.skipped, [{ name: 'stdio-only', reason: 'stdio_not_allowed' }])
  } finally {
    remove()
    await services.close()
  }
})

test('a remote session with no desktop MCP servers gets an empty catalog, not a failed session', async () => {
  const kernelSessionId = 'kernel-session-no-mcp'
  const handlers = new Map<
    string,
    (params: never, context: KernelHostRequestContext) => unknown | Promise<unknown>
  >()
  const client = {
    registerHostCapability(
      capability: string,
      handler: (params: never, context: KernelHostRequestContext) => unknown | Promise<unknown>
    ) {
      handlers.set(capability, handler)
      return () => handlers.delete(capability)
    }
  }
  const services = new AppKernelDesktopServices(
    { loadDesktopTools: async () => ({}) } as never,
    { hostServices: { invoke: async () => undefined } } as never
  )
  const remove = services.configureClient(
    client as never,
    {
      hostKey: 'ssh:remote',
      resolveSession: (candidate) =>
        candidate === kernelSessionId
          ? {
              logicalSessionId: 'logical-no-mcp',
              kernelSessionId,
              params: {
                sessionId: 'logical-no-mcp',
                phiSessionId: 'phi-remote',
                agentDir: '/agent',
                cwd: '/remote/project',
                desktopMcp: { bindingId: 'desktop-binding' },
                remoteProject: {
                  phiSessionId: 'phi-remote',
                  projectId: 'project-remote',
                  location: {
                    kind: 'ssh',
                    hostProfileId: 'remote',
                    canonicalRoot: '/remote/project'
                  }
                }
              }
            }
          : undefined,
      snapshotSession: () => undefined
    } as never
  )
  try {
    const list = handlers.get('mcp.desktop.list')
    assert.ok(list)
    const params = {
      bindingId: 'desktop-binding',
      cwd: '/remote/project',
      registeredToolNames: ['read']
    } as never
    const context = { sessionId: kernelSessionId, signal: new AbortController().signal }
    assert.deepEqual(await list(params, context), { tools: [], skipped: [] })
    // A wrong binding is still refused rather than read as "no servers".
    await assert.rejects(
      Promise.resolve(list({ ...(params as object), bindingId: 'other' } as never, context)),
      /Desktop MCP is unavailable/
    )
  } finally {
    remove()
    await services.close()
  }
})

test(
  'real locally spawned kernel prompt keeps desktop MCP ownership logical while routing by kernel identity',
  { timeout: 30_000 },
  async (t) => {
    const desktop = await desktopMcpFixture()
    t.after(() => desktop.close())
    const logicalSessionId = 'logical-local-kernel-session'
    const phiSessionId = 'phi-local-kernel-session'
    const projectId = 'project-local-kernel-session'
    const bindingId = 'desktop-local-kernel-binding'
    const adapter = await desktop.adapter({
      identity: {
        runtimeSessionId: logicalSessionId,
        sessionId: phiSessionId,
        projectId,
        cwd: desktop.resourceCwd
      }
    })
    let loadedRuntimeSessionId: string | undefined
    const services = new AppKernelDesktopServices(
      {
        loadDesktopTools: async (identity: { runtimeSessionId: string }) => {
          loadedRuntimeSessionId = identity.runtimeSessionId
          return { desktopMcp: adapter }
        }
      } as never,
      { hostServices: { invoke: async () => undefined } } as never
    )
    t.after(() => services.close())
    const fixture = await createKernelFixture({
      hostCapabilities: [...services.hostCapabilities]
    })
    t.after(() => fixture.close())
    const params: PhiSessionCreateParams = {
      sessionId: logicalSessionId,
      phiSessionId,
      agentDir: desktop.agentDir,
      cwd: desktop.resourceCwd,
      model: fixture.model,
      sessionManager: { kind: 'persistent', cwd: desktop.resourceCwd },
      enableToolApproval: false,
      desktopMcp: { bindingId },
      remoteProject: {
        phiSessionId,
        projectId,
        location: {
          kind: 'ssh',
          hostProfileId: 'local-kernel-fixture',
          remoteRoot: desktop.resourceCwd,
          canonicalRoot: desktop.resourceCwd
        },
        contextFiles: []
      }
    }
    let kernelSessionId: string | undefined
    const remove = services.configureClient(fixture.client, {
      hostKey: 'local-kernel-fixture',
      resolveSession: (candidate) => {
        kernelSessionId ??= candidate
        return candidate === kernelSessionId
          ? { logicalSessionId, kernelSessionId: candidate, params }
          : undefined
      },
      snapshotSession: () => undefined
    } as never)
    t.after(remove)

    const created = (await fixture.client.request('session.create', {
      cwd: desktop.resourceCwd,
      model: { provider: fixture.model.provider, id: fixture.model.id },
      resourceVersion: 'a'.repeat(64),
      sessionManager: { kind: 'persistent' },
      desktopMcp: { bindingId },
      autoCompaction: { enabled: false }
    })) as { sessionId?: string }
    assert.equal(created.sessionId, kernelSessionId)
    assert.notEqual(kernelSessionId, logicalSessionId)
    assert.equal(loadedRuntimeSessionId, logicalSessionId)
    assert.equal(adapter.identity.runtimeSessionId, logicalSessionId)

    fixture.provider.enqueue(
      {
        tool: {
          name: 'mcp__fixture_inspect',
          args: { operation: 'prompt-regression' },
          id: 'desktop-local-kernel-call'
        }
      },
      { text: 'Desktop MCP prompt completed.' }
    )
    const accepted = (await fixture.client.request(
      'session.prompt',
      { text: 'Use the desktop MCP fixture.' },
      { sessionId: kernelSessionId }
    )) as { runId?: string }
    assert.ok(accepted.runId)
    assert.deepEqual(await fixture.waitForRun(accepted.runId), { status: 'completed' })
    assert.ok(desktop.requests.some((request) => request.method === 'tools/call'))
    assert.equal(adapter.identity.runtimeSessionId, logicalSessionId)
    await fixture.client.request('session.close', {}, { sessionId: kernelSessionId })
  }
)

test(
  'real local-project persistent prompt runs with discovered MCP resources',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await createKernelFixture()
    t.after(() => fixture.close())
    const snapshotPath = join(fixture.cwd, 'local-project-mcp-snapshot.json')
    const schemaPath = join(fixture.cwd, 'local-project-mcp-schema.json')
    writeFileSync(schemaPath, JSON.stringify({ toolName: 'inspect' }))

    const created = (await fixture.client.request('session.create', {
      cwd: fixture.cwd,
      model: { provider: fixture.model.provider, id: fixture.model.id },
      resourceVersion: 'b'.repeat(64),
      sessionManager: { kind: 'persistent' },
      mcpServers: [
        {
          name: 'fixture',
          config: {
            command: process.execPath,
            args: [LOCAL_MCP_SERVER, snapshotPath, schemaPath],
            env: { MCP_SESSION_MARKER: 'local-project' },
            cwd: fixture.cwd
          }
        }
      ],
      autoCompaction: { enabled: false }
    })) as { sessionId?: string }
    assert.ok(created.sessionId)

    fixture.provider.enqueue(
      {
        tool: {
          name: 'mcp__fixture_inspect',
          args: { value: 'local-project-prompt' },
          id: 'local-project-mcp-call'
        }
      },
      { text: 'Local project prompt completed.' }
    )
    const accepted = (await fixture.client.request(
      'session.prompt',
      { text: 'Use the local project MCP resource.' },
      { sessionId: created.sessionId }
    )) as { runId?: string }
    assert.ok(accepted.runId)
    assert.deepEqual(await fixture.waitForRun(accepted.runId), { status: 'completed' })
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      methods: string[]
      calls: Array<{ name: string; arguments: { value?: string } }>
    }
    assert.ok(snapshot.methods.includes('tools/list'))
    assert.deepEqual(snapshot.calls, [
      { name: 'inspect', arguments: { value: 'local-project-prompt' } }
    ])
    await fixture.client.request('session.close', {}, { sessionId: created.sessionId })
  }
)
