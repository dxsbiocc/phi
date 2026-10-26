import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonValue, ProtocolError } from '../src/shared/kernel-protocol'
import { KernelProtocolCore, type FrameTransport } from '../src/kernel/protocol'
import {
  DESKTOP_MCP_HOST_CAPABILITIES,
  registerDesktopMcpHostBroker
} from '../src/main/agent/engine/kernel-host/desktop-mcp-broker'
import {
  KernelProtocolClient,
  type KernelClientTransport
} from '../src/main/agent/engine/kernel-client'
import type { DesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-types'
import type { PhiTool } from '../src/main/agent/engine/types'

class PairedTransport implements FrameTransport, KernelClientTransport {
  peer?: PairedTransport
  private readonly lines = new Set<(line: string) => void>()
  private readonly closes = new Set<() => void>()

  send(line: string): void {
    queueMicrotask(() => {
      for (const listener of this.peer?.lines ?? []) listener(line)
    })
  }

  onLine(callback: (line: string) => void): void {
    this.lines.add(callback)
  }

  onClose(callback: () => void): void {
    this.closes.add(callback)
  }

  close(): void {
    for (const listener of this.closes) listener()
    for (const listener of this.peer?.closes ?? []) listener()
  }
}

function pair(): [PairedTransport, PairedTransport] {
  const client = new PairedTransport()
  const server = new PairedTransport()
  client.peer = server
  server.peer = client
  return [client, server]
}

function fakeAdapter(input: {
  runtimeSessionId: string
  phiSessionId: string
  cwd: string
  value: string
  closed: string[]
  cancelled: string[]
}): DesktopMcpAdapter {
  const signature = input.value
    .repeat(64)
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, 'a')
  const name = `mcp__${input.value}__work`
  const tool: PhiTool = {
    name,
    label: name,
    description: `Desktop tool for ${input.value}`,
    parameters: { type: 'object' },
    site: 'host',
    async execute(toolCallId, params, onUpdate, _context, signal) {
      onUpdate?.({ content: [{ type: 'text', text: `${input.value}:progress` }] })
      if ((params as { hold?: unknown }).hold === true) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              input.cancelled.push(toolCallId)
              reject(signal.reason)
            },
            { once: true }
          )
        })
      }
      return { content: [{ type: 'text', text: input.value }] }
    }
  }
  return {
    identity: {
      runtimeSessionId: input.runtimeSessionId,
      sessionId: input.phiSessionId,
      projectId: `project-${input.value}`,
      cwd: input.cwd
    },
    tools: [tool],
    catalog: [
      {
        name,
        label: name,
        description: tool.description,
        parameters: tool.parameters,
        signature
      }
    ],
    skipped: [],
    approvalFor: () => 'write',
    retire: () => {},
    close: async () => {
      input.closed.push(input.runtimeSessionId)
    }
  }
}

async function fixture(): Promise<{
  core: KernelProtocolCore
  client: KernelProtocolClient
  broker: ReturnType<typeof registerDesktopMcpHostBroker>
  closed: string[]
  cancelled: string[]
}> {
  const [clientTransport, serverTransport] = pair()
  const core = new KernelProtocolCore({ kernelVersion: 'test', ompVersion: 'test' })
  core.attachTransport(serverTransport, { trusted: true, connectionId: 'desktop' })
  const client = new KernelProtocolClient(clientTransport)
  const closed: string[] = []
  const cancelled: string[] = []
  const broker = registerDesktopMcpHostBroker(client, {
    async resolve({ bindingId, kernelSessionId, cwd }) {
      return {
        identity: {
          runtimeSessionId: kernelSessionId,
          sessionId: `phi-${bindingId}`,
          projectId: `project-${bindingId}`,
          cwd
        },
        agentDir: '/desktop/agent',
        resourceCwd: '/desktop/project',
        serverNames: [bindingId],
        approvalFor: () => 'write'
      }
    },
    createAdapter: async (options) =>
      fakeAdapter({
        runtimeSessionId: options.identity.runtimeSessionId,
        phiSessionId: options.identity.sessionId,
        cwd: options.identity.cwd,
        value: options.serverNames[0],
        closed,
        cancelled
      })
  })
  await client.hello({ hostCapabilities: [...DESKTOP_MCP_HOST_CAPABILITIES] })
  return { core, client, broker, closed, cancelled }
}

