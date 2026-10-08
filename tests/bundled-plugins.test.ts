import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { filterEnabledMainSkills, writeEnablementState } from '../src/main/agent/enablement'
import { currentPlatform } from '../src/main/agent/envs'
import { readPackageManifest } from '../src/main/agent/packages/manifest'
import { installPlugin, loadedPlugins, type LoadedPlugin } from '../src/main/agent/plugins/loader'
import { isPluginSkillPreviewPath } from '../src/main/agent/plugins/preview'
import { createRuntimeResourceLoader } from '../src/main/agent/runtime/runtime-adapter'

const VISUALIZATION_SOURCE = join(process.cwd(), 'resources', 'plugins', 'visualization')
const OFFICE_SOURCE = join(process.cwd(), 'resources', 'plugins', 'office')

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

function installOffice(root: string): {
  agentDir: string
  runtimeRoot: string
  plugin: LoadedPlugin
} {
  const agentDir = join(root, 'agent')
  const runtimeRoot = join(root, 'runtime')
  const result = installPlugin(OFFICE_SOURCE, { agentDir, runtimeRoot })
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

test('the visualization plugin has no private environment and uses phi-r', async () => {
  await withTemp((root) => {
    const { agentDir, plugin } = installVisualization(root)
    const platform = currentPlatform()
    assert.deepEqual(plugin.environments, {})
    const found = describeEnvironment('phi:r@1', { agentDir, platform })
    assert.equal(found.ref, 'phi:r@1')
    assert.equal(found.scope, 'phi')
    assert.equal(found.owner, undefined)
    assert.equal(found.kind, 'base')
    assert.equal(found.spec.name, 'phi-r')
    assert.match(found.lockText, /@EXPLICIT/)
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
    assert.equal(loader.options.additionalSkillFiles?.includes(join(skillDir, 'SKILL.md')), true)
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

test('office plugin installs five Python office skills without a private environment', async () => {
  await withTemp(async (root) => {
    installVisualization(root)
    const { agentDir, plugin } = installOffice(root)
    assert.equal(plugin.id, 'office')
    assert.equal(plugin.version, '1.0.1')
    assert.equal(plugin.manifest.title, '办公文档')
    assert.equal(
      plugin.manifest.summary,
      '使用托管 Python 生成和处理 Excel、Word、PowerPoint 与 PDF，并用原生 phi-office 对已打开文件做少量交互式修改。'
    )
    assert.equal(plugin.toolPrefix, 'officepy')
    assert.equal(Object.hasOwn(plugin.manifest, 'environments'), false)
    assert.deepEqual(plugin.components.agents, [])
    assert.equal(plugin.components.skills.length, 5)
    assert.deepEqual(
      loadedPlugins({ agentDir }).map((item) => item.toolPrefix),
      ['officepy', 'viz']
    )

    const loader = createRuntimeResourceLoader({ cwd: join(root, 'project'), agentDir })
    await loader.reload()
    const skills = loader.getSkills().skills.filter((skill) => skill.sourceInfo.origin === 'office')
    assert.deepEqual(skills.map((skill) => skill.name).sort(), [
      'docx',
      'office-workflow',
      'pdf',
      'pptx',
      'xlsx'
    ])
    assert.equal(
      skills.every((skill) => skill.sourceInfo.source === 'phi-plugin'),
      true
    )
  })
})

test('office plugin skills preserve old explicit skill enablement overrides', async () => {
  await withTemp(async (root) => {
    const agentDir = join(root, 'agent')
    writeEnablementState(
      {
        version: 1,
        global: { 'skill:xlsx': true, 'skill:pptx': false },
        projects: {}
      },
      { agentDir }
    )
    installOffice(root)

    const loader = createRuntimeResourceLoader({ cwd: join(root, 'project'), agentDir })
    await loader.reload()
    const officeSkills = loader
      .getSkills()
      .skills.filter((skill) => skill.sourceInfo.origin === 'office')
    const enabled = filterEnabledMainSkills(officeSkills, { agentDir })

    assert.deepEqual(enabled.map((skill) => skill.name).sort(), [
      'docx',
      'office-workflow',
      'pdf',
      'xlsx'
    ])
  })
})
