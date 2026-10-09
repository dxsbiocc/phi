import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import test from 'node:test'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  readRegistry,
  planInstall,
  installPackages,
  uninstallPackage,
  listInstalledPackages
} from '../src/main/agent/packages/installer'
import { buildEnvironment } from '../src/main/agent/content/environment-refs'
import { readMcpConfig, writeMcpConfig } from '../src/main/agent/mcp/package-config'
import { readManagedMarker } from '../src/main/agent/mcp/stdio-environment'
import { acquireEnvironmentLease, hasLiveEnvironmentLeases } from '../src/main/agent/envs/leases'
import { cleanupInactiveMcpVersions } from '../src/main/agent/packages/mcp-version-cleanup'
import { collectGarbage } from '../src/main/agent/envs/gc'
import { currentPlatform } from '../src/main/agent/envs/platform'
import { removeTree } from '../src/main/agent/envs/ensure'
import type { InstallerOptions } from '../src/main/agent/packages/installer-types'

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function registry(root: string, version: string): { dir: string; binary: Buffer } {
  const dir = join(root, `registry-${version}`)
  mkdirSync(dir)
  const binary = Buffer.from(`#!/bin/sh\nprintf '${version}\\n'\n`)
  const files = [
    {
      path: 'phi-package.yaml',
      data: Buffer.from(
        stringify({
          schemaVersion: 1,
          id: 'managed-demo',
          type: 'mcp',
          version,
          title: 'Managed demo',
          summary: 'Fixture',
          minAppVersion: '1.0.1',
          connector: {
            transport: 'stdio',
            publisher: 'Test',
            category: '科研数据',
            environment: './environment.yml',
            command: 'managed-demo',
            args: []
          }
        })
      )
    },
    {
      path: 'environment.yml',
      data: Buffer.from(
        stringify({
          name: 'demo',
          channels: [],
          dependencies: [],
          installation: {
            backend: 'native',
            executable: 'managed-demo',
            artifacts: {
              [currentPlatform()]: {
                url: `https://example.test/${version}`,
                sha256: digest(binary),
                size: binary.length,
                format: 'file'
              }
            }
          }
        })
      )
    },
    { path: `locks/${currentPlatform()}.txt`, data: Buffer.from('@EXPLICIT\n') }
  ]
  const listed = files
    .map(({ path, data }) => ({ path, sha256: digest(data), size: data.length }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const archive = createDeterministicTarGz([
    ...files,
    { path: 'files.json', data: Buffer.from(JSON.stringify({ version: 1, files: listed })) }
  ])
  const name = `mcp-managed-demo-${version}.tar.gz`
  writeFileSync(join(dir, name), archive)
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      packages: [
        {
          id: 'managed-demo',
          type: 'mcp',
          version,
          title: 'Managed demo',
          summary: 'Fixture',
          archive: name,
          sha256: digest(archive),
          size: archive.length,
          dependsOn: []
        }
      ]
    })
  )
  return { dir, binary }
}

async function fixture(
  run: (root: string, options: InstallerOptions) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-managed-upgrade-'))
  const agentDir = join(root, 'agent')
  const runtimeRoot = join(root, 'runtime')
  const options: InstallerOptions = {
    agentDir,
    runtimeRoot,
    appVersion: '1.0.1',
    verifyMcpStdio: async () => ['actual_tool']
  }
  try {
    await run(root, options)
  } finally {
    removeTree(root)
  }
}

async function install(root: string, version: string, options: InstallerOptions): Promise<void> {
  const source = registry(root, version)
  const configured: InstallerOptions = {
    ...options,
    buildMcpEnvironment: (descriptor) =>
      buildEnvironment(options.runtimeRoot!, descriptor, {
        fetch: async () => new Response(Uint8Array.from(source.binary))
      })
  }
  const index = readRegistry(source.dir)
  await installPackages(
    planInstall(index, { type: 'mcp', id: 'managed-demo', version }, options),
    configured
  )
}

test('a failed managed upgrade leaves the previous version and disabled preference active', async () =>
  fixture(async (root, options) => {
    await install(root, '1.0.0', options)
    const before = readMcpConfig(options.agentDir)
    const server = before.mcpServers!['managed-demo']
    assert.ok(server && typeof server === 'object' && 'enabled' in server)
    server.enabled = false
    writeMcpConfig(before, options.agentDir)
    const oldBytes = readFileSync(join(options.agentDir!, 'mcp.json'))
    await assert.rejects(
      install(root, '1.1.0', {
        ...options,
        verifyMcpStdio: async () => {
          throw new Error('startup failure')
        }
      }),
      /startup failure/
    )
    assert.equal(listInstalledPackages(options)[0]?.version, '1.0.0')
    assert.deepEqual(readFileSync(join(options.agentDir!, 'mcp.json')), oldBytes)
    assert.ok(existsSync(join(options.agentDir!, 'packages/mcp/managed-demo/1.0.0')))
  }))

