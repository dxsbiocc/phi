import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { findResourceIcon, readResourceIcon } from '../src/main/agent/resource-icons'
import type { LoadedPlugin } from '../src/main/agent/plugins/loader'

const root = mkdtempSync(join(tmpdir(), 'phi-resource-icon-metadata-'))
const agentDir = join(root, 'agent')
const project = join(root, 'project')
mkdirSync(agentDir)
mkdirSync(project)
process.env.PI_CODING_AGENT_DIR = agentDir

const { listSkills, listMcpServers } = await import('../src/main/agent/resources')
const { buildPhiPluginListItem } = await import('../src/main/agent/plugins/details')
const { installPlugin } = await import('../src/main/agent/plugins/loader')
const { listConnectorCatalog, installCatalogConnector } =
  await import('../src/main/agent/mcp-connectors')
const { addCustomWrapper, listWrapperCatalog } = await import('../src/main/agent/wrappers/catalog')
const { listWrapperCompositionCatalogStatus, resetWrapperCompositionCatalogCache } =
  await import('../src/main/agent/wrappers/composition/discovery')
const { writeSkillsRegistry, skillVersionDir } = await import('../src/main/agent/packages/store')

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#0369a1"/></svg>'
const SOURCE_ICON = ICON.replace('#0369a1', '#e11d48')

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('all 18 shipped connector logos resolve to safe image data', () => {
  const connectors = join(process.cwd(), 'resources', 'connectors')
  const directories = readdirSync(connectors, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  )
  assert.equal(directories.length, 18)
  for (const directory of directories) {
    const icon = findResourceIcon(join(connectors, directory.name))
    assert.ok(icon, directory.name)
    assert.match(
      readResourceIcon(icon.key) ?? '',
      /^data:image\/(svg\+xml|png|jpeg|webp);base64,/,
      directory.name
    )
  }
})

test('skill metadata includes own-folder icons for project and installed skills', async () => {
  const local = join(project, '.phi', 'skills', 'icon-local')
  const installed = skillVersionDir('icon-installed', '1.0.0', agentDir)
  for (const [dir, name] of [
    [local, 'icon-local'],
    [installed, 'icon-installed']
  ]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Icon skill fixture.\n---\n# Icon fixture\n`
    )
    writeFileSync(join(dir, 'icon.svg'), ICON)
  }
  writeSkillsRegistry(
    {
      version: 1,
      skills: { 'icon-installed': { version: '1.0.0', installedAt: '2026-10-08T00:00:00Z' } }
    },
    agentDir
  )
  const skills = await listSkills(project)
  for (const name of ['icon-local', 'icon-installed']) {
    const skill = skills.find((entry) => entry.name === name)
    assert.ok(skill, name)
    assert.ok(skill.icon, name)
    assert.ok(readResourceIcon(skill.icon.key), name)
  }
})

test('installed Phi plugins expose root icons and plugin skills inherit the root fallback', async () => {
  const source = join(root, 'plugin-source')
  cpSync(join(process.cwd(), 'resources', 'plugins', 'visualization'), source, { recursive: true })
  writeFileSync(join(source, 'icon.svg'), ICON)
  const result = installPlugin(source, { agentDir, runtimeRoot: join(root, 'runtime') })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.plugin)
  const loaded: LoadedPlugin = { ...result.plugin, enabled: true }
  const item = buildPhiPluginListItem(loaded)
  assert.ok(item.icon)
  assert.ok(readResourceIcon(item.icon.key))
  rmSync(source, { recursive: true, force: true })
  const skills = await listSkills(project)
  const pluginSkill = skills.find((entry) => entry.sourceId === 'visualization')
  assert.ok(pluginSkill?.icon)
  assert.ok(readResourceIcon(pluginSkill.icon.key))
})

test('MCP catalog prefers installed icons and survives removal of the source registry', async () => {
  const source = join(root, 'connector-source')
  mkdirSync(source)
  writeFileSync(
    join(source, 'phi-package.yaml'),
    `schemaVersion: 1\nid: icon-connector\ntype: mcp\nversion: 1.0.0\ntitle: Icon connector\nsummary: Test installed icons.\nconnector:\n  transport: http\n  publisher: Fixture\n  category: 科研数据\n  url: https://example.com/mcp\n  auth: none\n`
  )
  writeFileSync(join(source, 'icon.svg'), ICON)
  const installed = await installCatalogConnector(source, 'icon-connector', '1.0.0', {
    agentDir,
    appVersion: '1.0.0'
  })
  assert.equal(installed.length, 1)
  writeFileSync(join(source, 'icon.svg'), SOURCE_ICON)
  const before = listConnectorCatalog({
    agentDir,
    appVersion: '1.0.0',
    bundledConnectorsDir: source
  })
  assert.equal(before[0]?.added, true)
  assert.ok(before[0]?.icon)
  assert.equal(
    readResourceIcon(before[0].icon.key),
    `data:image/svg+xml;base64,${Buffer.from(ICON).toString('base64')}`
  )
  rmSync(source, { recursive: true, force: true })
  const after = listConnectorCatalog({
    agentDir,
    appVersion: '1.0.0',
    bundledConnectorsDir: source,
    registryDirs: [join(root, 'deleted-registry')]
  })
  const connector = after.find((entry) => entry.id === 'icon-connector')
  assert.ok(connector?.icon)
  assert.deepEqual(connector.icon, before[0].icon)
  assert.ok(readResourceIcon(connector.icon.key))
  const servers = await listMcpServers(project)
  const server = servers.find((entry) => entry.packageId === 'icon-connector')
  assert.ok(server?.icon)
  assert.deepEqual(server.icon, connector.icon)
})

