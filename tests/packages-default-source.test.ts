import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { stringify as stringifyYaml } from 'yaml'

import { buildRegistry } from '../scripts/packages/build-registry'
import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'
import {
  installPackages,
  listInstalledPackages,
  planInstall
} from '../src/main/agent/packages/installer'
import {
  readContentRegistry,
  prepareContentPackageInstall
} from '../src/main/agent/packages/content-source'
import { readKnownRegistries } from '../src/main/agent/packages/registries'
import {
  getCachedOfficialRegistry,
  syncOfficialRegistry
} from '../src/main/agent/packages/official-registry'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { createRuntimeResourceLoader } from '../src/main/agent/runtime/runtime-adapter'
import { listWrapperCompositionCatalog } from '../src/main/agent/wrappers/composition/discovery'

function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

const icon = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="3"/></svg>'

function sources(root: string): void {
  const skill = join(root, 'resources/skills/demo-skill')
  write(
    join(skill, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Standalone fixture.\n---\n# Demo\n'
  )
  write(join(skill, 'icon.svg'), icon)
  const plugin = join(root, 'resources/plugins/demo-plugin')
  write(
    join(plugin, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'demo-plugin',
      type: 'plugin',
      version: '1.0.0',
      title: 'Demo plugin',
      summary: 'Plugin fixture.',
      toolPrefix: 'demoplugin',
      components: { skills: ['skills/demo-helper'] }
    })
  )
  write(
    join(plugin, 'skills/demo-helper/SKILL.md'),
    '---\nname: demo-helper\ndescription: Plugin fixture.\n---\n# Demo\n'
  )
  write(join(plugin, 'icon.svg'), icon)
  const mcp = join(root, 'resources/connectors/demo-mcp')
  write(
    join(mcp, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'demo-mcp',
      type: 'mcp',
      version: '1.0.0',
      title: 'Demo MCP',
      summary: 'Connector fixture.',
      connector: {
        transport: 'http',
        publisher: 'Phi',
        category: '科研数据',
        url: 'https://example.test/mcp',
        auth: 'none'
      }
    })
  )
  write(join(mcp, 'icon.svg'), icon)
  const wrapper = join(root, 'resources/wrappers/modules/nf-core/demo/run')
  write(join(wrapper, 'main.nf'), 'process RUN {}\n')
  write(
    join(wrapper, 'wrapper/wrapper.yaml'),
    stringifyYaml({
      id: 'nf-core/modules/demo-run',
      name: 'Demo run',
      summary: 'Wrapper fixture.',
      params: { outdir: { kind: 'output', type: 'path', required: true } },
      outputs: { results: { type: 'directory', path: '${outdir}', primary: true } }
    })
  )
  write(join(wrapper, 'wrapper/main.nf'), "include { RUN } from '../main.nf'\n")
  write(join(wrapper, 'wrapper/params.json'), '{}\n')
  write(join(wrapper, 'wrapper/icon.svg'), icon)
}

function files(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else result.set(relative(root, path).replaceAll('\\', '/'), readFileSync(path))
    }
  }
  visit(root)
  return result
}

