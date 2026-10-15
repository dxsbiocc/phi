import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import {
  acknowledgeOwnedRpcChildDelivery,
  createRpcChildControlExtension,
  createRpcChildControlScopes
} from '../src/main/agent/engine/phi-extension/extensions/rpc-child-control'
import { createRpcChildSteerPermits } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-steer-permit'
import {
  createRpcChildQueuedCancelRequest,
  createRpcChildControlAck,
  parseRpcChildControlRequest,
  parseRpcChildControlAck,
  parseRpcChildSteerRequest,
  RPC_CHILD_CONTROL_COMMAND
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-control'
import type { RpcChildScope } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'

type AgentSession = Parameters<typeof acknowledgeOwnedRpcChildDelivery>[0]
type ExtensionContext = Parameters<typeof acknowledgeOwnedRpcChildDelivery>[1]
type Factory = ReturnType<typeof createRpcChildControlExtension>
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Production signed handler with explicit SDK doubles; actual CLI acceptance is separate. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve the narrow mutable SDK-double types used by the race cases.
async function fixture() {
  const cwd = realpathSync(tmpdir())
  const base = productionChildOptions()
  const { config } = await createProductionChildConfig({
    ...base,
    identity: { ...base.identity, projectRoot: cwd },
    binding: { ...base.binding, projectRoot: cwd }
  })
  const root = {
    phiSessionId: config.phiSessionId,
    projectId: config.projectId,
    cwd,
    generation: config.generation,
    rootAgentId: 'Main',
    rootOmpSessionId: 'root-sdk',
    rootSessionFile: '/history/root.jsonl'
  }
  const scope: RpcChildScope = {
    ...root,
    nativeAgentId: 'owned',
    childOmpSessionId: 'child-sdk',
    childSessionFile: '/history/root/child.jsonl',
    parentSession: root.rootSessionFile,
    nativeName: config.profiles[0].definition.nativeName,
    definitionHash: config.profiles[0].definition.definitionHash
  }
  const state = {
    owned: true,
    profile: true,
    sameRegistry: true,
    parked: false,
    released: true,
    releaseCount: 0,
    abortCount: 0,
    abortReason: '',
    releaseError: undefined as Error | undefined,
    abortError: undefined as Error | undefined,
    releaseGate: undefined as Promise<void> | undefined,
    abortGate: undefined as Promise<void> | undefined
  }
  const controller = new AbortController()
  const acks: string[] = []
  const parent = {
    sessionId: root.rootOmpSessionId,
    sessionFile: root.rootSessionFile,
    sessionManager: { getSessionId: () => root.rootOmpSessionId }
  }
  const session = {
    sessionId: scope.childOmpSessionId,
    sessionFile: scope.childSessionFile,
    isStreaming: true,
    agent: { state: { isStreaming: true } },
    sessionManager: {
      getSessionId: () => scope.childOmpSessionId,
      getHeader: () => ({ parentSession: root.rootSessionFile }),
      getCwd: () => cwd
    },
    abort: async (options: { reason: string }): Promise<void> => {
      state.abortCount++
      state.abortReason = options.reason
      await state.abortGate
      if (state.abortError) throw state.abortError
      session.isStreaming = false
      session.agent.state.isStreaming = false
    }
  }
  const child: {
    id: string
    kind: string
    parentId: string
    status: string
    sessionFile: string
    session: typeof session | null
  } = {
    id: scope.nativeAgentId,
    kind: 'sub',
    parentId: root.rootAgentId,
    status: 'idle',
    sessionFile: scope.childSessionFile,
    session
  }
  const parentRef = { kind: 'main', session: parent }
  const peer = { id: 'peer', status: 'running', session: { isStreaming: true } }
  const refs = new Map<string, unknown>([
    [root.rootAgentId, parentRef],
    [child.id, child],
    ['peer', peer]
  ])
  const registry = { get: (id: string) => refs.get(id) }
  const ctx = {
    agent: { id: root.rootAgentId, kind: 'main' },
    cwd,
    sessionManager: parent.sessionManager,
    ui: { notify: (message: string) => acks.push(message) }
  } as unknown as ExtensionContext
  let handler!: (args: string, context: ExtensionContext) => Promise<void>
  const api = {
    pi: { AgentRegistry: { global: () => registry }, USER_INTERRUPT_LABEL: 'unit-interrupt' },
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      assert.equal(name, RPC_CHILD_CONTROL_COMMAND)
      handler = command.handler
    }
  } as unknown as Parameters<Factory>[0]
  const lifecycle = {
    manages: (candidate: unknown) => state.sameRegistry && candidate === registry,
    isParking: () => state.parked,
    release: async (id: string, ref: unknown, options: { tombstone?: boolean }) => {
      assert.equal(id, child.id)
      assert.equal(ref, child)
      assert.equal(options.tombstone, true)
      state.releaseCount++
      await state.releaseGate
      if (state.releaseError) throw state.releaseError
      if (state.released && refs.get(id) === child) {
        child.status = 'aborted'
        child.session = null
      }
      return state.released
    }
  }
  const permits = createRpcChildSteerPermits()
  const scopes = createRpcChildControlScopes()
  // A Sub factory owns this callback; the Main command never consults its own local map.
  scopes.publish(session as unknown as AgentSession, () => (state.profile ? scope : undefined))
  createRpcChildControlExtension({
    config,
    root: () => root,
    signal: controller.signal,
    assertPublication: () => {},
    steerPermits: permits,
    queuedCancellation: {
      lifecycle: lifecycle as unknown as NonNullable<
        Parameters<typeof createRpcChildControlExtension>[0]['queuedCancellation']
      >['lifecycle'],
      owns: (agent) => state.owned && agent === session.agent,
      verify: scopes.verify
    }
  })(api)
  const request = createRpcChildQueuedCancelRequest(config, scope, 1)
  return {
    config,
    scope,
    root,
    request,
    state,
    controller,
    session,
    child,
    peer,
    refs,
    parentRef,
    permits,
    acks,
    call: () => handler(JSON.stringify(request), ctx)
  }
}

