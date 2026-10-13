import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { RpcByteLimitError, RpcRequestError } from '../src/main/agent/engine/rpc/errors'
import {
  readRemoteHistory,
  withRemoteSignal,
  type RemoteHistoryCheckpoint
} from '../src/main/agent/engine/rpc/history-pager'
import { createInitializationWire } from './helpers/rpc-initialization-wire'

const base = {
  phiSessionId: 'phi-1',
  ompSessionId: 'omp-1',
  journalPath: '/remote/journal.jsonl',
  projectRoot: '/remote/project',
  generation: 1,
  leafId: 'leaf-1',
  messageCount: 3
} as const
function cursor(offset: number, patch: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      sessionId: base.ompSessionId,
      leafId: base.leafId,
      messageCount: base.messageCount,
      offset,
      ...patch
    })
  ).toString('base64url')
}
async function fixture(
  pages: unknown[],
  checkpoint: RemoteHistoryCheckpoint = base
): Promise<{
  connection: RpcConnection
  options: Parameters<typeof readRemoteHistory>[0]
  requests: string[]
}> {
  const wire = createInitializationWire((command, respond) => {
    if (command.type !== 'get_messages_page') return false
    respond(pages.shift())
    return true
  })
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  return {
    connection,
    requests: wire.commands.map((command) => command.type),
    options: {
      connection,
      control: connection.bindControl(),
      checkpoint,
      signal: new AbortController().signal,
      readCheckpoint: async () => checkpoint
    }
  }
}

test('official paging preserves Unicode, image, thinking and tool result payloads', async () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '思考🙂' },
        { type: 'toolCall', id: 't', arguments: { x: 1 } }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 't',
      content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }]
    },
    { role: 'user', content: [{ type: 'text', text: '你好🌱' }] }
  ]
  const f = await fixture([
    { messages: messages.slice(0, 2), nextCursor: cursor(2), totalMessages: 3 },
    { messages: messages.slice(2), totalMessages: 3 }
  ])
  try {
    assert.deepEqual(await readRemoteHistory(f.options), messages)
  } finally {
    await f.connection.close()
  }
})

for (const [name, pages, code] of [
  [
    'repeated cursor',
    [
      { messages: [{ role: 'user' }], totalMessages: 3, nextCursor: cursor(1) },
      { messages: [{ role: 'user' }], totalMessages: 3, nextCursor: cursor(1) }
    ],
    'HISTORY_INVALID'
  ],
  [
    'nonadvancing offset',
    [{ messages: [{ role: 'user' }], totalMessages: 3, nextCursor: cursor(2) }],
    'HISTORY_INVALID'
  ],
  [
    'different session',
    [
      {
        messages: [{ role: 'user' }],
        totalMessages: 3,
        nextCursor: cursor(1, { sessionId: 'other' })
      }
    ],
    'HISTORY_CHANGED'
  ],
  [
    'different leaf',
    [
      { messages: [{ role: 'user' }], totalMessages: 3, nextCursor: cursor(1, { leafId: 'other' }) }
    ],
    'HISTORY_CHANGED'
  ],
  ['different total', [{ messages: [], totalMessages: 2 }], 'HISTORY_INVALID'],
  ['early end', [{ messages: [{ role: 'user' }], totalMessages: 3 }], 'HISTORY_INVALID'],
  [
    'empty continuation',
    [{ messages: [], totalMessages: 3, nextCursor: cursor(1) }],
    'HISTORY_INVALID'
  ],
  [
    'bad encoding',
    [{ messages: [{ role: 'user' }], totalMessages: 3, nextCursor: '%%%' }],
    'HISTORY_INVALID'
  ]
] as const) {
  test(`paging rejects ${name}`, async () => {
    const f = await fixture([...pages])
    try {
      await assert.rejects(readRemoteHistory(f.options), { code })
    } finally {
      await f.connection.close()
    }
  })
}

test('paging discards all partial pages if final checkpoint changed', async () => {
  const f = await fixture([
    { messages: [{ role: 'user' }, { role: 'user' }, { role: 'user' }], totalMessages: 3 }
  ])
  let reads = 0
  try {
    await assert.rejects(
      readRemoteHistory({
        ...f.options,
        readCheckpoint: async () => (++reads === 1 ? base : { ...base, leafId: 'new-leaf' })
      }),
      { code: 'HISTORY_CHANGED' }
    )
  } finally {
    await f.connection.close()
  }
})

test('paging refuses a revoked generation before sending history requests', async () => {
  const f = await fixture([])
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(readRemoteHistory({ ...f.options, signal: controller.signal }), {
      code: 'GENERATION_REVOKED'
    })
  } finally {
    await f.connection.close()
  }
})

test('single message above1MiB is preserved; configured aggregate limit fails explicitly', async () => {
  const message = { role: 'user', content: [{ type: 'text', text: '中文🙂'.repeat(200000) }] }
  const checkpoint = { ...base, messageCount: 1 }
  // A synthetic response directly tests aggregate policy; real chunk codec is covered in recovery CLI.
  const connection = {
    bindControl: () => ({ generation: 1 }),
    request: async () => ({ messages: [message], totalMessages: 1 })
  }
  const options = {
    connection: connection as unknown as Pick<RpcConnection, 'request' | 'bindControl'>,
    control: {
      generation: 1,
      signal: new AbortController().signal,
      sendControl: async () => undefined,
      onFrame: () => () => undefined
    },
    checkpoint,
    signal: new AbortController().signal,
    readCheckpoint: async () => checkpoint
  }
  assert.deepEqual(await readRemoteHistory(options), [message])
  await assert.rejects(readRemoteHistory({ ...options, maxBytes: 1024 }), { code: 'HISTORY_LIMIT' })
})

