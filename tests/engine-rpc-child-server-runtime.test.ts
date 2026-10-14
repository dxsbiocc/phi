import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { childAuthorityCli, childUntil, type ChildCliFixture } from './helpers/rpcChildAuthorityCli'

test('actual child model changed after activation cannot use late approval or another provider request', async () => {
  let release!: (value: 'approved') => void
  const fixture = await childAuthorityCli({
    decision: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })

  try {
    const parent = fixture.connection.prompt('Run a private model identity transition probe')
    void parent.catch(() => undefined)
    await childUntil(
      () => fixture.approvals.length === 1,
      'actual child waiting before model transition'
    )
    const commands = await fixture.connection.request<{
      commands: Array<{ name: string; source?: string }>
    }>({ type: 'get_available_commands' })
    assert.ok(
      commands.commands.some(
        (command) =>
          command.name === 'phi-child-server-model-change' && command.source === 'extension'
      )
    )
    assert.equal(
      (await fixture.connection.prompt('/phi-child-server-model-change authority-child'))
        .agentInvoked,
      false
    )
    const probe = fixture.frames
      .filter((frame) => frame.type === 'extension_ui_request' && typeof frame.message === 'string')
      .map((frame) => {
        try {
          return JSON.parse(frame.message as string) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .find((value) => value.type === 'phi_child_model_changed_probe')
    assert.deepEqual(probe, {
      type: 'phi_child_model_changed_probe',
      childId: 'authority-child',
      before: 'model',
      after: 'shadow'
    })
    release('approved')
    await parent
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
  } finally {
    await fixture.close()
  }
})

for (const mutation of ['limits', 'route', 'forward-model'] as const)
  test(`actual child ${mutation} transition remains closed after activation and late approval`, async () => {
    let release!: (value: 'approved') => void
    const fixture = await childAuthorityCli({
      decision: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    try {
      const parent = fixture.connection.prompt(
        'Run a private transport and metadata transition probe'
      )
      void parent.catch(() => undefined)
      await childUntil(
        () => fixture.approvals.length === 1,
        'actual pending approval before metadata transition'
      )
      const commands = await fixture.connection.request<{
        commands: Array<{ name: string; source?: string }>
      }>({ type: 'get_available_commands' })
      assert.ok(
        commands.commands.some(
          (command) =>
            command.name === 'phi-child-server-model-change' && command.source === 'extension'
        )
      )
      assert.equal(
        (
          await fixture.connection.prompt(
            '/phi-child-server-model-change authority-child ' + mutation
          )
        ).agentInvoked,
        false
      )
      const probe = fixture.frames
        .filter(
          (frame) => frame.type === 'extension_ui_request' && typeof frame.message === 'string'
        )
        .map((frame) => {
          try {
            return JSON.parse(frame.message as string) as Record<string, unknown>
          } catch {
            return {}
          }
        })
        .find((value) => value.type === 'phi_child_model_mutation_probe')
      assert.deepEqual(probe, {
        type: 'phi_child_model_mutation_probe',
        childId: 'authority-child',
        mutation,
        gateRejected: mutation === 'forward-model'
      })
      release('approved')
      await parent
      await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
      assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
    } finally {
      await fixture.close()
    }
  })

interface ConcurrencyPolicy {
  kind: string
  ordinary: 'shared' | 'exclusive' | null
  pty: 'shared' | 'exclusive' | null
}
interface ConcurrencyProbe {
  type: 'phi_child_concurrency_probe'
  childId: string
  tools: Record<
    string,
    { native: ConcurrencyPolicy; installed: ConcurrencyPolicy; activeReference: boolean }
  >
}
async function concurrencyProbe(fixture: ChildCliFixture): Promise<ConcurrencyProbe> {
  assert.equal(
    (await fixture.connection.prompt('/phi-child-server-concurrency-probe authority-child'))
      .agentInvoked,
    false
  )
  const notifications = fixture.frames.flatMap((frame) => {
    if (frame.type !== 'extension_ui_request' || typeof frame.message !== 'string') return []
    try {
      return [JSON.parse(frame.message) as ConcurrencyProbe]
    } catch {
      return []
    }
  })
  const probe = notifications.findLast((value) => value.type === 'phi_child_concurrency_probe')
  assert.ok(probe)
  assert.equal(probe.childId, 'authority-child')
  return probe
}
async function effect(fixture: ChildCliFixture, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(fixture.cwd, file), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function assertOuterResults(fixture: ChildCliFixture, ids: readonly string[]): void {
  const child = fixture.requests.filter((request) => request.actor === 'child')
  assert.equal(child.length, 2)
  const results = child[1].body.messages.filter((message) => message.role === 'tool')
  assert.deepEqual(
    results.map((message) => message.tool_call_id),
    ids
  )
}

test('actual same-batch native writes preserve exclusive approval and final write order', async (t) => {
  const releases = new Map<string, () => void>()
  const fixture = await childAuthorityCli({
    batch: 'write',
    decision: (request) =>
      new Promise((resolve) => {
        assert.ok(request.toolCallId)
        releases.set(request.toolCallId, () => resolve('approved'))
      })
  })
  try {
    const parent = fixture.connection.prompt('Run the same-batch ordered native writes')
    void parent.catch(() => undefined)
    await childUntil(() => fixture.approvals.length >= 1, 'first same-batch write approval')
    const probe = await concurrencyProbe(fixture)
    const first = 'outer-authority-write-1',
      second = 'outer-authority-write-2'
    if (probe.tools.write.installed.ordinary !== 'exclusive') {
      // Retain the original-code counterexample: second native write completes before the first.
      await childUntil(() => fixture.approvals.length === 2, 'incorrect parallel second write')
      releases.get(second)!()
      await childUntil(
        async () => (await effect(fixture, 'native-effect.txt')) === 'SECOND\n',
        'real second write before first approval'
      )
      releases.get(first)!()
    } else {
      assert.equal(fixture.approvals.length, 1)
      assert.equal(await effect(fixture, 'native-effect.txt'), undefined)
      releases.get(first)!()
      await childUntil(() => fixture.approvals.length === 2, 'ordered second write approval')
      assert.equal(await effect(fixture, 'native-effect.txt'), 'FIRST\n')
      releases.get(second)!()
    }
    await parent
    const final = await effect(fixture, 'native-effect.txt')
    t.diagnostic(JSON.stringify({ write: probe.tools.write, final }))
    assert.equal(final, 'SECOND\n')
    assert.deepEqual(probe.tools.write, {
      native: { kind: 'string', ordinary: 'exclusive', pty: 'exclusive' },
      installed: { kind: 'string', ordinary: 'exclusive', pty: 'exclusive' },
      activeReference: true
    })
    assert.deepEqual(
      fixture.approvals.map((request) => request.toolCallId),
      [first, second]
    )
    assertOuterResults(fixture, [first, second])
  } finally {
    await fixture.close()
  }
})

for (const batch of ['bash-shared', 'bash-pty'] as const)
  test(`actual same-batch ${batch} retains native conditional scheduling`, async () => {
    const releases = new Map<string, () => void>()
    const fixture = await childAuthorityCli({
      batch,
      decision: (request) =>
        new Promise((resolve) => {
          assert.ok(request.toolCallId)
          releases.set(request.toolCallId, () => resolve('approved'))
        })
    })
    try {
      const parent = fixture.connection.prompt('Run the same-batch native shell calls')
      void parent.catch(() => undefined)
      await childUntil(() => fixture.approvals.length >= 1, 'first native bash approval')
      const probe = await concurrencyProbe(fixture)
      const policy = { kind: 'function', ordinary: 'shared', pty: 'exclusive' }
      assert.deepEqual(probe.tools.bash, {
        native: policy,
        installed: policy,
        activeReference: true
      })
      const first = 'outer-authority-bash-1',
        second = 'outer-authority-bash-2'
      if (batch === 'bash-shared') {
        await childUntil(() => fixture.approvals.length === 2, 'both shared bash approvals')
        releases.get(second)!()
        await childUntil(
          async () => (await effect(fixture, 'bash-effect-2.txt')) === 'SECOND\n',
          'shared second bash effect before first approval'
        )
        assert.equal(await effect(fixture, 'bash-effect-1.txt'), undefined)
        releases.get(first)!()
      } else {
        assert.equal(fixture.approvals.length, 1)
        releases.get(first)!()
        await childUntil(() => fixture.approvals.length === 2, 'exclusive second bash approval')
        assert.equal(await effect(fixture, 'bash-effect-1.txt'), 'FIRST\n')
        assert.equal(await effect(fixture, 'bash-effect-2.txt'), undefined)
        releases.get(second)!()
      }
      await parent
      assert.equal(await effect(fixture, 'bash-effect-1.txt'), 'FIRST\n')
      assert.equal(await effect(fixture, 'bash-effect-2.txt'), 'SECOND\n')
      assertOuterResults(fixture, [first, second])
    } finally {
      await fixture.close()
    }
  })
