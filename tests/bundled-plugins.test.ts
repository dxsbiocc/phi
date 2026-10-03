import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { currentPlatform } from '../src/main/agent/envs'
import { readPackageManifest } from '../src/main/agent/packages/manifest'
import { installPlugin, loadedPlugins, type LoadedPlugin } from '../src/main/agent/plugins/loader'
import { isPluginSkillPreviewPath } from '../src/main/agent/plugins/preview'
import { createRuntimeResourceLoader } from '../src/main/agent/runtime/runtime-adapter'

const VISUALIZATION_SOURCE = join(process.cwd(), 'resources', 'plugins', 'visualization')

function withTemp(body: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-installed-plugins-'))
  return Promise.resolve()
    .then(() => body(root))
    .finally(() => rmSync(root, { recursive: true, force: true }))
}

function installVisualization(root: string): {
  agentDir: string
  runtimeRoot: string
  plugin: LoadedPlugin
} {
  const agentDir = join(root, 'agent')
  const runtimeRoot = join(root, 'runtime')
  const result = installPlugin(VISUALIZATION_SOURCE, { agentDir, runtimeRoot })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.plugin)
  return { agentDir, runtimeRoot, plugin: result.plugin }
}

function writeAgent(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ntools:\n  - read\n---\n${description}\n`
  )
}

test('installed plugin metadata and components come from the installed copy', async () => {
  await withTemp((root) => {
    const { agentDir, plugin } = installVisualization(root)
    const loaded = loadedPlugins({ agentDir })
    assert.deepEqual(
      loaded.map((item) => item.id),
      ['visualization']
    )
    const { version } = readPackageManifest(VISUALIZATION_SOURCE)
    assert.equal(plugin.version, version)
    assert.equal(plugin.toolPrefix, 'viz')
    assert.ok(plugin.dir.endsWith(join('packages', 'plugin', 'visualization', version)))
    assert.ok(plugin.components.agents.every((path) => path.startsWith(plugin.dir)))
    assert.ok(plugin.components.skills.every((path) => path.startsWith(plugin.dir)))
  })
})

test('plugin environment resolution requires the requesting installed plugin', async () => {
  await withTemp((root) => {
    const { agentDir } = installVisualization(root)
    const platform = currentPlatform()
    const found = describeEnvironment('plugin:viz', {
      agentDir,
      pluginId: 'visualization',
      platform
    })
    assert.equal(found.ref, 'plugin:viz')
    assert.equal(found.scope, 'plugin')
    assert.equal(found.owner, 'visualization')
    assert.equal(found.kind, 'package')
    assert.equal(found.spec.name, 'viz')
    assert.match(found.lockText, /@EXPLICIT/)

    assert.throws(
      () => describeEnvironment('plugin:viz', { agentDir, platform }),
      /requires a requesting plugin/
    )
    assert.throws(
      () =>
        describeEnvironment('plugin:viz', {
          agentDir,
          pluginId: 'another-plugin',
          platform
        }),
      /environment plugin:viz is not available/
    )
  })
})

test('agent discovery loads installed plugin agents and carries plugin identity', async () => {
  await withTemp((root) => {
    const { agentDir, plugin } = installVisualization(root)
    const { agents } = discoverPhiAgents({
      cwd: join(root, 'project'),
      agentDir,
      bundledDir: join(process.cwd(), 'resources', 'agents'),
      homeDir: join(root, 'home')
    })
    const visualization = agents.find((agent) => agent.name === 'Visualization')
    assert.ok(visualization)
    assert.equal(visualization.source, 'phi')
    assert.equal(visualization.pluginId, 'visualization')
    assert.equal(visualization.filePath, plugin.components.agents[0])
  })
})

test('a bundled agent keeps a name that an explicitly supplied plugin directory also defines', async () => {
  await withTemp((root) => {
    const bundled = join(root, 'bundled-agents')
    const pluginAgents = join(root, 'plugin-agents')
    writeAgent(bundled, 'Alpha', 'from bundled')
    writeAgent(pluginAgents, 'Alpha', 'from plugin')
    writeAgent(pluginAgents, 'Beta', 'from plugin')
    const { agents } = discoverPhiAgents({
      cwd: join(root, 'project'),
      agentDir: join(root, 'agent'),
      bundledDir: bundled,
      homeDir: join(root, 'home'),
      pluginAgentDirs: [pluginAgents]
    })
    assert.deepEqual(
      agents.map((agent) => [agent.name, agent.description, agent.source]),
      [
        ['Alpha', 'from bundled', 'phi'],
        ['Beta', 'from plugin', 'phi']
      ]
    )
  })
})

test('runtime skill loading and preview access use installed plugin files', async () => {
  await withTemp(async (root) => {
    const { agentDir, plugin } = installVisualization(root)
    const skillDir = plugin.components.skills[0]
    assert.ok(skillDir)
    const loader = createRuntimeResourceLoader({ cwd: join(root, 'project'), agentDir })
    assert.equal(loader.options.additionalSkillPaths?.includes(dirname(skillDir)), true)
    await loader.reload()
    const skill = loader.getSkills().skills.find((item) => item.name === 'omics-visualization')
    assert.ok(skill)
    assert.equal(skill.sourceInfo.source, 'phi-plugin')
    assert.equal(skill.sourceInfo.origin, 'visualization')

    const installedPreview = join(skillDir, 'scripts', 'tree', 'basic', 'preview.png')
    const sourcePreview = join(
      VISUALIZATION_SOURCE,
      'skills',
      'omics-visualization',
      'scripts',
      'tree',
      'basic',
      'preview.png'
    )
    assert.equal(isPluginSkillPreviewPath(installedPreview, agentDir), true)
    assert.equal(isPluginSkillPreviewPath(sourcePreview, agentDir), false)
  })
})
