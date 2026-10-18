import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'
import { materializeRegistry } from '../src/main/agent/packages/materialize-registry'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'
import { readRegistry } from '../src/main/agent/packages/registry'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): { agentDir: string; registry: (version: string) => LocalRegistry } {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-api-source-'))
  roots.push(root)
  return {
    agentDir: join(root, 'agent'),
    registry(version) {
      const source = join(root, `source-${version}`)
      mkdirSync(source)
      writeFileSync(
        join(source, 'phi-package.yaml'),
        stringify({
          schemaVersion: 1,
          id: 'browser-use',
          type: 'mcp',
          version,
          title: 'Browser Use',
          summary: 'Run browser tasks',
          connector: {
            transport: 'http',
            publisher: 'Browser Use',
            category: '生产力',
            homepage: 'https://docs.browser-use.com',
            url: 'https://api.browser-use.com/v3/mcp',
            auth: 'header'
          }
        })
      )
      return materializeRegistry([source], join(root, `registry-${version}`), {
        id: `fixture-${version}`,
        allowedTypes: ['mcp']
      })
    }
  }
}

test('the managed website API source is shown as Phi official with its real unsigned trust', () => {
  const f = fixture()
  const api = {
    ...f.registry('1.0.1'),
    id: 'phi-packages',
    kind: 'official' as const,
    label: 'Phi 官网'
  }
  const user = f.registry('9.0.0')
  const entries = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [user, api]
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '1.0.1')
  assert.deepEqual(entries[0].source, {
    kind: 'official',
    label: 'Phi 官网',
    trust: 'imported'
  })
  assert.equal(entries[0].registryDir, api.dir)
})

test('user GitHub sources retain their real upstream provenance', () => {
  const f = fixture()
  const imported = {
    ...f.registry('1.0.0'),
    source: {
      kind: 'github' as const,
      id: 'custom-source',
      repo: 'acme/connectors',
      sha: 'a'.repeat(40)
    }
  }
  const entry = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [imported]
  })[0]
  assert.equal(entry.source?.kind, 'github')
  assert.equal(entry.source?.label, 'GitHub · acme/connectors@aaaaaaa')
  assert.equal(entry.source?.trust, 'imported')
})

test('API entries with restricted authorization remain visible with their restriction after cache reads', () => {
  const f = fixture()
  const registry = f.registry('1.0.1')
  const indexFile = join(registry.dir, 'index.json')
  const index = JSON.parse(readFileSync(indexFile, 'utf8'))
  index.packages[0].directoryAuthBlocked = true
  writeFileSync(indexFile, JSON.stringify(index))
  const api = {
    ...readRegistry(registry.dir),
    id: 'phi-packages',
    kind: 'official' as const,
    label: 'Phi 官网'
  }
  const entries = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [api]
  })
  assert.equal(entries.length, 1)
  assert.match(entries[0].unavailableReason ?? '', /授权/)
  assert.equal(entries[0].unavailableKind, 'authorization')
  assert.equal(entries[0].source?.kind, 'official')
})
