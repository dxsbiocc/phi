import assert from 'node:assert/strict'
import test from 'node:test'

import { createRemoteProjectToolGuardExtension } from '../src/main/agent/agents/remote-project-tool-guard'
import {
  REMOTE_MCP_PROJECT_DEPENDENCY_REASON,
  buildRemoteMcpGuardState,
  buildRemoteMcpProfilePolicy,
  loadRemoteApplicationMcp,
  prepareRemoteMcpSnapshot,
  remoteMcpLoadPlan,
  remoteMcpToolCallReason,
  type McpSnapshotLike,
  type RemoteMcpGuardState
} from '../src/main/agent/mcp/remote-mcp-policy'

const agentDir = '/local/private/phi'
const anchor = '/local/private/phi/remote-project-anchors/project-1'
const context = { agentDir, localProjectAnchor: anchor }

function snapshot(
  configs: McpSnapshotLike['configs'],
  sources: McpSnapshotLike['sources']
): McpSnapshotLike {
  return { configs, sources, exaApiKeys: [] }
}

function stateFor(
  profile: unknown,
  tools: Array<{ name: string; mcpServerName: string }>
): RemoteMcpGuardState {
  return buildRemoteMcpGuardState(buildRemoteMcpProfilePolicy(profile, context), tools, context)
}

function guard(
  tools: Array<{ name: string; description: string; sourceInfo: { source: string } }>,
  state: RemoteMcpGuardState
): (event: { toolName: string; input?: unknown }) => Promise<unknown> {
  let handler: ((event: { toolName: string; input?: unknown }) => Promise<unknown>) | undefined
  createRemoteProjectToolGuardExtension({ remoteMcpToolState: () => state })({
    on: (_event: string, callback: typeof handler) => {
      handler = callback
    },
    getAllTools: () => tools
  } as never)
  assert.ok(handler)
  return handler
}

test('remote HTTPS MCP is retained and its registered tool is allowed', () => {
  const profile = {
    mcpServers: { literature: { type: 'http', url: 'https://api.example.test/mcp' } }
  }
  const prepared = prepareRemoteMcpSnapshot(
    snapshot(
      { literature: { type: 'http', url: 'https://api.example.test/mcp' } },
      { literature: { path: `${agentDir}/mcp.json`, level: 'user' } }
    ),
    profile,
    context
  )
  assert.deepEqual(Object.keys(prepared.snapshot.configs), ['literature'])
  const state = buildRemoteMcpGuardState(
    prepared.policy,
    [{ name: 'mcp__literature_search', mcpServerName: 'literature' }],
    context
  )
  assert.equal(remoteMcpToolCallReason('mcp__literature_search', {}, 'mcp', state), undefined)
  const handler = guard(
    [
      {
        name: 'mcp__literature_search',
        description: 'Search literature',
        sourceInfo: { source: 'mcp' }
      }
    ],
    state
  )
  return assert.doesNotReject(handler({ toolName: 'mcp__literature_search', input: {} }))
})

test('remote API-only stdio MCP is allowed and never inherits a project cwd', () => {
  const profile = {
    mcpServers: { api: { command: 'node', args: ['api-client.mjs'], env: { TOKEN: 'secret' } } }
  }
  const prepared = prepareRemoteMcpSnapshot(
    snapshot(
      { api: { type: 'stdio', command: 'node', args: ['api-client.mjs'] } },
      { api: { path: `${agentDir}/mcp.json`, level: 'user' } }
    ),
    profile,
    context
  )
  assert.equal(prepared.snapshot.configs.api?.cwd, agentDir)
  assert.equal(prepared.policy.allowedServerNames.has('api'), true)
})

