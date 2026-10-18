import assert from 'node:assert/strict'
import test from 'node:test'
import type { PhiTool } from '../src/main/agent/engine/types'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'

const DISCOVERABLE = 24
const field = (tool: number, index: number): [string, unknown] => [
  `field_${index}`,
  { type: 'string', description: `Complete ordinary field ${index} on tool ${tool}` }
]

/** Tool 0 needs write approval; tools 1..N-1 are discoverable reads; `xd_direct` stays top-level. */
function roster(calls: Array<Record<string, unknown>>): PhiTool[] {
  const make = (name: string, index: number, extra: Partial<PhiTool>): PhiTool => ({
    name,
    label: `Synthetic ${name}`,
    description: `Curated synthetic desktop tool ${name}`,
    site: 'host',
    strict: true,
    approval: 'read',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => field(index, i))),
      additionalProperties: false
    },
    async execute(id, args, _update, ctx) {
      calls.push({ id, name, args, cwd: ctx.cwd })
      return { content: [{ type: 'text', text: `host result of ${name}` }] }
    },
    ...extra
  })
  return [
    ...Array.from({ length: DISCOVERABLE }, (_, i) =>
      make(`xd_host_${i}`, i, {
        loadMode: 'discoverable',
        approval: i === 0 ? 'write' : 'read'
      })
    ),
    make('xd_direct', 99, { loadMode: 'essential' })
  ]
}

type Fixture = Awaited<ReturnType<typeof runtimeCompositionFixture>>
type ToolMessage = { role: string; content: string; tool_call_id: string }
async function toolMessages(f: Fixture): Promise<Map<string, string>> {
  const requests = (await f.sdk.snapshot()).providerRequests as Array<{
    body: { messages: ToolMessage[] }
  }>
  const last = requests.at(-1)!.body.messages.filter((message) => message.role === 'tool')
  return new Map(last.map((message) => [message.tool_call_id, String(message.content)]))
}
const write = (
  id: string,
  path: string,
  content = '{"field_0":"value"}'
): { tool: { id: string; name: string; args: Record<string, string> } } => ({
  tool: { id, name: 'write', args: { path, content } }
})

async function setup(
  t: test.TestContext,
  decide: (name: string) => 'approved' | 'denied' = () => 'approved'
): Promise<{
  f: Fixture
  runtime: Awaited<ReturnType<Fixture['create']>>
  calls: Array<Record<string, unknown>>
  approvals: string[]
}> {
  const f = await runtimeCompositionFixture()
  t.after(() => f.close())
  const calls: Array<Record<string, unknown>> = []
  const approvals: string[] = []
  const runtime = await f.create({
    tools: roster(calls),
    approval: {
      shouldGate: () => true,
      requestToolApproval: async (request) => {
        approvals.push(request.toolName)
        return decide(request.toolName)
      }
    }
  })
  assert.equal(runtime.isReady, true)
  return { f, runtime, calls, approvals }
}

test(
  'discoverable host tools stay off the model roster and run through xd:// like a direct host call',
  { timeout: 90000 },
  async (t) => {
    const { f, runtime, calls, approvals } = await setup(t)
    await f.sdk.enqueue(
      { tool: { id: 'list', name: 'read', args: { path: 'xd://' } } },
      { tool: { id: 'docs', name: 'read', args: { path: 'xd://xd_host_0' } } },
      write('run0', 'xd://xd_host_0'),
      write('run1', 'xd://xd_host_1', '{"field_3":"other"}'),
      { tool: { id: 'direct', name: 'xd_direct', args: { field_0: 'top-level' } } },
      { text: 'xdev flow complete' }
    )
    const turn = await runtime.prompt('xdev-1', 'Discover and run the desktop tools')
    assert.equal(turn.result.status, 'completed', JSON.stringify(turn.result))
    // (a) Model-facing roster: native tools plus the essential host tool only.
    assert.ok(f.wire.length >= 6)
    let largest = 0
    for (const raw of f.wire) {
      const context = (raw as { context: { tools: Array<{ name: string }> } }).context
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(), [
        'bash',
        'edit',
        'glob',
        'grep',
        'read',
        'write',
        'xd_direct'
      ])
      largest = Math.max(largest, JSON.stringify(raw).length)
    }
    t.diagnostic(`largest model request: ${largest} bytes`)
    // (b) Discovery returned the mounted devices and their schema; execution reached the desktop.
    const results = await toolMessages(f)
    assert.match(results.get('list') ?? '', new RegExp(`${DISCOVERABLE} mounted tool devices`))
    assert.match(results.get('list') ?? '', /xd:\/\/xd_host_0/)
    assert.match(results.get('docs') ?? '', /field_39/)
    assert.equal(results.get('run0'), 'host result of xd_host_0')
    assert.equal(results.get('run1'), 'host result of xd_host_1')
    assert.equal(results.get('direct'), 'host result of xd_direct')
    assert.deepEqual(
      calls.map((call) => [call.id, call.name, call.args]),
      [
        ['run0', 'xd_host_0', { field_0: 'value' }],
        ['run1', 'xd_host_1', { field_3: 'other' }],
        ['direct', 'xd_direct', { field_0: 'top-level' }]
      ]
    )
    // Approval follows the real inner tool (write for xd_host_0), never the `write` transport.
    assert.ok(approvals.includes('xd_host_0'))
    assert.equal(approvals.includes('write'), false)
  }
)

