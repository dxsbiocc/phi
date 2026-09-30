import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'
import { currentPlatform } from '../src/main/agent/envs'
import { listBundledPlugins } from '../src/main/agent/plugins/bundled'
import { copyMinimal } from './helpers/fakeEnvironment'

function withTemp(body: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-bundled-plugins-'))
  return Promise.resolve()
    .then(() => body(root))
    .finally(() => {
      rmSync(root, { recursive: true, force: true })
    })
}

function writeAgent(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ntools:\n  - read\n---\n${description}\n`
  )
}

test('listBundledPlugins keeps valid ids and only existing component directories', async () => {
  await withTemp((root) => {
    writeFileSync(join(root, 'file-plugin'), '')
    mkdirSync(join(root, 'Bad'))
    mkdirSync(join(root, '9no'))
    mkdirSync(join(root, 'has_underscore'))
    mkdirSync(join(root, `a${'b'.repeat(64)}`))

    const alpha = join(root, 'alpha')
    mkdirSync(join(alpha, 'agents'), { recursive: true })
    mkdirSync(join(alpha, 'skills'), { recursive: true })
    mkdirSync(join(alpha, 'environments'), { recursive: true })
    mkdirSync(join(alpha, 'mcp'), { recursive: true })

    const beta = join(root, 'beta')
    mkdirSync(beta)
    writeFileSync(join(beta, 'agents'), 'not a directory')

    const gamma = join(root, 'gamma', 'skills')
    mkdirSync(gamma, { recursive: true })

    assert.deepEqual(listBundledPlugins(root), [
      {
        id: 'alpha',
        dir: alpha,
        agentsDir: join(alpha, 'agents'),
        skillsDir: join(alpha, 'skills'),
        environmentsDir: join(alpha, 'environments')
      },
      { id: 'beta', dir: beta },
      { id: 'gamma', dir: join(root, 'gamma'), skillsDir: gamma }
    ])
    assert.deepEqual(listBundledPlugins(join(root, 'missing')), [])
  })
})

test('describeEnvironment resolves plugin refs from a plugins directory', async () => {
  await withTemp((root) => {
    const platform = currentPlatform()
    copyMinimal(join(root, 'alpha', 'environments', 'viz'))

    const found = describeEnvironment('plugin:viz', { pluginsDir: root, platform })
    assert.equal(found.ref, 'plugin:viz')
    assert.equal(found.scope, 'plugin')
    assert.equal(found.owner, 'alpha')
    assert.equal(found.kind, 'package')
    assert.equal(found.spec.name, 'minimal')
    assert.equal(found.platform, platform)
    assert.match(found.lockText, /@EXPLICIT/)

    assert.throws(
      () => describeEnvironment('plugin:missing', { pluginsDir: root, platform }),
      /environment plugin:missing is not available/
    )

    copyMinimal(join(root, 'beta', 'environments', 'viz'))
    assert.throws(
      () => describeEnvironment('plugin:viz', { pluginsDir: root, platform }),
      /environment plugin:viz is provided by alpha and beta/
    )
  })
})

test('plugin:viz resolves to the visualization plugin environment', () => {
  const platform = currentPlatform()
  const descriptor = describeEnvironment('plugin:viz', { platform })
  const visualization = listBundledPlugins().find((plugin) => plugin.id === 'visualization')
  assert.ok(visualization?.agentsDir)
  assert.ok(visualization.skillsDir)
  assert.equal(visualization.toolPrefix, 'viz')
  assert.equal(
    visualization.environmentsDir,
    join(process.cwd(), 'resources', 'plugins', 'visualization', 'environments')
  )
  assert.equal(descriptor.ref, 'plugin:viz')
  assert.equal(descriptor.scope, 'plugin')
  assert.equal(descriptor.owner, 'visualization')
  assert.equal(descriptor.kind, 'package')
  assert.equal(descriptor.spec.name, 'viz')
  assert.equal(descriptor.platform, platform)
  assert.match(descriptor.lockText, /@EXPLICIT/)
  assert.match(
    descriptor.lockText,
    /resources\/plugins\/visualization\/environments\/viz\/environment\.yml/
  )
})

test('agent discovery finds Visualization from the plugin directory', () => {
  const filePath = join(
    process.cwd(),
    'resources',
    'plugins',
    'visualization',
    'agents',
    'Visualization.md'
  )
  const { agents } = discoverPhiAgents({
    cwd: '/nonexistent/cwd',
    agentDir: '/nonexistent/agentdir',
    bundledDir: join(process.cwd(), 'resources', 'agents'),
    homeDir: '/nonexistent/home'
  })
  const visualization = agents.find((agent) => agent.name === 'Visualization')
  assert.ok(visualization)
  assert.equal(visualization.source, 'phi')
  assert.equal(visualization.filePath, filePath)
})

test('a bundled agent keeps a name that a plugin agent also defines', async () => {
  await withTemp((root) => {
    const bundled = join(root, 'bundled-agents')
    const pluginAgents = join(root, 'plugins', 'alpha', 'agents')
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

test('skill loading lists omics-visualization as a bundled skill', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'phi-bundled-plugin-skills-'))
  try {
    const { createRuntimeResourceLoader } =
      await import('../src/main/agent/runtime/runtime-adapter')
    const { deleteSkill, listSkills } = await import('../src/main/agent/resources')
    const skillsDir = listBundledPlugins().find(
      (plugin) => plugin.id === 'visualization'
    )?.skillsDir
    assert.ok(skillsDir)
    const loader = createRuntimeResourceLoader({ cwd, agentDir: cwd })
    assert.equal(loader.options.additionalSkillPaths?.includes(skillsDir), true)

    const skills = await listSkills(cwd)
    const skill = skills.find(
      (item) =>
        item.name === 'omics-visualization' &&
        item.filePath.includes(join('plugins', 'visualization', 'skills', 'omics-visualization'))
    )
    assert.ok(skill)
    assert.equal(skill.source, 'bundled')
    assert.equal(skill.sourceCategory, 'system')
    await assert.rejects(() => deleteSkill(skill.filePath, cwd), /System skills cannot be deleted/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
