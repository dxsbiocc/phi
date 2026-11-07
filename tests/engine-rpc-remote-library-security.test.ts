import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { REMOTE_LIBRARY_MAX_INDEX_BYTES } from '../src/main/agent/engine/rpc/remote-library-types'
import { rpcRemoteLibraryFixture } from './helpers/rpcRemoteLibraryFixture'

for (const attack of [
  'symbolic-parent',
  'symbolic-index',
  'hardlinked-index',
  'fifo-index',
  'readonly-index',
  'writable-parent',
  'oversize-index',
  'invalid-index',
  'extra-nested-index',
  'wrong-enum-type',
  'extra-nested-paper',
  'invalid-pending'
] as const) {
  test(
    `remote library rejects ${attack} without local fallback or outside-path mutation`,
    { timeout: 30000 },
    async (t) => {
      const f = rpcRemoteLibraryFixture()
      t.after(() => f.close())
      const saved = await f.call('lib_save', { title: 'Selected project paper' })
      assert.equal(saved.isError, undefined, JSON.stringify(saved))
      const library = join(f.server.projectRoot, '.phi/library')
      const index = join(library, 'index.json')
      const before = readFileSync(index)
      const sentinel = join(f.server.localAnchor, 'sentinel')
      writeFileSync(sentinel, 'untouched')
      if (attack === 'symbolic-parent') {
        rmSync(join(f.server.projectRoot, '.phi'), { recursive: true })
        symlinkSync(f.server.localAnchor, join(f.server.projectRoot, '.phi'))
      }
      if (attack === 'symbolic-index') {
        rmSync(index)
        symlinkSync(sentinel, index)
      }
      if (attack === 'hardlinked-index') {
        rmSync(index)
        linkSync(sentinel, index)
      }
      if (attack === 'fifo-index') {
        rmSync(index)
        execFileSync('mkfifo', [index])
      }
      if (attack === 'readonly-index') chmodSync(index, 0o400)
      if (attack === 'writable-parent') chmodSync(join(f.server.projectRoot, '.phi'), 0o777)
      if (attack === 'oversize-index') truncateSync(index, REMOTE_LIBRARY_MAX_INDEX_BYTES + 1)
      if (attack === 'invalid-index')
        writeFileSync(
          index,
          JSON.stringify({
            schemaVersion: 1,
            createdAt: 'now',
            updatedAt: 'now',
            papers: [{ storageKey: '../../escape' }]
          })
        )
      if (attack === 'wrong-enum-type') {
        const value = JSON.parse(before.toString())
        value.papers[0].priorityTier = ['must']
        writeFileSync(index, JSON.stringify(value))
      }
      if (attack === 'extra-nested-index') {
        const value = JSON.parse(before.toString())
        value.unbounded = { nested: { extra: 'unsupported version1 metadata' } }
        writeFileSync(index, JSON.stringify(value))
      }
      if (attack === 'extra-nested-paper') {
        const value = JSON.parse(before.toString())
        value.papers[0].identifiers.push({
          kind: 'source:unsafe',
          value: 'ignored',
          extra: { nested: 'unsupported' }
        })
        writeFileSync(index, JSON.stringify(value))
      }
      if (attack === 'invalid-pending')
        writeFileSync(
          join(library, '.projection-pending.json'),
          JSON.stringify({ schemaVersion: 1, key: '../../escape' }),
          { mode: 0o600 }
        )
      const result = await f.call(attack === 'readonly-index' ? 'lib_save' : 'lib_list', {
        title: 'No side effect'
      })
      assert.equal(result.isError, true, JSON.stringify(result))
      assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
      assert.equal(existsSync(join(f.server.localAnchor, '.phi/library')), false)
      if (attack === 'readonly-index') {
        assert.deepEqual(readFileSync(index), before)
        assert.equal((await f.call('lib_list')).isError, undefined)
      }
    }
  )
}

test(
  'remote library rejects symlinked paper projections before authoritative index publication',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const saved = await f.call('lib_save', { title: 'Projection link paper' })
    const paper = (saved.details as { paper: { storageKey: string; canonicalId: string } }).paper
    const base = join(f.server.projectRoot, '.phi/library')
    const index = readFileSync(join(base, 'index.json'))
    const meta = join(base, 'papers', paper.storageKey, 'meta.json')
    rmSync(meta)
    symlinkSync(join(f.server.localAnchor, 'outside-meta'), meta)
    const failed = await f.call('lib_update', {
      id: paper.canonicalId,
      notes: 'not admitted'
    })
    assert.equal(failed.isError, true)
    assert.deepEqual(readFileSync(join(base, 'index.json')), index)
    assert.equal(existsSync(join(f.server.localAnchor, 'outside-meta')), false)
  }
)

test('unbound and mismatched request context is rejected before selected server resolution', async (t) => {
  const f = rpcRemoteLibraryFixture()
  t.after(() => f.close())
  const request = {
    ...f.identity,
    requestId: 'request',
    toolCallId: 'tool',
    action: 'save',
    input: { title: 'forged' }
  }
  await assert.rejects(
    f.service.execute(request, { originSessionId: 'forged', toolCallId: 'tool' }),
    /trusted tool scope/
  )
  await assert.rejects(
    f.service.execute(
      { ...request, projectId: 'different' },
      { originSessionId: f.identity.runtimeSessionId, toolCallId: 'tool' }
    ),
    /Unverified selected/
  )
  assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
  assert.equal(
    (await f.call('lib_save', { title: 'a', notes: 'x'.repeat(256 * 1024) })).isError,
    true
  )
  assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
})

test('pre-aborted and disposed library calls cannot resolve a server or create project data', async (t) => {
  const f = rpcRemoteLibraryFixture()
  t.after(() => f.close())
  const controller = new AbortController()
  controller.abort(new Error('before any library intent'))
  await assert.rejects(
    f.call('lib_save', { title: 'Must not start' }, controller.signal),
    /before any library intent/
  )
  assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
  f.service.dispose()
  const result = await f.call('lib_save', { title: 'Disposed service' })
  assert.equal(result.isError, true)
  assert.equal(existsSync(join(f.server.projectRoot, '.phi')), false)
})
