import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { parseTarGz } from '../src/main/agent/packages/archive'
import {
  materializeConnectorRegistry,
  materializeRegistry
} from '../src/main/agent/packages/materialize-registry'
import { readRegistry } from '../src/main/agent/packages/registry'
import type { McpPackageManifest } from '../src/main/agent/packages/manifest'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-materialize-registry-'))
  roots.push(root)
  return root
}

function writeMcpPackage(root: string, id: string, version = '1.0.0'): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest: McpPackageManifest = {
    schemaVersion: 1,
    id,
    type: 'mcp',
    version,
    title: `${id} title`,
    summary: `${id} summary`,
    connector: {
      transport: 'http',
      publisher: 'Phi tests',
      category: '科研数据',
      url: `https://${id}.example/mcp`,
      auth: 'none'
    }
  }
  writeFileSync(join(dir, 'phi-package.yaml'), stringifyYaml(manifest))
  writeFileSync(join(dir, 'README.md'), `${id}\n`)
  return dir
}

test('single-package wrapper preserves the previous materialized registry behavior', () => {
  const root = sandbox()
  const packageDir = writeMcpPackage(root, 'alpha')
  const registryDir = join(root, 'registry')

  const registry = materializeConnectorRegistry(
    packageDir,
    registryDir,
    'temporary-source',
    'imported'
  )

  assert.equal(registry.id, 'temporary-source')
  assert.equal(registry.generatedAt, new Date(0).toISOString())
  assert.equal(registry.trust, 'imported')
  assert.equal(registry.packages.length, 1)
  assert.deepEqual(
    {
      id: registry.packages[0]?.id,
      type: registry.packages[0]?.type,
      version: registry.packages[0]?.version,
      title: registry.packages[0]?.title,
      summary: registry.packages[0]?.summary,
      dependsOn: registry.packages[0]?.dependsOn
    },
    {
      id: 'alpha',
      type: 'mcp',
      version: '1.0.0',
      title: 'alpha title',
      summary: 'alpha summary',
      dependsOn: []
    }
  )
  const archive = readFileSync(join(registryDir, registry.packages[0]!.archive))
  assert.deepEqual(
    parseTarGz(archive)
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path)
      .sort(),
    ['README.md', 'files.json', 'phi-package.yaml']
  )
})

test('materializes multiple MCP packages into an index readable by the existing registry loader', () => {
  const root = sandbox()
  const alpha = writeMcpPackage(root, 'alpha', '1.2.0')
  const beta = writeMcpPackage(root, 'beta', '2.0.0')
  const registryDir = join(root, 'registry')

  materializeRegistry([beta, alpha], registryDir, {
    id: 'github:acme/connectors',
    trust: 'imported',
    generatedAt: '2026-10-11T00:00:00.000Z'
  })
  const loaded = readRegistry(registryDir)

  assert.equal(loaded.trust, 'imported')
  assert.equal(loaded.generatedAt, '2026-10-11T00:00:00.000Z')
  assert.deepEqual(
    loaded.packages.map((entry) => `${entry.id}@${entry.version}`),
    ['alpha@1.2.0', 'beta@2.0.0']
  )
  assert.ok(loaded.packages.every((entry) => entry.manifestAsset))
})