test('desktop MCP bridge keeps session adapters disjoint and streams progress', async () => {
  const f = await fixture()
  try {
    const list = async (sessionId: string, bindingId: string): Promise<Record<string, JsonValue>> =>
      (await f.core.requestHost(
        'mcp.desktop.list',
        { bindingId, cwd: `/remote/${bindingId}`, registeredToolNames: ['read'] },
        { sessionId }
      )) as Record<string, JsonValue>
    const first = await list('kernel-a', 'alpha')
    const second = await list('kernel-b', 'beta')
    const firstTool = (first.tools as Array<Record<string, JsonValue>>)[0]
    const secondTool = (second.tools as Array<Record<string, JsonValue>>)[0]
    assert.notEqual(firstTool.name, secondTool.name)

    const progress: JsonValue[] = []
    const called = await f.core.requestHost(
      'mcp.desktop.call',
      {
        bindingId: 'alpha',
        toolCallId: 'call-a',
        name: firstTool.name,
        signature: firstTool.signature,
        input: {}
      },
      { sessionId: 'kernel-a', runId: 'run-a' },
      (value) => progress.push(value)
    )
    assert.deepEqual(called, { content: [{ type: 'text', text: 'alpha' }] })
    assert.deepEqual(progress, [{ content: [{ type: 'text', text: 'alpha:progress' }] }])

    await f.core.requestHost('mcp.desktop.close', { bindingId: 'alpha' }, { sessionId: 'kernel-a' })
    assert.deepEqual(f.closed, ['kernel-a'])
    const beta = await f.core.requestHost(
      'mcp.desktop.call',
      {
        bindingId: 'beta',
        toolCallId: 'call-b',
        name: secondTool.name,
        signature: secondTool.signature,
        input: {}
      },
      { sessionId: 'kernel-b', runId: 'run-b' }
    )
    assert.deepEqual(beta, { content: [{ type: 'text', text: 'beta' }] })
  } finally {
    await f.broker.close()
    await f.client.close()
  }
})

test('desktop MCP bridge cancels calls and rejects registered-name shadowing', async () => {
  const f = await fixture()
  try {
    const listed = (await f.core.requestHost(
      'mcp.desktop.list',
      { bindingId: 'alpha', cwd: '/remote/alpha', registeredToolNames: [] },
      { sessionId: 'kernel-a' }
    )) as Record<string, JsonValue>
    const tool = (listed.tools as Array<Record<string, JsonValue>>)[0]
    const held = f.core.requestHost(
      'mcp.desktop.call',
      {
        bindingId: 'alpha',
        toolCallId: 'held-call',
        name: tool.name,
        signature: tool.signature,
        input: { hold: true }
      },
      { sessionId: 'kernel-a', runId: 'run-a' }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    await f.core.requestHost(
      'mcp.desktop.cancel',
      { bindingId: 'alpha', toolCallId: 'held-call' },
      { sessionId: 'kernel-a' }
    )
    await assert.rejects(held)
    assert.deepEqual(f.cancelled, ['held-call'])

    await assert.rejects(
      f.core.requestHost(
        'mcp.desktop.list',
        {
          bindingId: 'beta',
          cwd: '/remote/beta',
          registeredToolNames: ['mcp__beta__work']
        },
        { sessionId: 'kernel-b' }
      ),
      (error: ProtocolError) =>
        error.code === 'CAPABILITY_UNAVAILABLE' &&
        (error.detail as { reason?: unknown })?.reason === 'tool_name_conflict'
    )
  } finally {
    await f.broker.close()
    await f.client.close()
  }
})
