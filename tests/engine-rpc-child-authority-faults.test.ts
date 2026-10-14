import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { childAuthorityCli } from './helpers/rpcChildAuthorityCli'

for (const fault of ['register-error', 'activate-error'] as const) {
  test(`actual production child ${fault} never enables a provider`, async () => {
    const fixture = await childAuthorityCli({ fault })
    try {
      await fixture.connection.prompt('Exercise the real refused child handshake')
      assert.deepEqual(fixture.faults, [fault])
      assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 0)
      assert.equal(fixture.approvals.length, 0)
      await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
    } finally {
      await fixture.close()
    }
  })
}
test('actual valid-digest cross-child SDK scope cannot request approval or execute', async () => {
  const fixture = await childAuthorityCli({ fault: 'cross-child-scope' })
  try {
    await fixture.connection.prompt('Exercise a scoped native child replay')
    assert.deepEqual(fixture.faults, ['cross-child-scope'])
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
    assert.equal(fixture.approvals.length, 0)
    await assert.rejects(readFile(join(fixture.cwd, 'native-effect.txt')), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})
