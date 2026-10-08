import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packageRegistryIconView } from '../src/main/agent/packages/icon-views'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'
import { readResourceIcon } from '../src/main/agent/resource-icons'

test('catalog views expose opaque references and verify sidecars lazily', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-catalog-icons-'))
  try {
    const data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>')
    writeFileSync(join(dir, 'icon.svg'), data)
    const registry: LocalRegistry = {
      id: dir,
      dir,
      trust: 'imported',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      packages: [
        {
          id: 'sample',
          type: 'skill',
          version: '1.0.0',
          title: 'Sample',
          summary: '',
          archive: 'sample.tar.gz',
          sha256: '0'.repeat(64),
          size: 1,
          dependsOn: [],
          iconAsset: {
            path: 'icon.svg',
            sha256: createHash('sha256').update(data).digest('hex'),
            size: data.length
          }
        }
      ]
    }
    const view = packageRegistryIconView(registry)
    const icon = view.packages[0].icon
    assert.match(icon?.key ?? '', /^[a-f0-9]{64}$/)
    assert.ok(readResourceIcon(icon?.key)?.startsWith('data:image/svg+xml;base64,'))
    assert.equal(registry.packages[0].iconAsset?.path, 'icon.svg')
    assert.equal('icon' in registry.packages[0], false)

    registry.packages[0].iconAsset!.sha256 = 'f'.repeat(64)
    assert.equal(readResourceIcon(packageRegistryIconView(registry).packages[0].icon?.key), null)
    delete registry.packages[0].iconAsset
    assert.equal(packageRegistryIconView(registry).packages[0].icon, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
