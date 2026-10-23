import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FacadeChildToolScopes,
  childJobView
} from '../src/main/agent/engine/rpc/facade-child-tool-scopes'
import { createRpcDesktopToolScope } from '../src/main/agent/engine/rpc/desktop-tool-scope'
import { HostServiceRegistry } from '../src/main/agent/engine/host-service-registry'
import { BrowserTextVault } from '../src/main/agent/browser/browser-text-vault'
import { createRpcChildCall } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type { RpcChildRun } from '../src/main/agent/engine/rpc/subagents/run-registry'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import { createDesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-adapter'
import type { DesktopMcpAdapter } from '../src/main/agent/engine/rpc/desktop-mcp-types'
import type { OmpBridge } from '../src/main/agent/engine/omp-bridge'

function fixture(options: { adapter?: DesktopMcpAdapter; vault?: BrowserTextVault } = {}): {
  manager: FacadeChildToolScopes
  runs: RpcChildRun[]
  active: Map<string, RpcChildRun>
  controllers: AbortController[]
  calls: Array<{ params: unknown; child?: string }>
} {
  const controllers = [new AbortController(), new AbortController()]
  const runs = controllers.map((controller, index): RpcChildRun => ({
    id: `private-child-${index}`,
    parentRunId: 'finished-parent',
    parentToolCallId: 'task-call',
    signal: controller.signal,
    modelSignal: controller.signal,
    scope: {
      phiSessionId: 'phi-one',
      projectId: 'project-one',
      cwd: '/srv/project',
      generation: 1,
      rootAgentId: 'Main',
      rootOmpSessionId: 'root-sdk',
      rootSessionFile: '/srv/private/root.jsonl',
      nativeAgentId: `native-${index}`,
      childOmpSessionId: `child-sdk-${index}`,
      childSessionFile: `/srv/private/root/${index}.jsonl`,
      parentSession: '/srv/private/root.jsonl',
      nativeName: 'phi_0123456789abcdef01234567_0_bg',
      definitionHash: 'a'.repeat(64)
    },
    profile: {
      tools: ['private_stats', ...(options.adapter?.tools.map((tool) => tool.name) ?? [])],
      model: {
        provider: 'test',
        id: 'model',
        reasoning: false,
        input: ['text'],
        contextWindow: 10000,
        maxTokens: 1000
      },
      route: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:12345/',
        transport: 'pi-native'
      },
      systemPromptDigest: 'b'.repeat(64),
      thinkingLevel: 'off'
    }
  }))
  const active = new Map(runs.map((run) => [run.id, run]))
  const calls: Array<{ params: unknown; child?: string }> = []
  const services = new HostServiceRegistry()
  services.register('skills.scriptTool', (params, context) => {
    calls.push({ params, child: context.agentRunId })
    return {
      ok: true,
      output: { evidence: 'actual desktop builder' },
      envId: 'ready-env',
      warnings: []
    }
  })
  const definition: PhiAgentDefinition = {
    name: 'Checker',
    description: 'checks',
    tools: ['private_stats', ...(options.adapter?.tools.map((tool) => tool.name) ?? [])],
    skills: ['stats'],
    visibility: 'entry',
    warnings: [],
    systemPrompt: 'check',
    source: 'phi',
    filePath: '/trusted/checker.md'
  }
  const manager = new FacadeChildToolScopes({
    definitions: [definition],
    current: (id) => active.get(id),
    name: () => 'Checker',
    createScope: (currentRun, owner, skills) =>
      createRpcDesktopToolScope({
        identity: {
          runtimeSessionId: 'runtime-one',
          sessionId: 'phi-one',
          projectId: 'project-one',
          cwd: '/srv/project'
        },
        services,
        currentRun,
        toolOwner: owner,
        ownsSharedResources: false,
        desktopMcp: options.adapter,
        recentUserImages: () => [],
        allowBrowserTypeText: () => false,
        browserTextVault: options.vault ?? new BrowserTextVault(),
        agentDir: '/trusted/agent',
        allowedSkills: skills,
        scriptTools: [
          {
            name: 'private_stats',
            description: 'private declared script',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false
            },
            attachTo: ['Checker'],
            skill: 'stats',
            approval: 'read'
          }
        ],
        scriptApprovalFor: () => 'read'
      })
  })
  return { manager, runs, active, controllers, calls }
}

test('expert-only scripts use genuine desktop builders and retain child identity after the parent ended', async () => {
  const f = fixture()
  try {
    assert.deepEqual(
      f.manager.hostTools.map((tool) => tool.name),
      ['private_stats']
    )
    const call = createRpcChildCall(f.runs[0].scope, 'script-one', 'private_stats', {
      input: 'sample'
    })
    assert.equal(f.manager.classify(f.runs[0], call), 'read')
    const result = await f.manager.execute(f.runs[0], call, new AbortController().signal)
    assert.match(JSON.stringify(result), /actual desktop builder/)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].child, f.runs[0].id)
  } finally {
    await f.manager.drain()
  }
})