test('single message above64MiB never produces truncated success', async () => {
  const checkpoint = { ...base, messageCount: 1 }
  const connection = {
    bindControl: () => ({ generation: 1 }),
    request: async () => ({
      messages: [{ role: 'user', content: 'a'.repeat(64 * 1024 * 1024) }],
      totalMessages: 1
    })
  }
  const f = await fixture([], checkpoint)
  try {
    await assert.rejects(
      readRemoteHistory({
        ...f.options,
        connection: connection as unknown as Pick<RpcConnection, 'request' | 'bindControl'>
      }),
      { code: 'HISTORY_LIMIT' }
    )
  } finally {
    await f.connection.close()
  }
})

for (const delayed of [false, true]) {
  test(`synchronous capability cancellation observes ${delayed ? 'late' : 'immediate'} rejection in a strict child`, async () => {
    const helper = new URL('../src/main/agent/engine/rpc/history-pager.ts', import.meta.url).href
    const script = `
      import assert from 'node:assert/strict';
      import { withRemoteSignal } from ${JSON.stringify(helper)};
      const controller = new AbortController();
      const reason = new Error('original cancellation reason');
      const capability = () => {
        controller.abort(reason);
        return ${delayed ? "new Promise((_, reject) => setTimeout(() => reject(new Error('late operation rejection')), 5))" : "Promise.reject(new Error('immediate operation rejection'))"};
      };
      await assert.rejects(withRemoteSignal(capability(), controller.signal), error => error === reason);
      await new Promise(resolve => setTimeout(resolve, 30));
      console.log('cancelled-with-original-reason');
    `
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        fileURLToPath(new URL('../scripts/test-loader.mjs', import.meta.url)),
        '--input-type=module',
        '-e',
        script
      ],
      { timeout: 5000, maxBuffer: 16384 }
    )
    assert.equal(child.stdout.trim(), 'cancelled-with-original-reason')
    assert.equal(child.stderr, '')
  })
}

test('signal helper preserves normal operation rejection and never treats cancellation as success', async () => {
  const active = new AbortController()
  const error = new Error('ordinary operation error')
  await assert.rejects(
    withRemoteSignal(Promise.reject(error), active.signal),
    (cause) => cause === error
  )
  for (const reason of [error, null, 0, '']) {
    const cancelled = new AbortController()
    cancelled.abort(reason)
    await assert.rejects(
      withRemoteSignal(Promise.resolve('not a success'), cancelled.signal),
      (cause) => cause === reason
    )
  }
})

test('empty history still requires the two JSON array bytes', async () => {
  const checkpoint = { ...base, messageCount: 0, leafId: null }
  const f = await fixture([{ messages: [], totalMessages: 0 }], checkpoint)
  try {
    await assert.rejects(readRemoteHistory({ ...f.options, maxBytes: 1 }), {
      code: 'HISTORY_LIMIT'
    })
    assert.deepEqual(await readRemoteHistory({ ...f.options, maxBytes: 2 }), [])
  } finally {
    await f.connection.close()
  }
})

for (const scope of ['reassembled-frame', 'physical-frame', 'command-frame'] as const) {
  test(`history byte classification respects ${scope}`, async () => {
    const error = new RpcByteLimitError('RPC frame exceeds the frame limit', scope, 1024, 1025)
    const f = await fixture([])
    try {
      const pending = readRemoteHistory({
        ...f.options,
        readCheckpoint: async () => {
          throw error
        }
      })
      if (scope === 'reassembled-frame') await assert.rejects(pending, { code: 'HISTORY_LIMIT' })
      else await assert.rejects(pending, (cause) => cause === error)
    } finally {
      await f.connection.close()
    }
  })
}

for (const [code, expected] of [
  ['stale_cursor', 'HISTORY_CHANGED'],
  ['session_busy', 'SESSION_BUSY']
] as const) {
  test(`history classifies official ${code} independently of display text`, async () => {
    const error = new RpcRequestError({
      id: 'request-1',
      command: 'get_messages_page',
      error: 'opaque display text',
      code
    })
    const f = await fixture([])
    try {
      await assert.rejects(
        readRemoteHistory({
          ...f.options,
          readCheckpoint: async () => {
            throw error
          }
        }),
        { code: expected }
      )
    } finally {
      await f.connection.close()
    }
  })
}

test('malformed chunk errors and unknown official codes stay explicit protocol/request failures', async () => {
  const f = await fixture([])
  try {
    for (const error of [
      new Error('Invalid RPC chunk metadata'),
      new RpcRequestError({
        id: 'request-2',
        command: 'get_messages_page',
        error: 'RPC message cursor is stale',
        code: 'future_reason'
      })
    ])
      await assert.rejects(
        readRemoteHistory({
          ...f.options,
          readCheckpoint: async () => {
            throw error
          }
        }),
        (cause) => cause === error
      )
  } finally {
    await f.connection.close()
  }
})
