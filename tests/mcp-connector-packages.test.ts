import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import {
  connectorEnvironmentBuildAction,
  installCatalogConnector,
  listConnectorCatalog,
  refreshPersistedManagedStdioServers,
  setMcpPackageEnabled,
  uninstallCatalogConnector
} from '../src/main/agent/mcp-connectors'
import { readManagedMarker } from '../src/main/agent/mcp'
import { createDeterministicTarGz, type ArchiveFile } from '../src/main/agent/packages/archive'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import { listInstalledPackages } from '../src/main/agent/packages/installer'
import {
  parsePackageManifestText,
  type McpPackageManifest
} from '../src/main/agent/packages/manifest'
import { copyMinimal, installReady, writeExecutable } from './helpers/fakeEnvironment'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): {
  root: string
  agentDir: string
  runtimeRoot: string
  connectorsDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-packages-'))
  roots.push(root)
  return {
    root,
    agentDir: join(root, 'agent'),
    runtimeRoot: join(root, 'runtime'),
    connectorsDir: join(root, 'connectors')
  }
}

function writeConnector(
  connectorsDir: string,
  manifest: McpPackageManifest,
  files: Record<string, { content: string; executable?: boolean }> = {}
): string {
  const dir = join(connectorsDir, manifest.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'phi-package.yaml'), stringifyYaml(manifest))
  for (const [path, file] of Object.entries(files)) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    if (file.executable) writeExecutable(target, file.content)
    else writeFileSync(target, file.content)
  }
  return dir
}

function httpManifest(
  id: string,
  options: { version?: string; minAppVersion?: string; url?: string } = {}
): McpPackageManifest {
  return {
    schemaVersion: 1,
    id,
    type: 'mcp',
    version: options.version ?? '1.0.0',
    title: id,
    summary: `${id} connector`,
    ...(options.minAppVersion ? { minAppVersion: options.minAppVersion } : {}),
    connector: {
      transport: 'http',
      publisher: 'Phi tests',
      category: '科研数据',
      url: options.url ?? `https://${id}.example/mcp`,
      auth: 'none'
    }
  }
}

function stdioManifest(id: string, command = './server.sh'): McpPackageManifest {
  return {
    schemaVersion: 1,
    id,
    type: 'mcp',
    version: '1.0.0',
    title: id,
    summary: `${id} stdio connector`,
    connector: {
      transport: 'stdio',
      publisher: 'Phi tests',
      category: '科研数据',
      environment: './environment.yml',
      command,
      args: ['${package}/payload.txt']
    }
  }
}

function buildRegistry(sourceDirs: string[], outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const packages = sourceDirs.map((sourceDir) => {
    const parsed = readFileSync(join(sourceDir, 'phi-package.yaml'), 'utf8')
    const document = parsePackageManifestText(parsed)
    if (document.type !== 'mcp') throw new Error(`not an MCP fixture: ${sourceDir}`)
    const files = packageFiles(sourceDir)
    const listed = files.map(({ path, data }) => ({
      path,
      sha256: sha256(data),
      size: data.length
    }))
    const filesJson = Buffer.from(`${JSON.stringify({ version: 1, files: listed }, null, 2)}\n`)
    const archive = createDeterministicTarGz([...files, { path: 'files.json', data: filesJson }])
    const archiveName = `mcp-${document.id}-${document.version}.tar.gz`
    writeFileSync(join(outDir, archiveName), archive)
    return {
      id: document.id,
      type: 'mcp' as const,
      version: document.version,
      title: document.title,
      summary: document.summary,
      archive: archiveName,
      sha256: sha256(archive),
      size: archive.length,
      dependsOn: [],
      ...(document.minAppVersion ? { minAppVersion: document.minAppVersion } : {})
    }
  })
  writeFileSync(
    join(outDir, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-02T00:00:00Z', packages })}\n`
  )
  return outDir
}

function packageFiles(root: string): ArchiveFile[] {
  const files: ArchiveFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        files.push({ path: relative(root, path), data: readFileSync(path) })
      }
    }
  }
  walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

interface TestMcpEntry extends Record<string, unknown> {
  command?: string
  args?: string[]
  enabled?: boolean
  env?: Record<string, string>
  url?: string
  phiPackage?: string
}

interface TestMcpConfig {
  mcpServers: Record<string, TestMcpEntry>
}

function readConfig(agentDir: string): TestMcpConfig {
  return JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')) as TestMcpConfig
}

function installOptions(fixture: ReturnType<typeof sandbox>): {
  agentDir: string
  runtimeRoot: string
  appVersion: string
} {
  return {
    agentDir: fixture.agentDir,
    runtimeRoot: fixture.runtimeRoot,
    appVersion: '1.0.0'
  }
}

