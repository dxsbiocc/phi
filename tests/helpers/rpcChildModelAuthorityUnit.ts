import assert from 'node:assert/strict'
import {
  createRpcChildModelHeader,
  RPC_CHILD_MODEL_HEADER,
  verifyRpcChildModelHeader
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-model-authority'
import { createRpcNativeStreamExtension } from '../../src/main/agent/engine/phi-extension/extensions/rpc-native-stream'
import {
  createNativeStreamIntegrityAdapter,
  type TrustedNativeStreamScope
} from '../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter'
import { NativeStreamIntegrityError } from '../../src/main/agent/engine/phi-extension/lib/rpc-native-sse'
import { childCapability, childScope } from './rpcChildAuthorityFixture'

type StreamFn = Parameters<typeof createNativeStreamIntegrityAdapter>[0]
type Stream = Awaited<ReturnType<StreamFn>>
type Context = Parameters<StreamFn>[1]
type Model = Parameters<StreamFn>[0]
type Extension = ReturnType<typeof createRpcNativeStreamExtension>['extension']
type ExtensionContext = Parameters<
  ReturnType<typeof createRpcNativeStreamExtension>['assertInstalled']
>[0]
const names: string[] = []
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run()
  names.push(name)
}
const endpoint = 'http://127.0.0.1:34567/v1/pi/stream'
const identity = { provider: 'fixture', id: 'one' }
const model = {
  ...identity,
  api: 'openai-completions',
  transport: 'pi-native',
  baseUrl: 'http://127.0.0.1:34567'
} as Model
const context: Context = { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }
const body = JSON.stringify({ modelId: 'fixture/one', context, options: {}, stream: true })
const message = {
  role: 'assistant',
  api: 'openai-completions',
  provider: 'fixture',
  model: 'one',
  content: [{ type: 'text', text: 'complete' }],
  stopReason: 'stop',
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
} as const
const done = { type: 'done', reason: 'stop', message } as const
const scope: TrustedNativeStreamScope = {
  generation: 1,
  endpoint,
  models: [identity],
  isActive: () => true
}
const reply = (): Response =>
  new Response(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
function originalFor(
  headers: HeadersInit = { Authorization: 'Bearer gateway-authority', 'x-sdk-header': 'preserved' },
  requestUrl = endpoint,
  attempts = 1,
  asRequest = false
): StreamFn {
  return (_model, _context, options) => {
    const iterator = (async function* () {
      for (let i = 0; i < attempts; i++) {
        const input = asRequest ? new Request(requestUrl, { method: 'POST', headers }) : requestUrl
        const response = await options!.fetch!(input, {
          method: 'POST',
          body,
          ...(asRequest ? {} : { headers })
        })
        await response.text()
      }
      yield done
    })()
    return Object.assign(iterator, {
      hasPendingLocalWork: false,
      localWorkSettledAt: 0,
      result: async () => message
    }) as unknown as Stream
  }
}
async function drain(stream: ReturnType<StreamFn>): Promise<void> {
  const actual = await stream
  for await (const event of actual) assert.equal(event.type, 'done')
  await actual.result()
}

await check(
  'each native retry rechecks child authority and preserves Authorization/body',
  async () => {
    let authorityCalls = 0
    let requests = 0
    const adapter = createNativeStreamIntegrityAdapter(originalFor(undefined, endpoint, 2), {
      ...scope,
      privateRequestHeaders: () => {
        authorityCalls++
        return { [RPC_CHILD_MODEL_HEADER]: createRpcChildModelHeader(childScope, childCapability) }
      }
    })
    await drain(
      adapter(model, context, {
        fetch: async (_input, init) => {
          requests++
          assert.equal(authorityCalls, requests)
          const headers = new Headers(init?.headers)
          assert.equal(headers.get('authorization'), 'Bearer gateway-authority')
          assert.equal(headers.get('x-sdk-header'), 'preserved')
          assert.deepEqual(
            verifyRpcChildModelHeader(headers.get(RPC_CHILD_MODEL_HEADER), childCapability),
            childScope
          )
          assert.deepEqual(JSON.parse(String(init?.body)), JSON.parse(body))
          assert.equal(init?.redirect, 'manual')
          return reply()
        }
      })
    )
    assert.equal(requests, 2)
  }
)

await check(
  'Main adds no child header and non-native never calls the private callback',
  async () => {
    const adapter = createNativeStreamIntegrityAdapter(originalFor(), scope)
    await drain(
      adapter(model, context, {
        fetch: async (_input, init) => {
          assert.equal(new Headers(init?.headers).has(RPC_CHILD_MODEL_HEADER), false)
          return reply()
        }
      })
    )
    let calls = 0
    const original: StreamFn = () => {
      calls++
      return Object.assign(
        (async function* () {
          yield done
        })(),
        { result: async () => message }
      ) as unknown as Stream
    }
    const bypass = createNativeStreamIntegrityAdapter(original, {
      ...scope,
      privateRequestHeaders: () => {
        throw new Error('must not run')
      }
    })
    await drain(bypass({ ...model, transport: undefined }, context))
    assert.equal(calls, 1)
  }
)

await check(
  'SDK reserved actor headers are rejected case-insensitively even for Main',
  async () => {
    for (const key of [RPC_CHILD_MODEL_HEADER, 'X-PHI-CHILD-MODEL']) {
      let requests = 0
      const adapter = createNativeStreamIntegrityAdapter(originalFor({ [key]: 'forged' }), scope)
      await assert.rejects(
        drain(
          adapter(model, context, {
            fetch: async () => {
              requests++
              return reply()
            }
          })
        ),
        NativeStreamIntegrityError
      )
      assert.equal(requests, 0)
    }
  }
)

await check(
  'Request input headers cannot collide and ordinary Authorization survives merging',
  async () => {
    const privateRequestHeaders = (): Readonly<Record<string, string>> => ({
      [RPC_CHILD_MODEL_HEADER]: createRpcChildModelHeader(childScope, childCapability)
    })
    const merged = createNativeStreamIntegrityAdapter(originalFor(undefined, endpoint, 1, true), {
      ...scope,
      privateRequestHeaders
    })
    await drain(
      merged(model, context, {
        fetch: async (_input, init) => {
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer gateway-authority')
          assert.ok(new Headers(init?.headers).get(RPC_CHILD_MODEL_HEADER))
          return reply()
        }
      })
    )
    const overriddenInput: StreamFn = (_model, _context, options) =>
      Object.assign(
        (async function* () {
          await options!.fetch!(
            new Request(endpoint, {
              method: 'POST',
              headers: { [RPC_CHILD_MODEL_HEADER]: 'hidden-by-init' }
            }),
            { method: 'POST', body, headers: { 'x-sdk-header': 'ordinary' } }
          )
          yield done
        })(),
        { result: async () => message }
      ) as unknown as Stream
    const overridden = createNativeStreamIntegrityAdapter(overriddenInput, scope)
    await assert.rejects(
      drain(
        overridden(model, context, {
          fetch: async () => {
            throw Error('not reached')
          }
        })
      ),
      NativeStreamIntegrityError
    )
    const collision = createNativeStreamIntegrityAdapter(
      originalFor({ [RPC_CHILD_MODEL_HEADER]: 'forged' }, endpoint, 1, true),
      {
        ...scope,
        privateRequestHeaders
      }
    )
    await assert.rejects(
      drain(
        collision(model, context, {
          fetch: async () => {
            throw Error('not reached')
          }
        })
      ),
      NativeStreamIntegrityError
    )
  }
)

await check(
  'trusted headers cannot overwrite SDK Authorization or duplicate normalized names',
  async () => {
    for (const privateRequestHeaders of [
      () => ({ Authorization: 'replacement' }),
      () => ({ 'x-private': 'one', 'X-PRIVATE': 'two' })
    ]) {
      const adapter = createNativeStreamIntegrityAdapter(originalFor(), {
        ...scope,
        privateRequestHeaders
      })
      await assert.rejects(
        drain(
          adapter(model, context, {
            fetch: async () => {
              throw Error('not reached')
            }
          })
        ),
        NativeStreamIntegrityError
      )
    }
  }
)

await check('wrong endpoint rejects before requesting actor authority or network', async () => {
  let authorityCalls = 0
  const adapter = createNativeStreamIntegrityAdapter(
    originalFor(undefined, 'http://127.0.0.1:34567/other'),
    {
      ...scope,
      privateRequestHeaders: () => {
        authorityCalls++
        return undefined
      }
    }
  )
  await assert.rejects(
    drain(
      adapter(model, context, {
        fetch: async () => {
          throw Error('not reached')
        }
      })
    ),
    NativeStreamIntegrityError
  )
  assert.equal(authorityCalls, 0)
})

type FixtureSession = { agent: { streamFn: StreamFn }; sessionManager: { getSessionId(): string } }
function fixtureExtension(
  options: {
    readonly mainActive?: () => boolean
    readonly childAllowed?: (nativeAgentId: string) => boolean
  } = {}
): {
  extension: ReturnType<typeof createRpcNativeStreamExtension>
  sessions: Map<string, FixtureSession>
  contexts: Map<string, ExtensionContext>
  active: Set<string>
  nativeStreams: Map<string, StreamFn>
  shutdown(id: string): void
} {
  const sessions = new Map<string, FixtureSession>()
  const contexts = new Map<string, ExtensionContext>()
  const active = new Set(['A', 'B'])
  const nativeStreams = new Map<string, StreamFn>()
  const gates = new Map<string, StreamFn>()
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>()
  for (const id of ['Main', 'A', 'B']) {
    const session = {
      agent: { streamFn: originalFor() },
      sessionManager: { getSessionId: () => id }
    }
    sessions.set(id, session)
    contexts.set(id, {
      agent: { id, kind: id === 'Main' ? 'main' : 'sub' },
      sessionManager: session.sessionManager
    } as unknown as ExtensionContext)
  }
  const extension = createRpcNativeStreamExtension(
    {
      ...scope,
      isActive: () => options.mainActive?.() ?? true
    },
    (ctx, expectedNativeWrapper) => {
      if (ctx.agent.id === 'Main') return undefined
      assert.ok(active.has(ctx.agent.id), 'Unknown or revoked child')
      assert.ok(options.childAllowed?.(ctx.agent.id) ?? true, 'Denied captured parent')
      assert.equal(nativeStreams.get(ctx.agent.id), expectedNativeWrapper, 'Wrong native original')
      assert.equal(
        sessions.get(ctx.agent.id)!.agent.streamFn,
        gates.get(ctx.agent.id),
        'Wrong outer gate'
      )
      const owned = {
        ...childScope,
        nativeAgentId: ctx.agent.id,
        childOmpSessionId: `${ctx.agent.id}-sdk`,
        childSessionFile: `/srv/history/root/${ctx.agent.id}.jsonl`
      }
      return { [RPC_CHILD_MODEL_HEADER]: createRpcChildModelHeader(owned, childCapability) }
    }
  )
  const api = {
    pi: {
      AgentRegistry: {
        global: () => ({
          get: (id: string) => {
            const session = sessions.get(id)
            return session ? { kind: contexts.get(id)!.agent.kind, session } : undefined
          }
        })
      }
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(event, handler)
  } as unknown as Parameters<Extension>[0]
  extension.extension(api)
  for (const ctx of contexts.values()) handlers.get('session_start')!({}, ctx)
  for (const id of ['A', 'B']) {
    const agent = sessions.get(id)!.agent
    const native = agent.streamFn
    nativeStreams.set(id, native)
    const gate: StreamFn = (...args) => native(...args)
    gates.set(id, gate)
    agent.streamFn = gate
  }
  return {
    extension,
    sessions,
    contexts,
    active,
    nativeStreams,
    shutdown: (id) => {
      handlers.get('session_shutdown')!({}, contexts.get(id)!)
    }
  }
}

await check(
  'installed child wrappers survive Main finishing and retain exact active peer identity',
  async () => {
    const f = fixtureExtension()
    try {
      f.shutdown('Main')
      // Production's exact trusted profile gate surrounds the native wrapper;
      // the callback verifies both that gate and its captured native original.
      const received: string[] = []
      await Promise.all(
        ['A', 'B'].map((id) =>
          drain(
            f.sessions.get(id)!.agent.streamFn(model, context, {
              fetch: async (_input, init) => {
                const signed = verifyRpcChildModelHeader(
                  new Headers(init?.headers).get(RPC_CHILD_MODEL_HEADER),
                  childCapability
                )
                assert.equal(signed?.nativeAgentId, id)
                received.push(id)
                return reply()
              }
            })
          )
        )
      )
      assert.deepEqual(received.sort(), ['A', 'B'])
    } finally {
      f.extension.dispose()
    }
  }
)

await check(
  'wrong outer gate or captured native original cannot obtain child model authority',
  async () => {
    for (const kind of ['outer', 'original']) {
      const f = fixtureExtension()
      try {
        const agent = f.sessions.get('A')!.agent
        const native = f.nativeStreams.get('A')!
        if (kind === 'outer') agent.streamFn = (...args) => native(...args)
        else f.nativeStreams.set('A', f.nativeStreams.get('B')!)
        await assert.rejects(
          drain(
            agent.streamFn(model, context, {
              fetch: async () => {
                throw Error('untrusted chain reached network')
              }
            })
          ),
          NativeStreamIntegrityError
        )
      } finally {
        f.extension.dispose()
      }
    }
  }
)

await check('Main cannot authorize a request through a replaced top-level wrapper', async () => {
  const f = fixtureExtension()
  try {
    const agent = f.sessions.get('Main')!.agent
    const native = agent.streamFn
    agent.streamFn = (...args) => native(...args)
    await assert.rejects(
      drain(
        agent.streamFn(model, context, {
          fetch: async () => {
            throw Error('replaced Main wrapper reached network')
          }
        })
      ),
      NativeStreamIntegrityError
    )
  } finally {
    f.extension.dispose()
  }
})

await check(
  'revoking one child fails before its next fetch while its peer remains authorized',
  async () => {
    const f = fixtureExtension()
    try {
      f.active.delete('A')
      await assert.rejects(
        drain(
          f.sessions.get('A')!.agent.streamFn(model, context, {
            fetch: async () => {
              throw Error('revoked child reached network')
            }
          })
        ),
        NativeStreamIntegrityError
      )
      let calls = 0
      await drain(
        f.sessions.get('B')!.agent.streamFn(model, context, {
          fetch: async (_input, init) => {
            calls++
            assert.equal(
              verifyRpcChildModelHeader(
                new Headers(init?.headers).get(RPC_CHILD_MODEL_HEADER),
                childCapability
              )?.nativeAgentId,
              'B'
            )
            return reply()
          }
        })
      )
      assert.equal(calls, 1)
    } finally {
      f.extension.dispose()
    }
  }
)

await check(
  'denying a new Main parent preserves its older admitted child and blocks same-parent child',
  async () => {
    let mainActive = true
    const childParents = new Map([
      ['A', 'old-parent'],
      ['B', 'new-parent']
    ])
    const deniedParents = new Set<string>()
    const f = fixtureExtension({
      mainActive: () => mainActive,
      childAllowed: (id) => !deniedParents.has(childParents.get(id)!)
    })
    try {
      deniedParents.add('new-parent')
      mainActive = false
      let requests = 0
      await drain(
        f.sessions.get('A')!.agent.streamFn(model, context, {
          fetch: async (_input, init) => {
            requests++
            assert.equal(
              verifyRpcChildModelHeader(
                new Headers(init?.headers).get(RPC_CHILD_MODEL_HEADER),
                childCapability
              )?.nativeAgentId,
              'A'
            )
            return reply()
          }
        })
      )
      assert.equal(requests, 1)
      for (const id of ['Main', 'B'])
        await assert.rejects(
          drain(
            f.sessions.get(id)!.agent.streamFn(model, context, {
              fetch: async () => {
                throw Error('Denied actor reached network')
              }
            })
          ),
          NativeStreamIntegrityError
        )
    } finally {
      f.extension.dispose()
    }
  }
)

process.stdout.write(JSON.stringify({ passed: names.length, names }))
