import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { discoverPackages } from '../src/main/agent/packages/github-source'
import { materializeRegistry } from '../src/main/agent/packages/materialize-registry'
import type { McpPackageManifest } from '../src/main/agent/packages/manifest'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-github-discovery-'))
  roots.push(root)
  return root
}

function mcpManifest(
  id: string,
  version = '1.0.0',
  transport: 'http' | 'stdio' = 'http'
): McpPackageManifest {
  return {
    schemaVersion: 1,
    id,
    type: 'mcp',
    version,
    title: `${id} title`,
    summary: `${id} summary`,
    connector:
      transport === 'http'
        ? {
            transport: 'http',
            publisher: 'Phi tests',
            category: '科研数据',
            url: `https://${id}.example/mcp`,
            auth: 'none'
          }
        : {
            transport: 'stdio',
            publisher: 'Phi tests',
            category: '科研数据',
            environment: './environment.yml',
            command: './server.sh',
            args: ['--stdio']
          }
  }
}

function writeManifest(dir: string, manifest: unknown): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'phi-package.yaml'), stringifyYaml(manifest))
  return dir
}

test('discovers a root MCP package without scanning nested package candidates', () => {
  const root = sandbox()
  writeManifest(root, mcpManifest('root-connector', '2.0.0', 'stdio'))
  writeManifest(join(root, 'nested'), mcpManifest('ignored-nested'))

  const result = discoverPackages(root)
  assert.deepEqual(result.packages, [
    {
      id: 'root-connector',
      version: '2.0.0',
      title: 'root-connector title',
      summary: 'root-connector summary',
      publisher: 'Phi tests',
      transport: 'stdio'
    }
  ])
  assert.deepEqual(result.packageDirs, [root])
})

test('discovers depth-one/two packages and reports invalid and unsupported packages', () => {
  const root = sandbox()
  writeManifest(join(root, 'connectors', 'alpha'), mcpManifest('alpha'))
  writeManifest(join(root, 'direct'), mcpManifest('direct'))
  writeManifest(join(root, 'broken'), { nope: true })
  writeManifest(join(root, 'skills', 'helper'), {
    schemaVersion: 1,
    id: 'helper',
    type: 'skill',
    version: '1.0.0',
    title: 'Helper',
    summary: 'Helper skill'
  })
  writeFileSync(
    join(root, 'skills', 'helper', 'SKILL.md'),
    '---\nname: helper\ndescription: Helper skill\n---\n# Helper\n'
  )

  const result = discoverPackages(root)
  assert.deepEqual(
    result.packages.map((entry) => entry.id),
    ['alpha', 'direct']
  )
  assert.deepEqual(result.skipped, [
    { id: 'helper', type: 'skill', reason: '暂不支持导入: skill helper' }
  ])
  assert.match(result.warnings.join('\n'), /broken.*phi-package\.yaml/s)
})

test('finds packages in the phi-packages layout and ignores vendored or too-deep directories', () => {
  const root = sandbox()
  writeManifest(join(root, 'resources', 'connectors', 'alpha'), mcpManifest('alpha'))
  writeManifest(join(root, 'resources', 'connectors', 'beta'), mcpManifest('beta'))
  writeManifest(join(root, 'node_modules', 'dep', 'inner'), mcpManifest('vendored'))
  writeManifest(join(root, '.git', 'x', 'y'), mcpManifest('hidden'))
  writeManifest(join(root, 'a', 'b', 'c', 'too-deep'), mcpManifest('toodeep'))

  const result = discoverPackages(root)
  assert.deepEqual(
    result.packages.map((entry) => entry.id),
    ['alpha', 'beta']
  )
})

test('loads a prebuilt registry and verifies every archive before previewing it', () => {
  const root = sandbox()
  const sourcePackage = writeManifest(join(root, 'source', 'alpha'), mcpManifest('alpha'))
  const registryDir = join(root, 'registry')
  materializeRegistry([sourcePackage], registryDir, {
    id: 'fixture',
    generatedAt: '2026-10-11T00:00:00.000Z'
  })

  const result = discoverPackages(registryDir)
  assert.equal(result.prebuiltRegistryDir, registryDir)
  assert.deepEqual(
    result.packages.map((entry) => entry.id),
    ['alpha']
  )

  const index = JSON.parse(readFileSync(join(registryDir, 'index.json'), 'utf8')) as {
    packages: Array<{ archive: string }>
  }
  const archivePath = join(registryDir, index.packages[0]!.archive)
  writeFileSync(archivePath, Buffer.from('corrupt'))
  assert.throws(() => discoverPackages(registryDir), /checksum|size|校验|大小/i)
})

test('rejects duplicate package ids and repositories with no valid MCP package', () => {
  const duplicate = sandbox()
  writeManifest(join(duplicate, 'a'), mcpManifest('same'))
  writeManifest(join(duplicate, 'b'), mcpManifest('same', '2.0.0'))
  assert.throws(() => discoverPackages(duplicate), /重复软件包.*same/)

  const empty = sandbox()
  mkdirSync(dirname(join(empty, 'broken', 'phi-package.yaml')), { recursive: true })
  writeFileSync(join(empty, 'broken', 'phi-package.yaml'), 'invalid: true\n')
  assert.throws(() => discoverPackages(empty), /没有可导入的 MCP 连接器/)
})
