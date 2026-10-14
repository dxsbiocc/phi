import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createApprovalEnvelope,
  parseApprovalEnvelope,
  MAX_RPC_APPROVAL_BYTES
} from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import {
  RpcApprovalBridge,
  type RpcApprovalDecision,
  type RpcApprovalEvent
} from '../src/main/agent/engine/rpc/approval-bridge'
import { approvalIdentity, approvalWire, deferred, until } from './helpers/rpcApprovalFixture'

test('approval envelope binds strict identity and canonical complete effective input', () => {
  const a = createApprovalEnvelope(approvalIdentity, 'call', 'write', {
    path: 'one',
    content: '中文',
    nested: { z: 1, a: true }
  })
  const b = createApprovalEnvelope(approvalIdentity, 'call', 'write', {
    nested: { a: true, z: 1 },
    content: '中文',
    path: 'one'
  })
  assert.equal(a.inputDigest, b.inputDigest)
  const nativeEdit = {
    path: 'one',
    old_string: 'before',
    new_string: 'after',
    [Symbol('edit.inspection')]: { mode: 'replace' }
  }
  assert.deepEqual(
    createApprovalEnvelope(approvalIdentity, 'edit-call', 'edit', nativeEdit).input,
    { path: 'one', old_string: 'before', new_string: 'after' }
  )
  const array: unknown[] = ['valid']
  Object.defineProperty(array, '0', {
    get() {
      throw new Error('array getter must not run')
    }
  })
  assert.throws(
    () => createApprovalEnvelope(approvalIdentity, 'call', 'write', { array }),
    /accessors/u
  )
  assert.ok(Object.isFrozen(a.input.nested))
  assert.deepEqual(parseApprovalEnvelope(JSON.stringify(a)), a)
  for (const change of [{ content: 'changed' }, { path: 'changed' }])
    assert.equal(
      parseApprovalEnvelope(JSON.stringify({ ...a, input: { ...a.input, ...change } })),
      undefined
    )
  for (const bad of [
    { ...a, extra: 1 },
    { ...a, type: 'confirm' },
    { ...a, protocolVersion: 2 },
    { ...a, input: [] },
    { ...a, input: 'not a record' },
    { ...a, runId: 'other' },
    { ...a, inputDigest: 'a'.repeat(64) }
  ])
    assert.equal(parseApprovalEnvelope(JSON.stringify(bad)), undefined)
  for (const input of [
    { x: NaN },
    { x: undefined },
    JSON.parse('{"__proto__":1}'),
    { x: 'a'.repeat(MAX_RPC_APPROVAL_BYTES) }
  ])
    assert.throws(() => createApprovalEnvelope(approvalIdentity, 'call', 'write', input))
  assert.throws(() =>
    createApprovalEnvelope(approvalIdentity, 'call', 'write', {
      get x() {
        throw new Error('getter must not run')
      }
    })
  )
})