test('catalog combines bundled source and local registries with added and unavailable states', () => {
  const fixture = sandbox()
  writeConnector(fixture.connectorsDir, httpManifest('bundled-one'))
  const localSource = writeConnector(
    join(fixture.root, 'local-sources'),
    httpManifest('future-one', { minAppVersion: '9.0.0' })
  )
  const localRegistry = buildRegistry([localSource], join(fixture.root, 'registry'))
  mkdirSync(fixture.agentDir, { recursive: true })
  writeFileSync(
    join(fixture.agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { 'bundled-one': { type: 'http', url: 'https://user.example' } } })
  )

  const catalog = listConnectorCatalog({
    bundledConnectorsDir: fixture.connectorsDir,
    registryDirs: [localRegistry],
    agentDir: fixture.agentDir,
    appVersion: '1.0.0'
  })
  assert.deepEqual(catalog.map((entry) => entry.id).sort(), ['bundled-one', 'future-one'])
  assert.equal(catalog.find((entry) => entry.id === 'bundled-one')?.added, true)
  assert.match(
    catalog.find((entry) => entry.id === 'future-one')?.unavailableReason ?? '',
    /9\.0\.0/
  )
  assert.ok(catalog.every((entry) => entry.registryDir))
})

test('HTTP packages install, upgrade, and uninstall without touching user servers', async () => {
  const fixture = sandbox()
  const source = writeConnector(fixture.connectorsDir, httpManifest('remote-data'))
  await installCatalogConnector(
    fixture.connectorsDir,
    'remote-data',
    '1.0.0',
    installOptions(fixture)
  )
  let config = readConfig(fixture.agentDir)
  assert.deepEqual(config.mcpServers['remote-data'], {
    type: 'http',
    url: 'https://remote-data.example/mcp',
    enabled: true,
    phiPackage: 'remote-data'
  })
  assert.equal(
    listInstalledPackages({ agentDir: fixture.agentDir })[0]?.dir,
    join(fixture.agentDir, 'packages', 'mcp', 'remote-data', '1.0.0')
  )
  assert.equal(listInstalledPackages({ agentDir: fixture.agentDir })[0]?.trust, 'imported')

  config.mcpServers.user = { command: 'user-server', enabled: true }
  writeFileSync(join(fixture.agentDir, 'mcp.json'), `${JSON.stringify(config)}\n`)
  assert.equal(setMcpPackageEnabled('remote-data', false, fixture.agentDir), true)
  writeFileSync(
    join(source, 'phi-package.yaml'),
    stringifyYaml(httpManifest('remote-data', { version: '2.0.0', url: 'https://v2.example/mcp' }))
  )
  await installCatalogConnector(
    fixture.connectorsDir,
    'remote-data',
    '2.0.0',
    installOptions(fixture)
  )
  config = readConfig(fixture.agentDir)
  assert.equal(config.mcpServers['remote-data'].url, 'https://v2.example/mcp')
  assert.equal(config.mcpServers['remote-data'].enabled, false, 'upgrade preserves enablement')
  assert.equal(listInstalledPackages({ agentDir: fixture.agentDir })[0]?.version, '2.0.0')

  uninstallCatalogConnector('remote-data', installOptions(fixture))
  config = readConfig(fixture.agentDir)
  assert.deepEqual(config.mcpServers, { user: { command: 'user-server', enabled: true } })
  assert.deepEqual(listInstalledPackages({ agentDir: fixture.agentDir }), [])
})