test('queued cancellation signatures bind a distinct action, exact scope and fixed purpose', async () => {
  const f = await fixture()
  assert.deepEqual(parseRpcChildControlRequest(JSON.stringify(f.request), f.config), f.request)
  assert.throws(() => parseRpcChildSteerRequest(JSON.stringify(f.request), f.config))
  const ack = createRpcChildControlAck(f.request, f.config)
  assert.equal(parseRpcChildControlAck(JSON.stringify(ack), f.request, f.config)?.accepted, true)
  for (const patch of [
    { action: 'steer' },
    { message: 'cancel any child' },
    { sequence: 2 },
    { scope: { ...f.scope, nativeAgentId: 'peer' } },
    { extra: true }
  ]) {
    assert.throws(() =>
      parseRpcChildControlRequest(JSON.stringify({ ...f.request, ...patch }), f.config)
    )
  }
  assert.equal(
    parseRpcChildControlAck(JSON.stringify({ ...ack, action: 'steer' }), f.request, f.config),
    undefined
  )
  assert.equal(JSON.stringify(ack).includes(f.config.capability), false)
})

test('separate factory scope maps use the Sub owner query and preserve exact-session invalidation', async () => {
  const f = await fixture()
  const shared = createRpcChildControlScopes()
  const factory = (): {
    local: Map<AgentSession, RpcChildScope>
    publish(session: AgentSession, scope: RpcChildScope): () => void
  } => {
    const local = new Map<AgentSession, RpcChildScope>()
    return {
      local,
      publish: (session, scope) => {
        local.set(session, scope)
        return shared.publish(session, () => local.get(session))
      }
    }
  }
  const main = factory()
  const sub = factory()
  const session = f.session as unknown as AgentSession
  assert.equal(main.local.get(session), undefined)
  assert.equal(shared.verify(f.scope, session), false)
  const staleRevoke = sub.publish(session, f.scope)
  assert.equal(main.local.get(session), undefined)
  assert.equal(shared.verify(f.scope, session), true)
  assert.equal(shared.verify(f.scope, { ...session } as AgentSession), false)
  assert.equal(shared.verify({ ...f.scope, definitionHash: 'a'.repeat(64) }, session), false)
  sub.local.delete(session)
  assert.equal(shared.verify(f.scope, session), false)
  const revoke = sub.publish(session, f.scope)
  staleRevoke()
  assert.equal(shared.verify(f.scope, session), true)
  revoke()
  assert.equal(shared.verify(f.scope, session), false)
})