test('managed verification happens before activation and successful upgrade preserves disabled state', async () =>
  fixture(async (root, options) => {
    await install(root, '1.0.0', options)
    const before = readMcpConfig(options.agentDir)
    const server = before.mcpServers!['managed-demo']
    assert.ok(server && typeof server === 'object' && 'enabled' in server)
    server.enabled = false
    writeMcpConfig(before, options.agentDir)
    await install(root, '1.1.0', {
      ...options,
      verifyMcpStdio: async (request) => {
        assert.equal(listInstalledPackages(options)[0]?.version, '1.0.0')
        assert.match(String(request.entry.cwd), /\.staging/)
        return ['actual_tool']
      }
    })
    assert.equal(listInstalledPackages(options)[0]?.version, '1.1.0')
    const upgraded = readMcpConfig(options.agentDir).mcpServers!['managed-demo']
    assert.ok(upgraded && typeof upgraded === 'object' && 'enabled' in upgraded)
    assert.equal(upgraded.enabled, false)
  }))

test('verification cannot alter signed source before activating its new version', async () =>
  fixture(async (root, options) => {
    await assert.rejects(
      install(root, '1.0.0', {
        ...options,
        verifyMcpStdio: async (request) => {
          writeFileSync(join(String(request.entry.cwd), 'unexpected.txt'), 'tampered')
          return ['actual_tool']
        }
      }),
      /修改了已校验/
    )
    assert.deepEqual(listInstalledPackages(options), [])
  }))

test('staged verification holds its environment against concurrent cleanup until activation', async () =>
  fixture(async (root, options) => {
    let verifiedId = ''
    await install(root, '1.0.0', {
      ...options,
      verifyMcpStdio: async (request) => {
        const marker = readManagedMarker(request.entry)
        assert.ok(marker)
        verifiedId = marker.envId
        assert.equal(hasLiveEnvironmentLeases(options.runtimeRoot!, verifiedId), true)
        assert.deepEqual(collectGarbage(options.runtimeRoot!).removed, [])
        assert.ok(existsSync(join(options.runtimeRoot!, 'envs', verifiedId)))
        return ['actual_tool']
      }
    })
    assert.equal(hasLiveEnvironmentLeases(options.runtimeRoot!, verifiedId), false)
    assert.equal(listInstalledPackages(options)[0]?.version, '1.0.0')
    assert.ok(existsSync(join(options.runtimeRoot!, 'envs', verifiedId)))
  }))

test('failed staged verification releases its installation lease for later owned cleanup', async () =>
  fixture(async (root, options) => {
    let verifiedId = ''
    await assert.rejects(
      install(root, '1.0.0', {
        ...options,
        verifyMcpStdio: async (request) => {
          const marker = readManagedMarker(request.entry)
          assert.ok(marker)
          verifiedId = marker.envId
          throw new Error('startup failed')
        }
      }),
      /startup failed/
    )
    assert.equal(hasLiveEnvironmentLeases(options.runtimeRoot!, verifiedId), false)
    assert.deepEqual(collectGarbage(options.runtimeRoot!).removed, [verifiedId])
  }))

test('active consumers retain old runtime and source through upgrade, uninstall, and later cleanup', async () =>
  fixture(async (root, options) => {
    await install(root, '1.0.0', options)
    const entry = readMcpConfig(options.agentDir).mcpServers!['managed-demo']
    const marker = readManagedMarker(entry)
    assert.ok(marker)
    const oldId = marker.envId
    const lease = await acquireEnvironmentLease({ root: options.runtimeRoot!, envId: oldId })
    try {
      await install(root, '1.1.0', options)
      assert.ok(existsSync(join(options.runtimeRoot!, 'envs', oldId)))
      assert.ok(existsSync(join(options.agentDir!, 'packages/mcp/managed-demo/1.0.0')))
      uninstallPackage('mcp', 'managed-demo', options)
      assert.ok(existsSync(join(options.agentDir!, 'packages/mcp/managed-demo/1.0.0')))
    } finally {
      lease.release()
    }
    collectGarbage(options.runtimeRoot!)
    cleanupInactiveMcpVersions(options.agentDir!, options.runtimeRoot!)
    assert.equal(existsSync(join(options.runtimeRoot!, 'envs', oldId)), false)
    assert.equal(existsSync(join(options.agentDir!, 'packages/mcp/managed-demo/1.0.0')), false)
  }))