test(
  'a denied inner approval refuses the xd:// call without executing and keeps the connection alive',
  { timeout: 90000 },
  async (t) => {
    const { f, runtime, calls, approvals } = await setup(t, (name) =>
      name === 'xd_host_0' ? 'denied' : 'approved'
    )
    await f.sdk.enqueue(write('denied', 'xd://xd_host_0'), write('after', 'xd://xd_host_1'), {
      text: 'handled denial'
    })
    const turn = await runtime.prompt('xdev-deny', 'Try the write-approval device')
    assert.equal(turn.result.status, 'completed', JSON.stringify(turn.result))
    assert.deepEqual(
      calls.map((call) => call.name),
      ['xd_host_1']
    )
    assert.ok(approvals.includes('xd_host_0'))
    const results = await toolMessages(f)
    assert.doesNotMatch(results.get('denied') ?? '', /host result/)
    assert.equal(results.get('after'), 'host result of xd_host_1')
  }
)

test(
  'forged, native and non-canonical xd:// calls are refused and never close the connection',
  { timeout: 90000 },
  async (t) => {
    const { f, runtime, calls } = await setup(t)
    const forged: Array<[string, unknown]> = [
      ['unknown', write('unknown', 'xd://xd_missing')],
      ['native', write('native', 'xd://bash', '{"command":"echo owned"}')],
      ['report', write('report', 'xd://report_issue', '{"note":"x"}')],
      ['upper', write('upper', 'XD://xd_host_0')],
      ['space', write('space', ' xd://xd_host_0')],
      ['subpath', write('subpath', 'xd://xd_host_0/extra')],
      ['hashline', write('hashline', '[xd://xd_host_0#ABCD]')],
      ['root', write('root', 'xd://')],
      ['readsub', { tool: { id: 'readsub', name: 'read', args: { path: 'xd://a/b' } } }],
      ['readsel', { tool: { id: 'readsel', name: 'read', args: { path: 'xd://:raw' } } }],
      [
        'edit',
        {
          tool: {
            id: 'edit',
            name: 'edit',
            args: { path: 'xd://xd_host_0', old_string: 'a', new_string: 'b' }
          }
        }
      ],
      [
        'grep',
        { tool: { id: 'grep', name: 'grep', args: { pattern: 'x', path: 'xd://xd_host_0' } } }
      ]
    ]
    await f.sdk.enqueue(...forged.map(([, step]) => step as never), { text: 'all refused' })
    const turn = await runtime.prompt('xdev-forged', 'Try forged device calls')
    assert.equal(turn.result.status, 'completed', JSON.stringify(turn.result))
    assert.equal(calls.length, 0, 'no forged call may reach a host tool')
    const results = await toolMessages(f)
    for (const [id] of forged) {
      assert.ok(results.has(id), `${id} must get a model-visible refusal`)
      assert.doesNotMatch(results.get(id)!, /host result|owned/u, id)
    }
    // The same connection still serves a legitimate device call afterwards.
    await f.sdk.enqueue(write('legit', 'xd://xd_host_2'), { text: 'still alive' })
    assert.equal(
      (await runtime.prompt('xdev-after', 'Run a legitimate call')).result.status,
      'completed'
    )
    assert.equal((await toolMessages(f)).get('legit'), 'host result of xd_host_2')
    assert.deepEqual(
      calls.map((call) => call.name),
      ['xd_host_2']
    )
  }
)
