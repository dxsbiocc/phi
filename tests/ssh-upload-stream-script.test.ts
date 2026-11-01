import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildUploadStreamScript } from '../src/main/agent/transfer/ssh-data-plane-scripts'

test('a stream resuming from offset 0 discards bytes that were never checkpointed', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-upload-stream-script-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const partial = join(root, 'file.part')
  writeFileSync(partial, 'uncheckpointed bytes', { mode: 0o600 })
  const script = buildUploadStreamScript({
    partial,
    manifestPath: join(root, 'file.part.json'),
    manifestTemporary: join(root, 'file.part.json.stream'),
    truncateTemporary: join(root, 'file.part.truncate'),
    manifest: {
      protocolVersion: 1,
      transferId: 'offset-zero',
      direction: 'upload',
      sourceIdentity: { kind: 'local-file', device: '1', inode: '2', size: 5, mtime: '3' },
      expectedSize: 5,
      durableOffset: 0,
      chunkSize: 4,
      lastChunk: null,
      createdAt: 1,
      updatedAt: 1
    },
    offset: 0,
    hashTool: 'perl'
  })
  // BSD head refuses `head -c 0`, so this failed on a macOS host and not on GNU coreutils.
  const result = spawnSync('sh', ['-c', script], { input: 'fresh', encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.equal(readFileSync(partial, 'utf8'), 'fresh')
  assert.match(result.stdout, /PHI_SIZE=5\n/)
})