test('directory connector sources and symlinked directories retain imported trust and icons', async () => {
  const icon =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg>'
  for (const linked of [false, true]) {
    const fixture = sandbox()
    const connectorDir = writeConnector(fixture.connectorsDir, httpManifest('local-data'), {
      'icon.svg': { content: icon }
    })
    const link = join(fixture.root, 'connector-source-link')
    if (linked) {
      symlinkSync(fixture.connectorsDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    await installCatalogConnector(
      linked ? link : fixture.connectorsDir,
      'local-data',
      '1.0.0',
      installOptions(fixture)
    )

    const installed = listInstalledPackages({ agentDir: fixture.agentDir })[0]
    assert.ok(installed)
    assert.equal(installed.trust, 'imported')
    assert.deepEqual(
      readFileSync(join(installed.dir, 'icon.svg')),
      readFileSync(join(connectorDir, 'icon.svg'))
    )
    assert.equal(
      JSON.parse(readFileSync(join(installed.dir, '.source.json'), 'utf8')).trust,
      'imported'
    )
  }
})

test('HTTP package install refuses to overwrite a same-name user server', async () => {
  const fixture = sandbox()
  writeConnector(fixture.connectorsDir, httpManifest('collision'))
  mkdirSync(fixture.agentDir, { recursive: true })
  writeFileSync(
    join(fixture.agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { collision: { type: 'http', url: 'https://user.example/mcp' } } })
  )
  await assert.rejects(
    installCatalogConnector(fixture.connectorsDir, 'collision', '1.0.0', installOptions(fixture)),
    /不会覆盖/
  )
  assert.deepEqual(listInstalledPackages({ agentDir: fixture.agentDir }), [])
})

test('ready stdio package runs an executable package-relative command under env -i', async () => {
  const fixture = sandbox()
  const packageDir = writeConnector(fixture.connectorsDir, stdioManifest('local-ready'), {
    'server.sh': { content: 'printf "%s" "$1"', executable: true },
    'payload.txt': { content: 'payload\n' }
  })
  copyMinimal(packageDir, 'local-ready-env')
  const descriptor = describeEnvironment('./environment.yml', {
    mcpPackage: { id: 'local-ready', dir: packageDir }
  })
  installReady(fixture.runtimeRoot, descriptor, {})

  await installCatalogConnector(
    fixture.connectorsDir,
    'local-ready',
    '1.0.0',
    installOptions(fixture)
  )
  const installed = listInstalledPackages({ agentDir: fixture.agentDir })[0]
  assert.ok(installed)
  const entry = readConfig(fixture.agentDir).mcpServers['local-ready']
  assert.equal(entry.command, '/usr/bin/env')
  assert.ok(entry.args)
  assert.equal(entry.args[0], '-i')
  assert.ok(entry.args.includes(join(installed.dir, 'server.sh')))
  assert.equal(entry.args.at(-1), join(installed.dir, 'payload.txt'))
  assert.equal(entry.enabled, true)
  assert.deepEqual(entry.env, {})
  assert.equal(entry.phiPackage, 'local-ready')
  assert.equal(readManagedMarker(entry)?.packageId, 'local-ready')
  const processResult = spawnSync(entry.command, entry.args, { encoding: 'utf8' })
  assert.equal(processResult.status, 0, processResult.stderr)
  assert.equal(processResult.stdout, join(installed.dir, 'payload.txt'))

  const action = connectorEnvironmentBuildAction('local-ready', {
    agentDir: fixture.agentDir
  })
  assert.equal(action.descriptor.scope, 'mcp')
  assert.deepEqual(action.options.requestedBy, { mcp: 'local-ready' })
})

test('not-built stdio entries stay disabled, refresh once, and enablement ignores user servers', async () => {
  const fixture = sandbox()
  const packageDir = writeConnector(fixture.connectorsDir, stdioManifest('local-pending'), {
    'server.sh': { content: 'exec /bin/cat "$1"', executable: true },
    'payload.txt': { content: 'payload\n' }
  })
  copyMinimal(packageDir, 'local-pending-env')
  await installCatalogConnector(
    fixture.connectorsDir,
    'local-pending',
    '1.0.0',
    installOptions(fixture)
  )
  let config = readConfig(fixture.agentDir)
  let entry = config.mcpServers['local-pending']
  assert.equal(entry.enabled, false)
  assert.equal(readManagedMarker(entry)?.pending, true)
  assert.equal(
    listConnectorCatalog({
      bundledConnectorsDir: fixture.connectorsDir,
      agentDir: fixture.agentDir,
      appVersion: '1.0.0'
    })[0]?.environmentState,
    'not-built'
  )

  config.mcpServers.user = { command: 'user-server', enabled: true }
  writeFileSync(join(fixture.agentDir, 'mcp.json'), `${JSON.stringify(config)}\n`)
  const action = connectorEnvironmentBuildAction('local-pending', { agentDir: fixture.agentDir })
  installReady(fixture.runtimeRoot, action.descriptor, {})
  const refreshed = refreshPersistedManagedStdioServers({
    agentDir: fixture.agentDir,
    runtimeRoot: fixture.runtimeRoot
  })
  assert.equal(refreshed.written, true)
  assert.deepEqual(refreshed.refreshed, ['local-pending'])
  config = readConfig(fixture.agentDir)
  entry = config.mcpServers['local-pending']
  assert.equal(entry.enabled, true)
  assert.equal(readManagedMarker(entry)?.pending, undefined)

  const before = readFileSync(join(fixture.agentDir, 'mcp.json'), 'utf8')
  const unchanged = refreshPersistedManagedStdioServers({
    agentDir: fixture.agentDir,
    runtimeRoot: fixture.runtimeRoot
  })
  assert.equal(unchanged.written, false)
  assert.equal(readFileSync(join(fixture.agentDir, 'mcp.json'), 'utf8'), before)

  assert.equal(setMcpPackageEnabled('local-pending', false, fixture.agentDir), true)
  config = readConfig(fixture.agentDir)
  assert.equal(config.mcpServers['local-pending'].enabled, false)
  assert.equal(config.mcpServers.user.enabled, true)
  assert.equal(setMcpPackageEnabled('missing', false, fixture.agentDir), false)
})

test('package-relative stdio command must be executable and rolls back failed install', async () => {
  const fixture = sandbox()
  const packageDir = writeConnector(fixture.connectorsDir, stdioManifest('not-executable'), {
    'server.sh': { content: '#!/bin/sh\nexit 0\n' },
    'payload.txt': { content: 'payload\n' }
  })
  copyMinimal(packageDir, 'not-executable-env')
  const descriptor = describeEnvironment('./environment.yml', {
    mcpPackage: { id: 'not-executable', dir: packageDir }
  })
  installReady(fixture.runtimeRoot, descriptor, {})
  await assert.rejects(
    installCatalogConnector(
      fixture.connectorsDir,
      'not-executable',
      '1.0.0',
      installOptions(fixture)
    ),
    /command not found/
  )
  assert.deepEqual(listInstalledPackages({ agentDir: fixture.agentDir }), [])
})
