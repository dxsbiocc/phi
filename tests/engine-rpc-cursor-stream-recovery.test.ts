import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcCursorFixture } from './helpers/rpcCursorFixture'

interface Message {
  role: string
  content: unknown
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
}

async function history(f: Awaited<ReturnType<typeof createRpcCursorFixture>>): Promise<Message[]> {
  return (await f.cli.connection.request<{ messages: Message[] }>({ type: 'get_messages' }))
    .messages
}

test(
  'RPC Cursor text truncation continues retained output exactly once',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcCursorFixture()
    t.after(() => f.close())
    f.provider.enqueue({ text: 'RPC retained partial.', hold: true }, { text: 'RPC remainder.' })
    const result = await f.cli.connection.prompt('Finish the requested answer.')
    const messages = await history(f)
    assert.equal(result.status, 'completed', JSON.stringify({ result, messages }))
    assert.equal(f.provider.requests.length, 2)
    assert.equal(JSON.stringify(messages).split('RPC retained partial.').length - 1, 1)
    const requests = (await f.cli.audit()) as Array<{ messages: Array<{ role: string }> }>
    assert.equal(
      requests[1].messages.filter((message) => message.role === 'assistant').length,
      1,
      'The continuation preserves its assistant history in the actual native gateway request'
    )
    assert.match(JSON.stringify(messages), /RPC remainder/)
    assert.equal(f.cli.stderr(), '')
  }
)

test(
  'RPC Cursor repeated truncation settles after one continuation',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcCursorFixture()
    t.after(() => f.close())
    f.provider.enqueue(
      { text: 'RPC first partial.', hold: true },
      { text: 'RPC second partial.', hold: true }
    )
    const result = await f.cli.connection.prompt('Finish the requested answer.')
    assert.equal(result.status, 'error')
    assert.equal(f.provider.requests.length, 2)
    assert.equal((await history(f)).at(-1)?.errorMessage, 'Cursor stream ended before turnEnded')
  }
)

test(
  'RPC Cursor completed server tool is retained without replay after EOF',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcCursorFixture()
    t.after(() => f.close())
    f.provider.enqueue(
      {
        text: 'RPC checking state.',
        tool: { name: 'todo', args: {}, id: 'rpc-todo-1' },
        hold: true
      },
      { text: 'RPC state checked.' }
    )
    const result = await f.cli.connection.prompt('Check current state.')
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(f.provider.requests.length, 2)
    const messages = await history(f)
    assert.equal(
      messages.filter((entry) => entry.role === 'toolResult' && entry.toolCallId === 'rpc-todo-1')
        .length,
      1
    )
    assert.match(JSON.stringify(messages), /RPC state checked/)
  }
)

test(
  'RPC Cursor final answer step EOF succeeds without recovery',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcCursorFixture()
    t.after(() => f.close())
    f.provider.enqueue({ text: 'RPC complete answer.', hold: true, stepCompleted: true })
    const result = await f.cli.connection.prompt('Give the answer.')
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(f.provider.requests.length, 1)
    assert.equal((await history(f)).at(-1)?.stopReason, 'stop')
  }
)

test(
  'RPC Cursor explicit stop cancels the live provider without a continuation',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcCursorFixture()
    t.after(() => f.close())
    f.provider.enqueue({ text: 'RPC caller will stop.', hold: true, keepOpen: true })
    let visible!: () => void
    const seen = new Promise<void>((resolve) => {
      visible = resolve
    })
    const off = f.cli.connection.onEvent((frame) => {
      const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (event?.type === 'text_delta' && event.delta?.includes('RPC caller will stop.')) visible()
    })
    t.after(off)
    const prompt = f.cli.connection.prompt('Start a long answer.')
    await seen
    await f.cli.connection.abort()
    assert.equal((await prompt).status, 'aborted')
    assert.equal(f.provider.requests.length, 1)
    assert.equal((await history(f)).at(-1)?.stopReason, 'aborted')
    f.provider.enqueue({ text: 'RPC fresh user answer.' })
    assert.equal((await f.cli.connection.prompt('New user request.')).status, 'completed')
    assert.equal(f.provider.requests.length, 2, 'Only the explicit new user prompt invokes Cursor')
  }
)