test('not-installed registry connectors expose verified sidecar refs without a source tree', async () => {
  const registry = join(root, 'registry')
  const source = join(root, 'registry-connector-source')
  mkdirSync(source)
  mkdirSync(registry)
  writeFileSync(
    join(source, 'phi-package.yaml'),
    `schemaVersion: 1\nid: sidecar-connector\ntype: mcp\nversion: 1.0.0\ntitle: Sidecar connector\nsummary: Test registry icons.\nconnector:\n  transport: http\n  publisher: Fixture\n  category: 科研数据\n  url: https://example.com/sidecar\n  auth: none\n`
  )
  const { createDeterministicTarGz } = await import('../src/main/agent/packages/archive')
  const manifest = readFileSync(join(source, 'phi-package.yaml'))
  const archive = createDeterministicTarGz([{ path: 'phi-package.yaml', data: manifest }])
  writeFileSync(join(registry, 'mcp-sidecar-connector-1.0.0.tar.gz'), archive)
  const indexPath = join(registry, 'index.json')
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-10-08T00:00:00Z',
    packages: [
      {
        id: 'sidecar-connector',
        type: 'mcp',
        version: '1.0.0',
        title: 'Sidecar connector',
        summary: 'Test registry icons.',
        archive: 'mcp-sidecar-connector-1.0.0.tar.gz',
        size: archive.length,
        sha256: createHash('sha256').update(archive).digest('hex'),
        dependsOn: [],
        iconAsset: {
          path: 'logo.svg',
          sha256: createHash('sha256').update(ICON).digest('hex'),
          size: Buffer.byteLength(ICON)
        }
      }
    ]
  }
  writeFileSync(join(registry, 'logo.svg'), ICON)
  writeFileSync(indexPath, JSON.stringify(index))
  const options = {
    agentDir,
    appVersion: '1.0.0',
    bundledConnectorsDir: join(root, 'missing-source'),
    registryDirs: [registry]
  }
  const item = listConnectorCatalog(options).find((entry) => entry.id === 'sidecar-connector')
  assert.ok(item?.icon)
  assert.ok(readResourceIcon(item.icon.key))
  writeFileSync(join(registry, 'logo.svg'), SOURCE_ICON)
  assert.equal(readResourceIcon(item.icon.key), null)
})

test('legacy and composition wrapper metadata select own icons and bounded family fallbacks', () => {
  const legacy = join(root, 'legacy-wrapper')
  mkdirSync(legacy)
  writeFileSync(
    join(legacy, 'wrapper.yaml'),
    `phiWrapperVersion: 1\nid: acme/tools/icon-wrapper\nshortId: icon-wrapper\nname: Icon Wrapper\nversion: 0.1.0\nsummary: Icon wrapper fixture.\nruntime:\n  minVersion: 1.0.0\n  maxVersion: 1.x\nresourceClass: light\nengine:\n  type: nextflow\n  entrypoint: main.nf\n  profiles:\n    - id: local\n      executor: local\ninputs: []\nparameters:\n  schema:\n    type: object\n    properties: {}\noutputs:\n  - id: report\n    label: Report\n    type: html\n    path: results/report.html\n    primary: true\nresources:\n  defaults:\n    cpus: 1\n`
  )
  writeFileSync(join(legacy, 'main.nf'), 'workflow {}\n')
  writeFileSync(join(legacy, 'icon.svg'), ICON)
  const added = addCustomWrapper(legacy, agentDir)
  assert.ok(added.icon)
  rmSync(legacy, { recursive: true, force: true })
  const listed = listWrapperCatalog(agentDir).find(
    (entry) => entry.manifest.id === added.manifest.id
  )
  assert.ok(listed?.icon)
  assert.ok(readResourceIcon(listed.icon.key))

  const sourceRoot = join(root, 'composition')
  const family = join(sourceRoot, 'modules', 'acme', 'family')
  const wrapper = join(family, 'task', 'wrapper')
  mkdirSync(wrapper, { recursive: true })
  writeFileSync(
    join(wrapper, 'wrapper.yaml'),
    'id: acme/modules/icon-task\nname: Icon task\nsummary: Test wrapper icons.\nparams: {}\noutputs:\n  result:\n    type: path\n    path: results/report.txt\n    primary: true\n'
  )
  writeFileSync(join(family, 'icon.svg'), ICON)
  resetWrapperCompositionCatalogCache()
  const fallback = listWrapperCompositionCatalogStatus({ agentDir, sourceRoot })[0]
  assert.ok(fallback?.icon)
  assert.deepEqual(fallback.icon, findResourceIcon(family))
  writeFileSync(join(wrapper, 'icon.svg'), SOURCE_ICON)
  const own = listWrapperCompositionCatalogStatus({ agentDir, sourceRoot })[0]
  assert.ok(own?.icon)
  assert.deepEqual(own.icon, findResourceIcon(wrapper))
  assert.notDeepEqual(own.icon, fallback.icon)
})