test('approved/denied decisions reuse UI request identity and emit exactly one terminal event', async (t) => {
  for (const decision of ['approved', 'denied', 'cancelled'] as const) {
    const events: RpcApprovalEvent[] = []
    const f = await approvalWire({
      requestToolApproval: (request) => {
        assert.equal(request.sessionId, approvalIdentity.phiSessionId)
        assert.equal(request.runId, approvalIdentity.runId)
        assert.equal(request.cwd, approvalIdentity.cwd)
        assert.equal(request.toolName, 'write')
        assert.match(request.approvalDigest!, /^[a-f0-9]{64}$/u)
        return decision
      },
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => f.close())
    f.emit(decision)
    await until(() => f.responses().length === 1)
    assert.deepEqual(
      f.responses()[0],
      decision === 'cancelled'
        ? { type: 'extension_ui_response', id: decision, cancelled: true }
        : { type: 'extension_ui_response', id: decision, confirmed: decision === 'approved' }
    )
    assert.deepEqual(
      events.map((e) => e.type),
      ['approval_requested', `approval_${decision}`]
    )
    assert.equal(events[0].approvalId, events[1].approvalId)
    assert.equal(events[0].toolCallId, `call-${decision}`)
  }
})

test('live ask/auto policy is read for future calls and auto does not create a human waiter', async (t) => {
  let gate = true
  let waits = 0
  const f = await approvalWire({
    shouldGate: () => gate,
    requestToolApproval: () => {
      waits++
      return 'approved'
    }
  })
  t.after(() => f.close())
  f.emit('ask')
  await until(() => f.responses().length === 1)
  gate = false
  f.emit('auto')
  await until(() => f.responses().length === 2)
  gate = true
  f.emit('ask-again')
  await until(() => f.responses().length === 3)
  assert.equal(waits, 2)
  assert.ok(f.responses().every((r) => r.confirmed === true))
})

for (const reason of ['stop', 'dispose', 'window', 'server', 'disconnect'] as const)
  test(`${reason} cancels once, ignores late/double answers and aborts the UI signal`, async (t) => {
    const answer = deferred<RpcApprovalDecision>()
    const events: RpcApprovalEvent[] = []
    const window = new AbortController()
    let uiSignal: AbortSignal | undefined
    const f = await approvalWire({
      signal: window.signal,
      requestToolApproval: (_, signal) => {
        uiSignal = signal
        return answer.promise
      },
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => f.close())
    f.emit(reason)
    await until(() => events.length === 1)
    if (reason === 'stop') f.runController.abort()
    if (reason === 'dispose') f.bridge.dispose()
    if (reason === 'window') window.abort()
    if (reason === 'server')
      f.wire.emit({
        type: 'extension_ui_request',
        method: 'cancel',
        id: 'cancel-frame',
        targetId: reason
      })
    if (reason === 'disconnect') f.wire.disconnect()
    await until(() => events.length === 2)
    answer.resolve('approved')
    f.emit(reason)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(uiSignal?.aborted, true)
    assert.deepEqual(
      events.map((e) => e.type),
      ['approval_requested', 'approval_cancelled']
    )
    assert.equal(f.responses().length, reason === 'server' || reason === 'disconnect' ? 0 : 1)
    assert.ok(f.responses().every((r) => r.cancelled === true))
  })

test('generic UI, cross-session/generation/run/digest and unsupported tools cannot gain approval', async (t) => {
  let waits = 0
  const f = await approvalWire({
    requestToolApproval: () => {
      waits++
      return 'approved'
    }
  })
  t.after(() => f.close())
  const bad = [
    { method: 'input' },
    { method: 'select' },
    { title: 'Trust this?' },
    { timeout: 10000 },
    ...[
      'nonce',
      'phiSessionId',
      'ompSessionId',
      'projectId',
      'cwd',
      'generation',
      'runId',
      'toolName',
      'inputDigest'
    ].map((key) => {
      const identity = {
        ...approvalIdentity,
        ...(key === 'generation' ? { generation: 2 } : {}),
        ...(key === 'nonce' ? { nonce: 'fedcba9876543210' } : {}),
        ...(key === 'phiSessionId' ? { phiSessionId: 'foreign-phi' } : {}),
        ...(key === 'ompSessionId' ? { ompSessionId: 'foreign-omp' } : {}),
        ...(key === 'projectId' ? { projectId: 'foreign-project' } : {}),
        ...(key === 'cwd' ? { cwd: '/foreign-project' } : {}),
        ...(key === 'runId' ? { runId: 'foreign-run' } : {})
      }
      const env = createApprovalEnvelope(
        identity,
        `bad-${key}`,
        key === 'toolName' ? 'foreign' : 'write',
        {
          path: 'one',
          content: 'ok'
        }
      )
      return {
        message: JSON.stringify(
          key === 'inputDigest' ? { ...env, inputDigest: 'a'.repeat(64) } : env
        )
      }
    })
  ]
  bad.forEach((change, i) => f.emit(`bad-${i}`, change))
  await until(() => f.responses().length === bad.length)
  assert.equal(waits, 0)
  assert.ok(f.responses().every((r) => r.cancelled === true))
  f.emit('notify', { method: 'notify' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.responses().length, bad.length)
})

test('child/missing main-call authority is denied before UI and valid envelope replay is ignored', async (t) => {
  const f = await approvalWire({
    requestToolApproval: () => {
      throw new Error('must not reach UI')
    }
  })
  t.after(() => f.close())
  f.setRun({
    id: approvalIdentity.runId,
    signal: new AbortController().signal,
    authorizeCall: () => 'child'
  })
  f.emit('child')
  await until(() => f.responses().length === 1)
  assert.equal(f.responses()[0].confirmed, false)
  f.emit('child')
  f.setRun(undefined)
  f.emit('missing')
  await until(() => f.responses().length === 2)
  assert.equal(f.responses()[1].cancelled, true)
})

test('input authority and active-run replacement during a wait deny late approval', async (t) => {
  const answer = deferred<RpcApprovalDecision>()
  let received = false
  let main = true
  const f = await approvalWire({
    requestToolApproval: () => {
      received = true
      return answer.promise
    }
  })
  t.after(() => f.close())
  const run = {
    id: approvalIdentity.runId,
    signal: new AbortController().signal,
    authorizeCall: () => (main ? ('main' as const) : undefined)
  }
  f.setRun(run)
  f.emit('changed-input')
  await until(() => received)
  main = false
  answer.resolve('approved')
  await until(() => f.responses().length === 1)
  assert.equal(f.responses()[0].confirmed, false)
  const wait = deferred<RpcApprovalDecision>()
  const g = await approvalWire({ requestToolApproval: () => wait.promise })
  t.after(() => g.close())
  g.emit('run-swap')
  await new Promise((resolve) => setTimeout(resolve, 10))
  g.setRun({ ...run })
  wait.resolve('approved')
  await until(() => g.responses().length === 1)
  assert.equal(g.responses()[0].cancelled, true)
})

test('observer reentrant disposal and async/rejected callbacks cannot cause approval or unhandled errors', async (t) => {
  let waits = 0
  const f = await approvalWire({
    requestToolApproval: () => {
      waits++
      return 'approved'
    },
    onEvent: async () => {
      f.bridge.dispose()
      throw new Error('observer failed')
    },
    onError: () => {}
  })
  t.after(() => f.close())
  f.emit('reentrant')
  await until(() => f.responses().length === 1)
  assert.equal(waits, 0)
  assert.equal(f.responses()[0].cancelled, true)
  const g = await approvalWire({
    requestToolApproval: async () => {
      throw new Error('UI failed')
    }
  })
  t.after(() => g.close())
  g.emit('reject')
  await until(() => g.responses().length === 1)
  assert.equal(g.responses()[0].confirmed, false)
})

test('a second bridge cannot bind the same live generation', async (t) => {
  const f = await approvalWire()
  t.after(() => f.close())
  assert.throws(
    () =>
      new RpcApprovalBridge({
        connection: f.connection,
        scope: { ...approvalIdentity, currentRun: () => undefined },
        shouldGate: () => false,
        requestToolApproval: () => 'approved'
      }),
    /already bound/u
  )
})

test('duplicate tool-call envelopes cannot settle an existing waiter under another wire id', async (t) => {
  const answer = deferred<RpcApprovalDecision>()
  let waits = 0
  const f = await approvalWire({
    requestToolApproval: () => {
      waits++
      return answer.promise
    }
  })
  t.after(() => f.close())
  f.emit('original')
  await until(() => waits === 1)
  f.emit('duplicate', {
    message: JSON.stringify(
      createApprovalEnvelope(approvalIdentity, 'call-original', 'write', {
        path: 'note.txt',
        content: 'approved text'
      })
    )
  })
  await until(() => f.responses().length === 1)
  assert.equal(f.responses()[0].id, 'duplicate')
  assert.equal(f.responses()[0].cancelled, true)
  answer.resolve('approved')
  await until(() => f.responses().length === 2)
  assert.equal(f.responses()[1].id, 'original')
  assert.equal(f.responses()[1].confirmed, true)
  assert.equal(waits, 1)
})

test('stop retires pending authority work and observes a late rejection without UI', async (t) => {
  const authority = deferred<'main'>()
  let invoked = false
  let waits = 0
  const f = await approvalWire({
    requestToolApproval: () => {
      waits++
      return 'approved'
    }
  })
  t.after(() => f.close())
  f.setRun({
    id: approvalIdentity.runId,
    signal: f.runController.signal,
    authorizeCall: () => {
      invoked = true
      return authority.promise
    }
  })
  f.emit('pending-authority')
  await until(() => invoked)
  f.runController.abort()
  await until(() => f.responses().length === 1)
  authority.reject(new Error('late authorization rejection'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(waits, 0)
  assert.equal(f.responses()[0].cancelled, true)
})

test('failed live scope or project policy releases the remote dialog without allowing effects', async (t) => {
  const f = await approvalWire({
    requestToolApproval: () => {
      throw new Error('UI must not be entered')
    }
  })
  t.after(() => f.close())
  f.setRun({
    id: approvalIdentity.runId,
    get signal(): AbortSignal {
      throw new Error('run state unavailable')
    },
    authorizeCall: () => 'main'
  })
  f.emit('broken-scope')
  await until(() => f.responses().length === 1)
  assert.equal(f.responses()[0].cancelled, true)
  const g = await approvalWire({
    shouldGate: () => {
      throw new Error('policy unavailable')
    },
    requestToolApproval: () => {
      throw new Error('UI must not be entered')
    }
  })
  t.after(() => g.close())
  g.emit('broken-policy')
  await until(() => g.responses().length === 1)
  assert.equal(g.responses()[0].confirmed, false)
})

for (const retirement of ['dispose', 'abort', 'replace-run'] as const)
  test(`terminal observer ${retirement} runs after response commit and cannot write an allow after retirement`, async (t) => {
    let terminal = 0
    let responseCommittedAtTerminal = false
    const f = await approvalWire({
      onEvent: (event) => {
        if (event.type !== 'approval_approved') return
        terminal++
        responseCommittedAtTerminal = f
          .responses()
          .some((response) => response.id === retirement && response.confirmed === true)
        if (retirement === 'dispose') f.bridge.dispose()
        if (retirement === 'abort') f.runController.abort()
        if (retirement === 'replace-run')
          f.setRun({
            id: 'replacement',
            signal: new AbortController().signal,
            authorizeCall: () => 'main'
          })
      }
    })
    t.after(() => f.close())
    f.emit(retirement)
    await until(() => terminal === 1 && f.responses().length === 1)
    assert.equal(
      responseCommittedAtTerminal,
      true,
      'terminal notification must follow the linearized control response'
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(terminal, 1)
    assert.equal(f.responses().length, 1)
  })

test(
  'dialog replay capacity cancels its triggering and all future requests without growing replay state',
  { timeout: 30000 },
  async (t) => {
    const answer = deferred<RpcApprovalDecision>()
    const events: RpcApprovalEvent[] = []
    const f = await approvalWire({
      requestToolApproval: () => answer.promise,
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => f.close())
    f.emit('capacity-pending')
    await until(() => events.length === 1)
    for (let index = 0; index < 9999; index++)
      f.emit(`capacity-${index}`, { title: 'untrusted dialog' })
    await until(() => f.responses().length === 9999)
    f.emit('capacity-trigger', { title: 'untrusted dialog' })
    await until(() => f.responses().length === 10001)
    answer.resolve('approved')
    f.emit('capacity-next', { title: 'untrusted dialog' })
    await until(() => f.responses().length === 10002)
    assert.ok(f.responses().every((response) => response.cancelled === true))
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_cancelled']
    )
  }
)

test('provider toolCallId can be reused by a new trusted run while same-run and stale envelopes remain rejected', async (t) => {
  let waits = 0
  const f = await approvalWire({
    requestToolApproval: () => {
      waits++
      return 'approved'
    }
  })
  t.after(() => f.close())
  for (const runId of ['run-1', 'run-2']) {
    f.setRun(
      Object.freeze({
        id: runId,
        signal: new AbortController().signal,
        authorizeCall: () => 'main'
      })
    )
    f.emit(runId, {
      message: JSON.stringify(
        createApprovalEnvelope({ ...approvalIdentity, runId }, 'provider-reused-id', 'write', {
          path: 'file.txt',
          content: runId
        })
      )
    })
    await until(() => f.responses().length === (runId === 'run-1' ? 1 : 2))
    assert.equal(f.responses().at(-1)?.confirmed, true)
  }
  f.emit('same-run-replay', {
    message: JSON.stringify(
      createApprovalEnvelope(
        { ...approvalIdentity, runId: 'run-2' },
        'provider-reused-id',
        'write',
        { path: 'file.txt', content: 'run-2' }
      )
    )
  })
  f.emit('stale-run', {
    message: JSON.stringify(
      createApprovalEnvelope(approvalIdentity, 'provider-reused-id', 'write', {
        path: 'file.txt',
        content: 'run-1'
      })
    )
  })
  await until(() => f.responses().length === 4)
  assert.equal(waits, 2)
  assert.ok(
    f
      .responses()
      .slice(2)
      .every((response) => response.cancelled === true)
  )
})

for (const retirement of ['dispose', 'abort', 'replace-run'] as const)
  test(`final allow preflight catches ${retirement} from UI cleanup before committing a single cancelled terminal`, async (t) => {
    const events: RpcApprovalEvent[] = []
    const f = await approvalWire({
      requestToolApproval: (_, signal) => {
        signal.addEventListener(
          'abort',
          () => {
            if (retirement === 'dispose') f.bridge.dispose()
            if (retirement === 'abort') f.runController.abort()
            if (retirement === 'replace-run')
              f.setRun({
                id: 'replacement',
                signal: new AbortController().signal,
                authorizeCall: () => 'main'
              })
          },
          { once: true }
        )
        return 'approved'
      },
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => f.close())
    f.emit(retirement)
    await until(() => f.responses().length === 1 && events.length === 2)
    assert.equal(f.responses()[0].cancelled, true)
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_cancelled']
    )
  })