test('owned idle streaming continuation joins exact public release and abort before acknowledging', async () => {
  const f = await fixture()
  const gate = deferred()
  f.state.abortGate = gate.promise
  f.permits.grant(f.session as unknown as AgentSession, f.scope, 'pending', 'old steer')
  const pending = f.call()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.state.releaseCount, 1)
  assert.equal(f.state.abortCount, 1)
  assert.equal(f.acks.length, 0)
  assert.equal(f.permits.hasPending(f.session as unknown as AgentSession), false)
  gate.resolve()
  await pending
  assert.equal(f.state.abortReason, 'unit-interrupt')
  assert.equal(f.child.status, 'aborted')
  assert.equal(f.child.session, null)
  assert.equal(parseRpcChildControlAck(f.acks[0], f.request, f.config)?.accepted, true)
  assert.deepEqual(f.peer, { id: 'peer', status: 'running', session: { isStreaming: true } })
  await assert.rejects(f.call(), /replay/)
})

test('ordinary idle, foreign proof, parking and replaced bindings cannot invoke queued cancellation', async () => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      f.state.owned = false
    },
    (f) => {
      f.state.profile = false
    },
    (f) => {
      f.state.sameRegistry = false
    },
    (f) => {
      f.state.parked = true
    },
    (f) => {
      f.session.agent.state.isStreaming = false
    },
    (f) => {
      f.session.isStreaming = false
    },
    (f) => {
      f.child.status = 'running'
    },
    (f) => {
      f.child.sessionFile = '/history/replaced.jsonl'
    },
    (f) => {
      f.refs.set(f.child.id, { ...f.child, session: { ...f.session } })
    },
    (f) => {
      f.session.sessionManager.getCwd = () => '/'
    }
  ]
  for (const mutate of mutations) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(f.call())
    assert.equal(f.state.releaseCount, 0)
    assert.equal(f.state.abortCount, 0)
    assert.equal(f.acks.length, 0)
  }
})

test('false release, either SDK rejection, replaced ref or retired generation never acknowledges success', async () => {
  for (const kind of [
    'false',
    'release-error',
    'abort-error',
    'replace',
    'retire',
    'root'
  ] as const) {
    const f = await fixture()
    const error = new Error(kind)
    const gate = deferred()
    f.state.releaseGate = gate.promise
    if (kind === 'false') f.state.released = false
    if (kind === 'release-error') f.state.releaseError = error
    if (kind === 'abort-error') f.state.abortError = error
    const pending = f.call()
    // Install the rejection observer before releasing either SDK promise.
    const rejected = assert.rejects(pending, (cause) => {
      if (kind.endsWith('-error')) assert.equal(cause, error)
      return true
    })
    if (kind === 'replace') f.refs.set(f.child.id, f.peer)
    if (kind === 'retire') f.controller.abort(error)
    if (kind === 'root') f.refs.set(f.scope.rootAgentId, { ...f.parentRef })
    gate.resolve()
    await rejected
    assert.equal(f.state.releaseCount, 1)
    assert.equal(f.state.abortCount, 1)
    assert.equal(f.acks.length, 0)
    assert.equal(f.peer.status, 'running')
    assert.equal(f.peer.session.isStreaming, true)
  }
})
