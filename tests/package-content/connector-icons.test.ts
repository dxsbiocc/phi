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
  const [migrationSection, gatewaySection = ''] = attribution.split(
    '## Phi omics MCP gateway icons'
  )
  const migratedRecords = [
    ...migrationSection.matchAll(
      /`(resources\/connectors\/[^`]+)`\s*\|\s*`([a-f0-9]{64})`\s*\|\s*(\d+)/g
    )
  ]
  assert.equal(migratedRecords.length, 12)
  for (const [, path, hash, size] of migratedRecords) {
    const data = readFileSync(join(packageContentRoot(), path))
    assert.equal(sha256(data), hash, path)
    assert.equal(data.length, Number(size), path)
    const manifest = readFileSync(
      join(packageContentRoot(), dirname(path), 'phi-package.yaml'),
      'utf8'
    )
    // The logo migration bumped each payload off 1.0.0; later catalog edits may bump it again.
    assert.doesNotMatch(manifest, /^version: 1\.0\.0$/m, path)
  }

  const gatewayRecords = [
    ...gatewaySection.matchAll(
      /`(resources\/connectors\/[^`]+)`\s*\|\s*`([a-f0-9]{64})`\s*\|\s*(\d+)/g
    )
  ]
  assert.equal(gatewayRecords.length, 9)
  for (const [, path, hash, size] of gatewayRecords) {
    const data = readFileSync(join(packageContentRoot(), path))
    assert.equal(sha256(data), hash, path)
    assert.equal(data.length, Number(size), path)
  }
})
