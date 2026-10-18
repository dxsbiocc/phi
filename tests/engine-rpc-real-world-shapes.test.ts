import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { SessionRoutingEngine } from '../src/main/agent/engine/session-routing-engine'
import type { PhiEngine } from '../src/main/agent/engine/types'
import { buildNotebookCustomTools } from '../src/main/agent/notebook/notebook-tools'
import { beginRuntimeReferenceAdoption } from '../src/main/agent/session/session-store'
import { desktopMcpFixture } from './helpers/desktopMcpFixture'
import {
  realisticMcpTools,
  REALISTIC_MCP_NESTING,
  REALISTIC_MCP_TOOL_COUNT
} from './helpers/mcpRealisticCatalog'
import type { ModelReply } from './helpers/rpcHostResultModel'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import {
  remoteReference,
  remoteReferenceScope,
  withRemoteReferenceSession
} from './helpers/sessionRuntimeReferenceFixture'

type ToolMessage = { role: string; content: unknown; tool_call_id: string }
const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

const NOTEBOOK = {
  cells: [{ cell_type: 'code', source: ['print("中文 cell")\n'], metadata: {}, outputs: [] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5
}

test(
  'one remote RPC session survives the shapes real users and providers produce',
  { timeout: 90000 },
  async (t) => {
    const f = await runtimeCompositionFixture({ contextWindow: 1_000_000, realWorldShapes: true })
    t.after(() => f.close())
    // Identity shapes: ssh-config host profile, project root with a space and CJK characters.
    assert.match(f.f.scope.hostProfileId, /^ssh-config:/)
    const cwd = f.f.params.cwd
    assert.match(cwd, / .*项目/u)

    // Catalog shapes: 41 MCP tools, 40-level schemas, well over 128 KiB in total.
    const catalogBytes = Buffer.byteLength(JSON.stringify(realisticMcpTools()))
    assert.ok(catalogBytes > 128 * 1024, `catalog is ${catalogBytes} bytes`)
    const mcp = await desktopMcpFixture({ realisticCatalog: true })
    t.after(() => mcp.close())
    const adapter = await mcp.adapter({
      identity: {
        runtimeSessionId: f.f.params.sessionId,
        sessionId: f.f.scope.phiSessionId,
        projectId: f.f.scope.projectId,
        cwd
      }
    })
    assert.equal(adapter.tools.length, REALISTIC_MCP_TOOL_COUNT + 1)
    const bulk = adapter.tools.find((tool) => tool.name.endsWith('bulk_07'))
    assert.ok(bulk, 'bulk_07 must be mounted')
    let deep = (bulk.parameters.properties as Record<string, unknown>).deep
    for (let depth = 0; depth < REALISTIC_MCP_NESTING; depth++) {
      assert.ok(deep && typeof deep === 'object')
      deep = (deep as { properties: { child: unknown } }).properties.child
    }
    assert.equal((deep as { type: string }).type, 'string')

    const notebookCalls: unknown[] = []
    const notebook = buildNotebookCustomTools(async (request) => {
      notebookCalls.push(request.action)
      return { summary: 'notebooks: analysis.ipynb' }
    })
    const approvals: string[] = []
    const runtime = await f.create({
      tools: [...adapter.tools, ...notebook],
      hostApprovalFor: (name, input) =>
        adapter.approvalFor(name, input) ?? notebook.find((tool) => tool.name === name)?.approval,
      approval: {
        shouldGate: () => true,
        requestToolApproval: (request) => {
          approvals.push(request.toolName)
          return 'approved'
        }
      }
    })

    await writeFile(join(cwd, 'analysis.ipynb'), JSON.stringify(NOTEBOOK))
    const replies: ModelReply[] = [
      // A heredoc whose body contains `//` must not be taken for a path.
      {
        tool: {
          name: 'bash',
          args: { command: "cat <<'EOF' > heredoc.txt\nprint(len(a) // 2)\nEOF" }
        }
      },
      { tool: { name: 'read', args: { path: join(cwd, 'analysis.ipynb') } } },
      {
        tool: {
          name: 'edit',
          args: {
            path: join(cwd, 'analysis.ipynb'),
            old_string: '中文 cell',
            new_string: '更新 cell'
          }
        }
      },
      { tool: { name: 'read', args: { path: 'xd://' } } },
      {
        tool: {
          name: 'write',
          args: { path: `xd://${bulk.name}`, content: '{"operation":"run"}' }
        }
      },
      { tool: { name: 'notebook.list', args: {} } },
      { text: 'All real-world shapes handled.' }
    ]
    await f.sdk.enqueue(
      ...replies.map((reply, index) => ({
        ...reply,
        ...(reply.tool
          ? {
              tool: {
                ...reply.tool,
                id: `call-realistic-${index}\n${'provider-specific-id-'.repeat(4)}`
              }
            }
          : {})
      }))
    )
    const turn = await runtime.prompt('real-world-shapes', 'Exercise the usual tools.')
    assert.equal(turn.result.status, 'completed', JSON.stringify(turn.result))

    const requests = (await f.sdk.snapshot()).providerRequests as Array<{
      body: { messages: ToolMessage[]; tools?: Array<{ function: { name: string } }> }
    }>
    // Tool ids are Cursor-like: a newline and more than 64 characters.
    const ids = requests
      .at(-1)!
      .body.messages.filter((m) => m.role === 'tool')
      .map((m) => m.tool_call_id)
    assert.equal(ids.length, 6)
    for (const id of ids) {
      assert.match(id, /\n/u)
      assert.ok(id.length > 64)
    }
    const results = ids.map((id) =>
      text(requests.at(-1)!.body.messages.find((m) => m.tool_call_id === id)?.content)
    )
    assert.equal(await readFile(join(cwd, 'heredoc.txt'), 'utf8'), 'print(len(a) // 2)\n')
    assert.match(results[1], /中文 cell/u)
    const edited = JSON.parse(await readFile(join(cwd, 'analysis.ipynb'), 'utf8'))
    assert.deepEqual(edited.cells[0].source, ['print("更新 cell")\n'])
    assert.match(results[3], /mounted tool devices/u)
    assert.match(results[3], /bulk_07/u)
    assert.match(results[4], /Complete MCP result run/u)
    assert.deepEqual(
      mcp.requests
        .filter((request) => request.method === 'tools/call')
        .map((request) => (request.body.params as { name: string }).name),
      ['bulk_07']
    )
    assert.match(results[5], /analysis\.ipynb/u)
    assert.deepEqual(notebookCalls, ['list'])
    // The notebook tool is a direct (essential) tool; MCP devices stay behind xd://.
    const offered = requests[0].body.tools?.map((tool) => tool.function.name) ?? []
    assert.ok(offered.includes('notebook.list'), offered.join(','))
    assert.equal(
      offered.some((name) => name.includes('bulk_')),
      false
    )
    assert.ok(approvals.includes('bash') && approvals.includes('edit'))
  }
)

test('a project keeps listing its conversations after one of them ran remotely', async () => {
  await withRemoteReferenceSession(async (session) => {
    const lease = beginRuntimeReferenceAdoption(
      session.sessionId,
      remoteReferenceScope,
      'generation-1',
      {
        expectedOmpSessionId: 'omp-session-1',
        expectedJournalBasename: remoteReference(session.sessionId).journalBasename
      }
    )
    lease.adopt(remoteReference(session.sessionId))
    lease.release()
    const local = { path: '/agent/sessions/anchor/2026-10-15_local.jsonl', id: 'local' }
    const legacy = {
      history: { list: async () => [local], open: async () => ({}) }
    } as unknown as PhiEngine
    const engine = new SessionRoutingEngine(legacy, () => undefined)
    assert.deepEqual(await engine.history.list({ agentDir: '/agent', cwd: '/desktop/anchor' }), [
      local
    ])
  })
})