test('remote stdio MCP rejects project cwd, project placeholders and project inputs', () => {
  const profile = {
    mcpServers: {
      files: { command: 'node', cwd: anchor },
      placeholder: { command: '${workspaceFolder}/bin/mcp' },
      mixed: {
        type: 'http',
        url: 'https://api.example.test/mcp',
        command: `${anchor}/server`,
        cwd: anchor
      },
      relative: { command: 'remote-project-anchors/project-1/server' },
      relativeArg: { command: 'node', args: ['remote-project-anchors/project-1/data.json'] }
    }
  }
  const policy = buildRemoteMcpProfilePolicy(profile, context)
  assert.equal(policy.allowedServerNames.size, 0)
  assert.equal(policy.blockedServerReasons.get('files'), REMOTE_MCP_PROJECT_DEPENDENCY_REASON)
  assert.equal(policy.blockedServerReasons.get('placeholder'), REMOTE_MCP_PROJECT_DEPENDENCY_REASON)
  assert.equal(policy.blockedServerReasons.get('mixed'), REMOTE_MCP_PROJECT_DEPENDENCY_REASON)
  assert.equal(policy.blockedServerReasons.get('relative'), REMOTE_MCP_PROJECT_DEPENDENCY_REASON)
  assert.equal(policy.blockedServerReasons.get('relativeArg'), REMOTE_MCP_PROJECT_DEPENDENCY_REASON)

  const apiState = stateFor({ mcpServers: { api: { command: 'node' } } }, [
    { name: 'mcp__api_fetch', mcpServerName: 'api' }
  ])
  assert.match(
    remoteMcpToolCallReason('mcp__api_fetch', { path: `${anchor}/secret.txt` }, 'mcp', apiState) ??
      '',
    /依赖项目文件/
  )
  assert.match(
    remoteMcpToolCallReason(
      'mcp__api_fetch',
      { path: 'remote-project-anchors/project-1/secret.txt' },
      'mcp',
      apiState
    ) ?? '',
    /依赖项目文件/
  )
})

test('remote guard rejects a builtin or unknown tool with an allowed MCP name', async () => {
  const state = stateFor({ mcpServers: { api: { command: 'node' } } }, [
    { name: 'mcp__api_fetch', mcpServerName: 'api' }
  ])
  for (const source of ['builtin', 'extension']) {
    const handler = guard(
      [{ name: 'mcp__api_fetch', description: 'forged', sourceInfo: { source } }],
      state
    )
    const decision = (await handler({ toolName: 'mcp__api_fetch', input: {} })) as {
      block?: boolean
      reason?: string
    }
    assert.equal(decision.block, true)
    assert.match(decision.reason ?? '', /不是来自 Phi 应用级 mcp\.json/)
  }
})

test('remote MCP loading never asks the SDK to read the local project anchor', async () => {
  const calls: Array<{ cwd: string; options: Record<string, unknown> }> = []
  const result = await loadRemoteApplicationMcp({
    agentDir,
    localProjectAnchor: anchor,
    profile: {
      mcpServers: {
        global: { type: 'http', url: 'https://api.example.test/mcp' },
        project: { command: 'never-run' }
      }
    },
    load: async (cwd, options) => {
      calls.push({ cwd, options })
      return snapshot(
        {
          global: { type: 'http', url: 'https://api.example.test/mcp' },
          project: { type: 'stdio', command: 'never-run' }
        },
        {
          global: { path: `${agentDir}/mcp.json`, level: 'user' },
          project: { path: `${anchor}/.mcp.json`, level: 'project' }
        }
      )
    }
  })
  assert.deepEqual(calls, [{ cwd: agentDir, options: { enableProjectConfig: false } }])
  assert.deepEqual(Object.keys(result.snapshot.configs), ['global'])
  assert.equal(JSON.stringify(calls).includes(anchor), false)
})

test('local MCP loading keeps the project cwd and project-config setting unchanged', () => {
  assert.deepEqual(
    remoteMcpLoadPlan({
      projectCwd: '/local/project',
      agentDir,
      enableProjectConfig: true,
      remote: false
    }),
    { cwd: '/local/project', enableProjectConfig: true, globalOnly: false }
  )
  assert.deepEqual(
    remoteMcpLoadPlan({
      projectCwd: '/local/project',
      agentDir,
      enableProjectConfig: false,
      remote: false
    }),
    { cwd: '/local/project', enableProjectConfig: false, globalOnly: false }
  )
})
