import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { activateChild, childAuthority } from './helpers/rpcChildAuthorityFixture'
import { childAuthorityCli, childUntil } from './helpers/rpcChildAuthorityCli'

for (const retire of ['dispose', 'generation'] as const)
  test(`retired ${retire} authority rejects cancellation instead of claiming an empty confirmation`, async () => {
    const { authority, controller } = childAuthority()
    try {
      await activateChild(authority)
      if (retire === 'dispose') authority.dispose()
      else controller.abort()
      await assert.rejects(authority.cancelParent('parent-run'), /unavailable|retired|closed/)
    } finally {
      authority.dispose()
    }
  })
test('a live unknown parent remains a harmless no-op', async () => {
  const { authority } = childAuthority()
  try {
    await authority.cancelParent('unknown-parent')
  } finally {
    authority.dispose()
  }
})
test('a real running native child is not falsely confirmed stopped after Node authority disposal', async () => {
  const fixture = await childAuthorityCli({ tool: 'bash', holdBash: true })
  let parent: Promise<unknown> | undefined
  try {
    parent = fixture.connection.prompt(
      'Keep a native operation alive while retiring Node authority'
    )
    void parent.catch(() => undefined)
    await childUntil(async () => {
      try {
        return (await readFile(join(fixture.cwd, 'native-started.txt'), 'utf8')) === 'STARTED'
      } catch {
        return false
      }
    }, 'actual native command running before authority retirement')
    fixture.authority.dispose()
    const actual = await fixture.connection.request<{
      subagents: Array<{ id: string; status: string }>
    }>({ type: 'get_subagents' })
    const child = actual.subagents.find((item) => item.id === 'authority-child')
    assert.ok(child)
    assert.equal(['completed', 'failed', 'aborted', 'cancelled'].includes(child.status), false)
    await assert.rejects(
      fixture.authority.cancelParent('private-parent-run'),
      /unavailable|retired|closed/
    )
    await assert.rejects(readFile(join(fixture.cwd, 'native-late-effect.txt')), { code: 'ENOENT' })
  } finally {
    await fixture.connection
      .request({ type: 'cancel_subagent', subagentId: 'authority-child' })
      .catch(() => undefined)
    await parent?.catch(() => undefined)
    await fixture.close()
  }
})
