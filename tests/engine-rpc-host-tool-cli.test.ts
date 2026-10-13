import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import type { PhiTool, PhiToolResult, PhiToolUpdate } from '../src/main/agent/engine/types'
import {
  RpcHostToolBridge,
  type RpcHostToolRun
} from '../src/main/agent/engine/rpc/host-tool-bridge'
import type { RpcFrame } from '../src/main/agent/engine/rpc/types'
import { hostToolCli } from './helpers/rpc-host-tool-cli'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII='
const result = (text: string): PhiToolResult => ({ content: [{ type: 'text', text }] })
function tool(execute: PhiTool['execute']): PhiTool {
  return {
    name: 'desktop_echo',
    label: 'Desktop Echo',
    description: 'Synthetic desktop host oracle',
    site: 'host',
    parameters: {
      oneOf: [
        {
          type: 'object',
          properties: { text: { type: 'string' }, nested: { type: 'object' } },
          required: ['text'],
          additionalProperties: false
        },
        {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false
        }
      ]
    },
    execute
  }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Private CLI did not reach its expected state')
    await turn()
  }
}
async function bridge(
  f: Awaited<ReturnType<typeof hostToolCli>>,
  host: PhiTool,
  known: ReadonlySet<string>
): Promise<RpcHostToolBridge> {
  const run: RpcHostToolRun = {
    id: 'synthetic-main-run',
    signal: new AbortController().signal,
    authorizeCall: (id, name) => (known.has(id) && name === host.name ? 'main' : undefined)
  }
  return RpcHostToolBridge.create({
    connection: f.connection,
    tools: [host],
    scope: {
      sessionId: 'oracle-session',
      projectId: 'oracle-project',
      cwd: f.cwd,
      recentUserImages: () => [{ type: 'image', data: PNG, mimeType: 'image/png' }],
      currentRun: () => run
    }
  })
}
function toolEnd(frames: RpcFrame[], id: string): RpcFrame | undefined {
  return frames.find((frame) => frame.type === 'tool_execution_end' && frame.toolCallId === id)
}

test(
  'actual private CLI host roster, ordered progress and model-visible text/image/history round trip',
  { timeout: 30000 },
  async (t) => {
    const f = await hostToolCli()
    t.after(() => f.close())
    await f.connection.start()
    let observed: unknown
    const output: PhiToolResult = {
      content: [
        { type: 'text', text: 'precise host answer' },
        { type: 'image', data: PNG, mimeType: 'image/png' }
      ],
      details: { source: 'desktop', nested: { preserved: true } }
    }
    const b = await bridge(
      f,
      tool(async (id, params, update, ctx) => {
        observed = { id, params, cwd: ctx.cwd, images: ctx.recentUserImages() }
        update?.({ ...result('first partial'), details: { order: 1 } })
        update?.({ ...result('second partial'), details: { order: 2 } })
        return output
      }),
      new Set(['oracle_success'])
    )
    t.after(() => b.dispose())
    assert.equal(b.isReady, true)
    f.provider.enqueue(
      {
        tool: {
          id: 'oracle_success',
          name: 'desktop_echo',
          args: { text: 'hello', nested: { bookkeeping: 'kept' }, i: 'harness intent' }
        }
      },
      { text: 'answer after host result' }
    )
    const prompt = await f.connection.prompt('Run the synthetic desktop_echo once')
    assert.equal(prompt.status, 'completed', f.stderr())
    assert.deepEqual(observed, {
      id: 'oracle_success',
      params: { text: 'hello', nested: { bookkeeping: 'kept' } },
      cwd: f.cwd,
      images: [{ type: 'image', data: PNG, mimeType: 'image/png' }]
    })
    const updates = f.frames.filter(
      (frame) => frame.type === 'tool_execution_update' && frame.toolCallId === 'oracle_success'
    )
    assert.deepEqual(
      updates.map(({ partialResult }) => partialResult),
      [
        { ...result('first partial'), details: { order: 1 } },
        { ...result('second partial'), details: { order: 2 } }
      ]
    )
    assert.deepEqual(toolEnd(f.frames, 'oracle_success')?.result, output)
    const history = await f.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    const saved = history.messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'oracle_success'
    )
    assert.deepEqual(saved?.content, output.content)
    assert.deepEqual(saved?.details, output.details)
    assert.equal(f.provider.requests.length, 2)
    const next = f.provider.requests[1].messages
    assert.equal(
      next.some(
        (message) =>
          message.role === 'tool' && String(message.content).includes('precise host answer')
      ),
      true
    )
    assert.equal(JSON.stringify(next).includes(`data:image/png;base64,${PNG}`), true)
    f.provider.enqueue({ text: 'a second prompt uses saved history' })
    assert.equal((await f.connection.prompt('Continue from that host result')).status, 'completed')
    assert.equal(
      JSON.stringify(f.provider.requests[2].messages).includes(`data:image/png;base64,${PNG}`),
      true
    )
    await f.connection.close()
    assert.equal(f.running(), false)
  }
)