test('official catalog installs all four content types into authoritative paths without source resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-default-content-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    sources(root)
    execFileSync('git', ['add', 'resources'], { cwd: root })
    const outDir = join(root, 'published')
    const index = buildRegistry({ repoRoot: root, outDir, generatedAt: '2026-10-08T00:00:00Z' })
    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const indexBytes = readFileSync(join(outDir, 'index.json'))
    write(join(outDir, 'index.sig.json'), JSON.stringify(signRegistryIndex(indexBytes, privateKey)))
    const assets = files(outDir)
    const requests: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname.replace('/catalog/', '')
      requests.push(path)
      const bytes = assets.get(path)
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
    }
    const agentDir = join(root, 'agent')
    const options = {
      agentDir,
      baseUrl: 'https://example.test/catalog/',
      trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }],
      fetch: fetcher,
      appVersion: '1.0.0'
    }
    await syncOfficialRegistry(options)
    const registry = await readContentRegistry('phi-packages', options)
    assert.deepEqual(readKnownRegistries(agentDir).registries, [])
    assert.equal(
      requests.some((path) => path.endsWith('.tar.gz')),
      false
    )
    assert.equal(listConnectorCatalog({ agentDir, registries: [registry] })[0]?.id, 'demo-mcp')
    const mcpEntry = registry.packages.find((entry) => entry.type === 'mcp')!
    assert.ok(mcpEntry.manifestAsset)
    const competingManifest = Buffer.from(
      readFileSync(join(registry.dir, mcpEntry.manifestAsset.path), 'utf8').replace(
        'version: 1.0.0',
        'version: 9.0.0'
      )
    )
    const competingDir = join(root, 'competing-registry')
    write(join(competingDir, 'connector.yaml'), competingManifest)
    const competing = {
      ...registry,
      id: 'custom-registry',
      dir: competingDir,
      trust: 'imported' as const,
      packages: [
        {
          ...mcpEntry,
          version: '9.0.0',
          manifestAsset: {
            path: 'connector.yaml',
            sha256: createHash('sha256').update(competingManifest).digest('hex'),
            size: competingManifest.length
          }
        }
      ]
    }
    const preferred = listConnectorCatalog({ agentDir, registries: [competing, registry] }).find(
      (entry) => entry.id === 'demo-mcp'
    )
    assert.equal(preferred?.version, '1.0.0')
    assert.equal(preferred?.registryDir, registry.dir)
    rmSync(join(root, 'resources'), { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
    for (const entry of index.packages) {
      await prepareContentPackageInstall(
        registry,
        { type: entry.type, id: entry.id, version: entry.version },
        options
      )
      await installPackages(
        planInstall(registry, { type: entry.type, id: entry.id }, options),
        options
      )
    }
    const installed = listInstalledPackages({ agentDir })
    assert.equal(installed.length, 4)
    assert.ok(
      installed.every((entry) => entry.registry === 'phi-packages' && entry.trust === 'official')
    )
    for (const entry of installed) {
      const expected =
        entry.type === 'wrapper'
          ? join(agentDir, 'wrappers/tree')
          : join(agentDir, 'packages', entry.type, entry.id, entry.version)
      assert.equal(entry.dir, expected)
      if (entry.type !== 'wrapper') assert.equal(existsSync(join(entry.dir, 'icon.svg')), true)
    }
    assert.equal(
      existsSync(join(agentDir, 'wrappers/tree/modules/nf-core/demo/run/wrapper/icon.svg')),
      true
    )
    const wrapperItems = listWrapperCompositionCatalog({ agentDir })
    assert.equal(
      wrapperItems.some((entry) => entry.manifest.id === 'nf-core/modules/demo-run'),
      true
    )
    const loader = createRuntimeResourceLoader({ cwd: root, agentDir })
    assert.ok(
      loader.options.additionalSkillFiles?.includes(
        join(agentDir, 'packages/skill/demo-skill/1.0.0/SKILL.md')
      )
    )
    assert.ok(
      loader.options.additionalSkillFiles?.includes(
        join(agentDir, 'packages/plugin/demo-plugin/1.0.0/skills/demo-helper/SKILL.md')
      )
    )
    const cached = getCachedOfficialRegistry(options)
    assert.ok(cached)
    assert.equal(
      listConnectorCatalog({ agentDir, registries: [cached] })[0]?.registryDir,
      registry.dir
    )
    assert.equal(
      listConnectorCatalog({ agentDir })[0]?.registryDir,
      installed.find((entry) => entry.type === 'mcp')?.dir
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('connector runtime catalog is empty without installed packages or an explicit verified source', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-no-bundled-connector-'))
  try {
    assert.deepEqual(listConnectorCatalog({ agentDir }), [])
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
