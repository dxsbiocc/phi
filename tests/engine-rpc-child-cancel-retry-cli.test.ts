import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { childAuthorityCli, childUntil } from './helpers/rpcChildAuthorityCli'

for (const firstCancel of ['refuse', 'timeout'] as const)
  test(`actual running native child survives a ${firstCancel} cancel but its next same-parent stop cannot falsely succeed`, async () => {
    const fixture = await childAuthorityCli({ tool: 'bash', holdBash: true, firstCancel })
    let parent: Promise<unknown> | undefined
    try {
      parent = fixture.connection.prompt('Run a controlled native bash wait for cancellation')
      void parent.catch(() => undefined)
      await childUntil(async () => {
        try {
          return (await readFile(join(fixture.cwd, 'native-started.txt'), 'utf8')) === 'STARTED'
        } catch {
          return false
        }
      }, 'actual native command started')
      assert.equal(fixture.approvals.length, 1)
      await assert.rejects(fixture.authority.cancelParent('private-parent-run'), /not confirmed/)
      const actual = await fixture.connection.request<{
        subagents: Array<{ id: string; status: string }>
      }>({ type: 'get_subagents' })
      const child = actual.subagents.find((agent) => agent.id === 'authority-child')
      assert.ok(child)
      assert.equal(
        ['completed', 'failed', 'aborted', 'cancelled'].includes(child.status),
        false,
        'Actual SDK still observes the native child running'
      )
      await assert.rejects(readFile(join(fixture.cwd, 'native-late-effect.txt')), {
        code: 'ENOENT'
      })
      await fixture.authority.cancelParent('unknown-parent')
      assert.deepEqual(fixture.cancelAttempts, ['authority-child'])
      await fixture.authority.cancelParent('private-parent-run')
      assert.deepEqual(
        fixture.cancelAttempts,
        ['authority-child', 'authority-child'],
        'The verified native target survives local authority revocation'
      )
      assert.ok(
        fixture.frames.some(
          (frame) =>
            frame.type === 'subagent_lifecycle' &&
            (frame.payload as { id?: string; status?: string }).id === 'authority-child' &&
            (frame.payload as { status?: string }).status === 'aborted'
        )
      )
      await parent
      await fixture.authority.cancelParent('private-parent-run')
      assert.deepEqual(fixture.cancelAttempts, ['authority-child', 'authority-child'])
      await assert.rejects(readFile(join(fixture.cwd, 'native-late-effect.txt')), {
        code: 'ENOENT'
      })
    } finally {
      await fixture.connection
        .request({ type: 'cancel_subagent', subagentId: 'authority-child' })
        .catch(() => undefined)
      await parent?.catch(() => undefined)
      await fixture.close()
    }
  })
