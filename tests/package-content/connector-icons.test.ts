import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { packageContentRoot } from '../helpers/packageContent'

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

test('migrated connector payloads retain original logo hashes and patch versions', () => {
  const attribution = readFileSync(join(process.cwd(), 'docs/content-icons.md'), 'utf8')
  const records = [
    ...attribution.matchAll(
      /`(resources\/connectors\/[^`]+)`\s*\|\s*`([a-f0-9]{64})`\s*\|\s*(\d+)/g
    )
  ]
  assert.equal(records.length, 18)
  for (const [, path, hash, size] of records) {
    const data = readFileSync(join(packageContentRoot(), path))
    assert.equal(sha256(data), hash, path)
    assert.equal(data.length, Number(size), path)
    const manifest = readFileSync(
      join(packageContentRoot(), dirname(path), 'phi-package.yaml'),
      'utf8'
    )
    assert.match(manifest, /^version: 1\.0\.1$/m, path)
  }
})
