import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopMcpFixture, MCP_FIXTURE_SECRET } from './helpers/desktopMcpFixture'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

test(
  'official RPC CLI calls a genuine selected HTTPS MCP tool only after Phi approval',
  { timeout: 60000 },
  async (t) => {
    // Real registry model capacity isolates transport from automatic compaction;
    // the production maintenance policy stays enabled and unchanged.
    const remote = await runtimeCompositionFixture({ contextWindow: 1_000_000 })
    t.after(() => remote.close())
    const mcp = await desktopMcpFixture()
    t.after(() => mcp.close())
    const adapter = await mcp.adapter({
      identity: {
        runtimeSessionId: remote.f.params.sessionId,
        sessionId: remote.f.scope.phiSessionId,
        projectId: remote.f.scope.projectId,
        cwd: remote.f.params.cwd
      }
    })
    let approved = true,
      approvals = 0
    const runtime = await remote.create({
      tools: adapter.tools,
      hostApprovalFor: (name, input) => adapter.approvalFor(name, input),
      approval: {
        shouldGate: () => true,
        requestToolApproval: () => {
          approvals++
          return approved ? 'approved' : 'denied'
        }
      }
    })
    const observed: string[] = []
    let privateEvent = false
    runtime.onEvent((event) => {
      observed.push(event.type)
      if (JSON.stringify(event).includes(MCP_FIXTURE_SECRET)) privateEvent = true
    })
    await remote.sdk.enqueue(
      { tool: { name: adapter.tools[0].name, args: { operation: 'image' }, id: 'mcp-approved' } },
      { text: 'MCP result received.' }
    )
    assert.equal(
      (await runtime.prompt('mcp-cli-approved', 'Use the selected MCP tool.')).outcome,
      'completed'
    )
    assert.equal(approvals, 1)
    assert.equal(mcp.requests.filter((request) => request.method === 'tools/call').length, 1)
    const history = JSON.stringify(runtime.currentSnapshot())
    assert.match(history, /Complete MCP result image/)
    assert.doesNotMatch(history, new RegExp(MCP_FIXTURE_SECRET))
    await remote.sdk.enqueue(
      {
        tool: {
          name: adapter.tools[0].name,
          args: { operation: 'secret-keys' },
          id: 'mcp-key-privacy'
        }
      },
      { text: 'Private structured keys received safely.' }
    )
    assert.equal(
      (await runtime.prompt('mcp-cli-key-privacy', 'Receive structured data.')).outcome,
      'completed'
    )
    const keyHistory = JSON.stringify(runtime.currentSnapshot())
    assert.doesNotMatch(keyHistory, new RegExp(MCP_FIXTURE_SECRET))
    assert.match(keyHistory, /private key value|ordinary key value|nested key value/)
    assert.doesNotMatch(mcp.stdout(), new RegExp(MCP_FIXTURE_SECRET))
    assert.equal(privateEvent, false)
    assert.doesNotMatch(
      JSON.stringify((await remote.sdk.snapshot()).providerRequests),
      new RegExp(MCP_FIXTURE_SECRET)
    )
    await remote.sdk.enqueue(
      { tool: { name: adapter.tools[0].name, args: { operation: 'large' }, id: 'mcp-large' } },
      { text: 'Full MCP result received.' }
    )
    assert.equal(
      (
        await runtime
          .prompt('mcp-cli-large', 'Receive the complete large result.')
          .catch(async (error) => {
            t.diagnostic(
              JSON.stringify({
                events: observed.slice(-30),
                modelRequests: (await remote.sdk.snapshot()).providerRequests.length,
                mcpCalls: mcp.requests.filter((request) => request.method === 'tools/call').length
              })
            )
            throw error
          })
      ).outcome,
      'completed'
    )
    const largeHistory = JSON.stringify(runtime.currentSnapshot())
    assert.equal(largeHistory.split('完整结果🙂').length - 1, 70000)
    assert.doesNotMatch(largeHistory, new RegExp(MCP_FIXTURE_SECRET))
    approved = false
    await remote.sdk.enqueue(
      {
        tool: { name: adapter.tools[0].name, args: { operation: 'denied' }, id: 'mcp-denied' }
      },
      { text: 'MCP denial acknowledged.' }
    )
    assert.equal((await runtime.prompt('mcp-cli-denied', 'Use it again.')).outcome, 'failed')
    assert.equal(approvals, 4)
    assert.equal(mcp.requests.filter((request) => request.method === 'tools/call').length, 3)
  }
)