test('schema failures and replaced child authority never reach the desktop executor', async () => {
  const f = fixture()
  try {
    const invalid = createRpcChildCall(f.runs[0].scope, 'invalid', 'private_stats', { input: 2 })
    await assert.rejects(
      f.manager.execute(f.runs[0], invalid, new AbortController().signal),
      /input was refused/
    )
    f.active.delete(f.runs[0].id)
    const stale = createRpcChildCall(f.runs[0].scope, 'stale', 'private_stats', { input: 'sample' })
    await assert.rejects(
      f.manager.execute(f.runs[0], stale, new AbortController().signal),
      /authority is unavailable/
    )
    assert.equal(f.calls.length, 0)
  } finally {
    await f.manager.drain()
  }
})

test('retiring one child scope leaves a peer child callable', async () => {
  const f = fixture()
  try {
    await f.manager.execute(
      f.runs[0],
      createRpcChildCall(f.runs[0].scope, 'one', 'private_stats', { input: 'a' }),
      new AbortController().signal
    )
    f.controllers[0].abort()
    await f.manager.drain(f.runs[0].id)
    await f.manager.execute(
      f.runs[1],
      createRpcChildCall(f.runs[1].scope, 'two', 'private_stats', { input: 'b' }),
      new AbortController().signal
    )
    assert.deepEqual(
      f.calls.map((call) => call.child),
      f.runs.map((run) => run.id)
    )
  } finally {
    await f.manager.drain()
  }
})

test('public job projection contains no server journal identity or execution capability', () => {
  const f = fixture()
  const view = childJobView({
    id: f.runs[0].id,
    phiSessionId: 'phi-one',
    projectId: 'project-one',
    generation: 1,
    parentRunId: 'parent',
    parentToolCallId: 'task',
    nativeId: 'native-one',
    childSessionFile: '/srv/private/secret.jsonl',
    agent: 'Checker',
    background: true,
    status: 'interrupted',
    verified: false,
    startedAt: 1,
    completedAt: 2
  })
  assert.equal(view.state, 'error')
  assert.equal(view.canControl, false)
  assert.equal(view.historyAvailable, false)
  assert.doesNotMatch(JSON.stringify(view), /srv\/private|native-one|phi-one|generation/)
})

test('catalog disposal and a single child drain preserve the root and peer shared MCP adapter', async () => {
  const requests: string[] = []
  const worker = new AbortController()
  const bridge = {
    retainResourceWorker: () => ({
      signal: worker.signal,
      release(): void {
        return undefined
      }
    }),
    onResourceProgress: () => (): void => {},
    async request(method: string): Promise<unknown> {
      requests.push(method)
      if (method === 'mcp.desktopCreate')
        return {
          tools: [
            {
              name: 'mcp__fixture',
              label: 'Fixture',
              description: 'owned shared adapter',
              parameters: { type: 'object', properties: {} },
              signature: 'a'.repeat(64)
            }
          ],
          skipped: []
        }
      return { content: [{ type: 'text', text: 'live MCP result' }] }
    }
  } as unknown as OmpBridge
  const identity = {
    runtimeSessionId: 'runtime-one',
    sessionId: 'phi-one',
    projectId: 'project-one',
    cwd: '/srv/project'
  }
  const adapter = await createDesktopMcpAdapter({
    identity,
    agentDir: '/trusted/agent',
    resourceCwd: '/trusted/anchor',
    serverNames: ['fixture'],
    approvalFor: () => 'read',
    bridge
  })
  const vault = new BrowserTextVault()
  const input = vault.sanitize('root-private-browser-call', {
    action: 'typeText',
    tabId: 'tab-one',
    expectedDocumentRevision: 1,
    consequence: 'write',
    text: 'root secret'
  })
  const rootActor = { id: 'root-run', signal: new AbortController().signal }
  const root = createRpcDesktopToolScope({
    identity,
    services: new HostServiceRegistry(),
    currentRun: () => rootActor,
    recentUserImages: () => [],
    allowBrowserTypeText: () => false,
    browserTextVault: vault,
    agentDir: '/trusted/agent',
    allowedSkills: [],
    scriptTools: [],
    desktopMcp: adapter
  })
  const f = fixture({ adapter, vault })
  try {
    assert.equal(adapter.approvalFor('mcp__fixture', {}), 'read')
    await f.manager.execute(
      f.runs[0],
      createRpcChildCall(f.runs[0].scope, 'mcp-one', 'mcp__fixture', {}),
      new AbortController().signal
    )
    f.controllers[0].abort()
    await f.manager.drain(f.runs[0].id)
    assert.equal(adapter.approvalFor('mcp__fixture', {}), 'read')
    const peer = await f.manager.execute(
      f.runs[1],
      createRpcChildCall(f.runs[1].scope, 'mcp-two', 'mcp__fixture', {}),
      new AbortController().signal
    )
    assert.match(JSON.stringify(peer), /live MCP result/)
    const rootResult = await root.tools
      .find((tool) => tool.name === 'mcp__fixture')!
      .execute('mcp-root', {}, undefined, { cwd: identity.cwd, recentUserImages: () => [] })
    assert.match(JSON.stringify(rootResult), /live MCP result/)
    assert.deepEqual(vault.take('root-private-browser-call', input.text), { text: 'root secret' })
    assert.equal(requests.filter((method) => method === 'mcp.desktopCancel').length, 0)
    root.dispose()
    assert.equal(adapter.approvalFor('mcp__fixture', {}), undefined)
    assert.equal(requests.filter((method) => method === 'mcp.desktopCancel').length, 1)
  } finally {
    await f.manager.drain()
    root.dispose()
    await adapter.close()
  }
})
