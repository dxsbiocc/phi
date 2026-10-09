import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createDeterministicTarGz } from '../../src/main/agent/packages/archive'
import { parsePackageManifestText } from '../../src/main/agent/packages/manifest'
import { readRegistry } from '../../src/main/agent/packages/installer'
import type { LocalRegistry } from '../../src/main/agent/packages/installer-types'

/** A real unsigned registry built from minimal manifests, without external package files. */
export function writeMcpRegistryFixture(root: string, manifests: readonly string[]): LocalRegistry {
  mkdirSync(root, { recursive: true })
  const packages = manifests.map((text) => {
    const manifest = parsePackageManifestText(text)
    if (manifest.type !== 'mcp') throw new Error('MCP fixture requires an MCP manifest')
    const archive = createDeterministicTarGz([
      { path: 'phi-package.yaml', data: Buffer.from(text) }
    ])
    const file = `mcp-${manifest.id}-${manifest.version}.tar.gz`
    writeFileSync(join(root, file), archive)
    return {
      id: manifest.id,
      type: manifest.type,
      version: manifest.version,
      title: manifest.title,
      summary: manifest.summary,
      archive: file,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.length,
      dependsOn: [],
      ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {})
    }
  })
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z', packages })
  )
  return readRegistry(root)
}
