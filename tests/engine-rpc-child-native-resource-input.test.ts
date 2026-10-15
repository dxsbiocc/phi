import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalRpcChildNativeInput } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-native-tools'

test('child edit and search use exact project paths without granting native aliases or sibling access', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'phi-child-edit-input-')))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'source.txt'), 'original')
  assert.deepEqual(
    canonicalRpcChildNativeInput(cwd, 'edit', {
      path: 'source.txt',
      old_string: 'original',
      new_string: 'changed'
    }),
    { path: join(cwd, 'source.txt'), old_string: 'original', new_string: 'changed' }
  )
  assert.deepEqual(canonicalRpcChildNativeInput(cwd, 'glob', { path: '*.txt' }), {
    path: join(cwd, '*.txt')
  })
  assert.deepEqual(
    canonicalRpcChildNativeInput(cwd, 'grep', { path: 'source.txt', pattern: 'original' }),
    { path: join(cwd, 'source.txt'), pattern: 'original' }
  )
  for (const name of ['edit', 'glob', 'grep']) {
    assert.throws(() =>
      canonicalRpcChildNativeInput(cwd, name, { path: '../other', pattern: '.*' })
    )
    assert.throws(() => canonicalRpcChildNativeInput(cwd, name, { path: 'source.txt:raw' }))
  }
  assert.throws(() => canonicalRpcChildNativeInput(cwd, 'glob', { path: '*.txt /etc/*' }))
  assert.throws(() => canonicalRpcChildNativeInput(cwd, 'glob', { path: '{../peer,src}/*.txt' }))
})
