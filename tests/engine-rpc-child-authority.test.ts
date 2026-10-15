import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  childActual,
  childModel,
  childAuthority,
  childProfile,
  childRequest,
  childScope,
  childStarted,
  activateChild
} from './helpers/rpcChildAuthorityFixture'
import { rpcChildProfileFromDefinition } from '../src/main/agent/engine/rpc/subagents/run-registry'
const signal = (): AbortSignal => new AbortController().signal

test('child activation waits for independent started and allocates a child run distinct from its parent', async () => {
  const { authority } = childAuthority()
  try {
    assert.equal((await authority.accept(childRequest('register', 1), signal()))?.allowed, true)
    let settled = false
    const active = authority.accept(childRequest('activate', 2), signal())!.then((r) => {
      settled = true
      return r
    })
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(authority.registry.snapshot().length, 0)
    authority.observe(childStarted())
    assert.equal((await active).allowed, true)
    const run = authority.registry.snapshot()[0]
    assert.equal(run.parentRunId, 'parent-run')
    assert.notEqual(run.id, run.parentRunId)
    assert.equal(run.signal.aborted, false)
    authority.observe({ type: 'agent_end' })
    assert.equal(authority.registry.current(childScope), run)
  } finally {
    authority.dispose()
  }
})
test('project-shadow started cannot activate the generated user profile', async () => {
  const { authority } = childAuthority()
  try {
    const started = childStarted()
    ;(started.payload as Record<string, unknown>).agentSource = 'project'
    authority.observe(started)
    assert.equal((await authority.accept(childRequest('register', 1), signal()))?.allowed, false)
    assert.equal((await authority.accept(childRequest('activate', 2), signal()))?.allowed, false)
  } finally {
    authority.dispose()
  }
})
test('wrong root generation, manifest hash or journal cannot register', async () => {
  for (const patch of [
    { generation: 2 },
    { definitionHash: 'b'.repeat(64) },
    { childSessionFile: '/srv/history/unrelated/child.jsonl' }
  ]) {
    const { authority } = childAuthority()
    try {
      assert.equal(
        (await authority.accept(childRequest('register', 1, { ...childScope, ...patch }), signal()))
          ?.allowed,
        false
      )
    } finally {
      authority.dispose()
    }
  }
})
test('actual tool, model, prompt and thinking profile mismatches remain closed', async () => {
  for (const patch of [
    { tools: ['bash'] },
    { model: { ...childActual.model, id: 'other' } },
    { model: { ...childActual.model, reasoning: true } },
    {
      model: {
        ...childActual.model,
        input: ['text', 'image'] satisfies readonly ('text' | 'image')[]
      }
    },
    { model: { ...childActual.model, contextWindow: 65536 } },
    { model: { ...childActual.model, maxTokens: 2048 } },
    { route: { ...childActual.route, baseUrl: 'http://127.0.0.1:45678' } },
    { route: { ...childActual.route, transport: 'pi-native' as const } },
    { systemPromptDigest: 'b'.repeat(64) },
    { thinkingLevel: 'high' }
  ]) {
    const { authority } = childAuthority()
    try {
      authority.observe(childStarted())
      await authority.accept(childRequest('register', 1), signal())
      const request = childRequest('activate', 2)
      assert.equal(request.operation, 'activate')
      assert.equal(
        (
          await authority.accept(
            { ...request, operation: 'activate', actual: { ...childActual, ...patch } },
            signal()
          )
        )?.allowed,
        false
      )
      assert.equal(authority.registry.current(childScope), undefined)
    } finally {
      authority.dispose()
    }
  }
})
test('unverified host and resource profiles and invalid mode fail before registry creation', () => {
  for (const definition of [
    { ...childProfile.definition, blocking: 'background' as unknown as boolean },
    { ...childProfile.definition, skills: ['unverified'] },
    { ...childProfile.definition, tools: [{ name: 'ChildHost', site: 'host' as const }] }
  ]) {
    assert.throws(
      () => childAuthority({ profiles: [{ ...childProfile, definition }] }),
      /profile|native tool/
    )
  }
})
test('low-level authority accepts the explicit trusted background profile without granting any invocation', () => {
  const { authority } = childAuthority({
    profiles: [{ ...childProfile, definition: { ...childProfile.definition, blocking: false } }]
  })
  try {
    assert.equal(authority.registry.current(childScope), undefined)
  } finally {
    authority.dispose()
  }
})
test('capability, request replay and sequence gaps cannot gain child authority', async () => {
  const { authority } = childAuthority()
  try {
    const register = childRequest('register', 1)
    assert.throws(
      () => authority.accept({ ...register, capability: 'e'.repeat(64) }, signal()),
      /unavailable/
    )
    assert.equal((await authority.accept(register, signal()))?.allowed, true)
    assert.throws(() => authority.accept(register, signal()), /replay/)
    assert.throws(() => authority.accept(childRequest('activate', 3), signal()), /sequence/)
    authority.observe(childStarted())
    assert.equal(authority.registry.snapshot().length, 0)
  } finally {
    authority.dispose()
  }
})
test('explicit parent stop cancels only the child bound to that parent, including late registration', async () => {
  const { authority } = childAuthority({
    captureParent: (s) => ({ runId: s.id === 'child' ? 'parent-one' : 'parent-two' })
  })
  const other = {
    ...childScope,
    nativeAgentId: 'other-child',
    childOmpSessionId: 'other-sdk',
    childSessionFile: '/srv/history/root/other-child.jsonl'
  }
  try {
    await activateChild(authority)
    await activateChild(authority, other)
    const one = authority.registry.current(childScope)!,
      two = authority.registry.current(other)!
    await authority.cancelParent('parent-one')
    assert.equal(one.signal.aborted, true)
    assert.equal(two.signal.aborted, false)
    assert.equal(authority.registry.snapshot().length, 1)
  } finally {
    authority.dispose()
  }
})
test('denial and cancellation do not become late approval', async () => {
  for (const decision of ['denied', 'cancelled'] as const) {
    const { authority } = childAuthority({
      approval: { shouldGate: () => true, requestToolApproval: () => decision }
    })
    try {
      await activateChild(authority)
      assert.equal((await authority.accept(childRequest('approve', 3), signal()))?.allowed, false)
    } finally {
      authority.dispose()
    }
  }
  let release!: (value: 'approved') => void
  const { authority } = childAuthority({
    approval: {
      shouldGate: () => true,
      requestToolApproval: () =>
        new Promise((r) => {
          release = r
        })
    }
  })
  try {
    await activateChild(authority)
    const result = authority.accept(childRequest('approve', 3), signal())!
    await new Promise<void>((r) => setImmediate(r))
    await authority.cancelParent('parent-run')
    release('approved')
    assert.equal((await result).allowed, false)
  } finally {
    authority.dispose()
  }
})
test('live project policy is rechecked after UI and again at the reply commit', async () => {
  let gate = true,
    release!: (value: 'approved') => void
  const { authority } = childAuthority({
    approval: {
      shouldGate: () => gate,
      requestToolApproval: () =>
        new Promise((r) => {
          release = r
        })
    }
  })
  try {
    await activateChild(authority)
    const request = childRequest('approve', 3),
      result = authority.accept(request, signal())!
    await new Promise<void>((r) => setImmediate(r))
    release('approved')
    const reply = await result
    assert.equal(reply.allowed, true)
    gate = false
    assert.equal(
      authority.canReply(request as Exclude<typeof request, { operation: 'cancel' }>, reply),
      false
    )
  } finally {
    authority.dispose()
  }
})
test('requested approval observers stop the child before any allow commits', async () => {
  const created = childAuthority({
    approval: {
      shouldGate: () => true,
      requestToolApproval: () => 'approved',
      onEvent: (event) => {
        if (event.type === 'approval_requested') return created.authority.cancelParent('parent-run')
        return undefined
      }
    }
  })
  const authority = created.authority
  try {
    await activateChild(authority)
    assert.equal((await authority.accept(childRequest('approve', 3), signal()))?.allowed, false)
  } finally {
    authority.dispose()
  }
})
test('unconfirmed native cancellation fails explicitly while child permission remains revoked', async () => {
  const cancelled: string[] = []
  const { authority } = childAuthority({
    cancelNativeChild: (id) => {
      cancelled.push(id)
      return false
    }
  })
  try {
    await activateChild(authority)
    await assert.rejects(authority.cancelParent('parent-run'), /not confirmed/)
    assert.deepEqual(cancelled, ['child'])
    assert.equal(authority.registry.current(childScope), undefined)
    await authority.cancelParent('unknown-parent')
    assert.deepEqual(cancelled, ['child'])
  } finally {
    authority.dispose()
  }
})
test('cancelled parent cannot admit a later tentative child and generation retirement closes active children', async () => {
  const { authority, controller } = childAuthority()
  try {
    await authority.cancelParent('parent-run')
    await authority.accept(childRequest('register', 1), signal())
    authority.observe(childStarted())
    assert.equal((await authority.accept(childRequest('activate', 2), signal()))?.allowed, false)
  } finally {
    authority.dispose()
  }
  const active = childAuthority()
  try {
    await activateChild(active.authority)
    const run = active.authority.registry.current(childScope)!
    active.controller.abort()
    assert.equal(run.signal.aborted, true)
    assert.throws(
      () => active.authority.accept(childRequest('approve', 3), signal()),
      /unavailable/
    )
  } finally {
    active.authority.dispose()
    controller.abort()
  }
})
test('trusted compiler manifest must bind the same root project and cwd', () => {
  for (const patch of [{ projectId: 'other-project' }, { projectRoot: '/srv/other' }])
    assert.throws(
      () =>
        childAuthority({
          manifestBinding: {
            serverId: 'private-server',
            serverIdentitySha256: 'b'.repeat(64),
            projectId: childScope.projectId,
            projectRoot: childScope.cwd,
            ...patch
          }
        }),
      /project binding/
    )
})

test('compiler-to-wire model mapper explicitly refuses unknown and invalid limits', () => {
  for (const patch of [
    { contextWindow: null },
    { maxTokens: null },
    { contextWindow: 0 },
    { maxTokens: Number.NaN }
  ])
    assert.throws(
      () =>
        rpcChildProfileFromDefinition(
          { ...childProfile.definition, environment: undefined },
          childProfile.systemPrompt,
          {
            ...childModel,
            ...patch
          },
          childProfile.route
        ),
      /Unverifiable/
    )
  assert.deepEqual(
    rpcChildProfileFromDefinition(
      { ...childProfile.definition, environment: undefined },
      childProfile.systemPrompt,
      childModel,
      childProfile.route
    ).model,
    childProfile.model
  )
})