test(
  'actual private CLI direct isError uses SDK rejection and text-only error history semantics',
  { timeout: 30000 },
  async (t) => {
    const f = await hostToolCli()
    t.after(() => f.close())
    await f.connection.start()
    const b = await bridge(
      f,
      tool(async () => ({
        ...result('explicit synthetic tool failure'),
        details: { notPreservedBySdk: true },
        isError: true
      })),
      new Set(['oracle_error'])
    )
    t.after(() => b.dispose())
    f.provider.enqueue(
      { tool: { id: 'oracle_error', name: 'desktop_echo', args: { text: 'fail' } } },
      { text: 'handled the host error' }
    )
    assert.equal(
      (await f.connection.prompt('Call the failing synthetic host tool')).status,
      'completed',
      f.stderr()
    )
    const ended = toolEnd(f.frames, 'oracle_error')
    assert.equal(ended?.isError, true)
    const history = await f.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    const saved = history.messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'oracle_error'
    )
    assert.equal(saved?.isError, true)
    assert.match(JSON.stringify(saved?.content), /explicit synthetic tool failure/)
    assert.notDeepEqual(saved?.details, { notPreservedBySdk: true })
    assert.equal(
      JSON.stringify(f.provider.requests[1].messages).includes('explicit synthetic tool failure'),
      true
    )
    await f.connection.close()
    assert.equal(f.running(), false)
  }
)

test(
  'actual private CLI same-channel abort targets host invocation and ignores late completion',
  { timeout: 30000 },
  async (t) => {
    const f = await hostToolCli()
    t.after(() => f.close())
    await f.connection.start()
    let started = false
    let signal: AbortSignal | undefined
    let update: PhiToolUpdate | undefined
    let resolve!: (value: PhiToolResult) => void
    const b = await bridge(
      f,
      tool((_id, _params, partial, _ctx, abort) => {
        started = true
        signal = abort
        update = partial
        return new Promise((done) => {
          resolve = done
        })
      }),
      new Set(['oracle_cancel'])
    )
    t.after(() => b.dispose())
    f.provider.enqueue({
      tool: { id: 'oracle_cancel', name: 'desktop_echo', args: { text: 'hold' } }
    })
    const prompt = f.connection.prompt('Call the held synthetic host tool')
    await until(() => started)
    const invocation = f.frames.find(
      (frame) => frame.type === 'host_tool_call' && frame.toolCallId === 'oracle_cancel'
    )
    assert.equal(typeof invocation?.id, 'string')
    await f.connection.abort()
    assert.equal((await prompt).status, 'aborted')
    await until(() => signal?.aborted === true)
    assert.equal(
      f.frames.some(
        (frame) => frame.type === 'host_tool_cancel' && frame.targetId === invocation?.id
      ),
      true
    )
    const ended = f.frames.filter(
      (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'oracle_cancel'
    ).length
    update?.(result('late partial'))
    resolve(result('late final'))
    for (let i = 0; i < 5; i++) await turn()
    assert.equal(
      f.frames.filter(
        (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'oracle_cancel'
      ).length,
      ended
    )
    assert.equal(JSON.stringify(f.frames).includes('late final'), false)
    assert.equal(f.provider.requests.length, 1)
    await f.connection.close()
    assert.equal(f.running(), false)
  }
)
