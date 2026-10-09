import assert from 'node:assert/strict'
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
import { join } from 'node:path'
import test from 'node:test'

import { stringify } from 'yaml'

import { installVisualizationSmokePlugin } from '../scripts/runtime/install-smoke-visualization'
import { buildPhiPluginListItem } from '../src/main/agent/plugins/details'
import { listInstalledPlugins, loadedPlugins } from '../src/main/agent/plugins/loader'
import { pluginRegistryPath, readPluginRegistry } from '../src/main/agent/plugins/store'

function writeVisualizationFixture(sourceRoot: string): string {
  const source = join(sourceRoot, 'resources/plugins/visualization')
  const skill = join(source, 'skills/omics-visualization')
  mkdirSync(join(source, 'agents'), { recursive: true })
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(
    join(source, 'phi-package.yaml'),
    stringify({
      schemaVersion: 1,
      id: 'visualization',
      type: 'plugin',
      version: '1.2.3',
      title: 'Visualization smoke fixture',
      summary: 'Tests explicit installation into an isolated account.',
      toolPrefix: 'viz',
      components: {
        agents: ['agents/Visualization.md'],
        skills: ['skills/omics-visualization']
      }
    })
  )
  writeFileSync(
    join(source, 'agents/Visualization.md'),
    '---\nname: Visualization\ndescription: Fixture visualization agent.\nenvironment: phi:r@1\ntools: [read]\nskills: [omics-visualization]\n---\nRead the installed fixture skill.\n'
  )
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\n${stringify({
      name: 'omics-visualization',
      description: 'Fixture visualization skill.',
      phi: {
        environment: 'phi:r@1',
        attachTo: ['Visualization'],
        scripts: ['render', 'templates', 'preview', 'qa'].map((name) => ({
          name,
          description: `Fixture ${name} tool.`,
          run: ['python', './scripts/run.py'],
          args: { type: 'object', properties: {}, additionalProperties: false },
          approval: 'read'
        }))
      }
    })}---\nUse the installed fixture.\n`
  )
  writeFileSync(join(skill, 'scripts/run.py'), 'print("fixture")\n')
  return source
}

test('explicit smoke setup registers an isolated installed copy with the expected plugin details', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-smoke-setup-'))
  const previous = process.env.PHI_PACKAGES_ROOT
  try {
    process.env.PHI_PACKAGES_ROOT = join(root, 'missing-configured-source')
    const sourceRoot = join(root, 'selected-source')
    const source = writeVisualizationFixture(sourceRoot)
    const agentDir = join(root, 'isolated-agent')
    assert.deepEqual(listInstalledPlugins({ agentDir }), [])

    const installed = installVisualizationSmokePlugin({ agentDir, sourceRoot })
    assert.equal(installed.dir, join(agentDir, 'packages/plugin/visualization/1.2.3'))
    assert.equal(readPluginRegistry(agentDir).plugins.visualization?.version, '1.2.3')
    assert.equal(
      readFileSync(join(installed.dir, 'skills/omics-visualization/scripts/run.py'), 'utf8'),
      'print("fixture")\n'
    )
    rmSync(source, { recursive: true })

    const active = loadedPlugins({ agentDir })
    assert.deepEqual(
      active.map((plugin) => plugin.id),
      ['visualization']
    )
    const details = buildPhiPluginListItem(active[0])
    assert.equal(details.agentDetails?.length, 1)
    assert.equal(details.skillDetails?.length, 1)
    assert.equal(details.scriptToolDetails?.length, 4)
    assert.deepEqual(details.usedEnvironments, [
      {
        ref: 'phi:r@1',
        name: 'phi-r',
        scope: 'builtin',
        skillNames: ['omics-visualization'],
        agentNames: ['Visualization']
      }
    ])
  } finally {
    if (previous === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('configured source setup still writes only to the explicit smoke account', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-smoke-env-'))
  const previousSource = process.env.PHI_PACKAGES_ROOT
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  try {
    const sourceRoot = join(root, 'configured-source')
    writeVisualizationFixture(sourceRoot)
    const userAgent = join(root, 'default-user-account')
    mkdirSync(userAgent)
    writeFileSync(join(userAgent, 'preserved.txt'), 'user state')
    process.env.PHI_PACKAGES_ROOT = sourceRoot
    process.env.PI_CODING_AGENT_DIR = userAgent
    const agentDir = join(root, 'isolated-agent')

    installVisualizationSmokePlugin({ agentDir })

    assert.deepEqual(
      listInstalledPlugins({ agentDir }).map((plugin) => plugin.id),
      ['visualization']
    )
    assert.deepEqual(readdirSync(userAgent), ['preserved.txt'])
    assert.equal(readFileSync(join(userAgent, 'preserved.txt'), 'utf8'), 'user state')
  } finally {
    if (previousSource === undefined) delete process.env.PHI_PACKAGES_ROOT
    else process.env.PHI_PACKAGES_ROOT = previousSource
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing, invalid and misidentified visualization sources fail without changing the account', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-smoke-invalid-'))
  try {
    const agentDir = join(root, 'isolated-agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'preserved.txt'), 'existing account state')
    const missing = join(root, 'missing-source')
    const invalidRoot = join(root, 'invalid-source')
    const invalid = writeVisualizationFixture(invalidRoot)
    writeFileSync(join(invalid, 'skills/omics-visualization/SKILL.md'), 'invalid skill')
    const wrongRoot = join(root, 'wrong-source')
    const wrong = writeVisualizationFixture(wrongRoot)
    writeFileSync(
      join(wrong, 'phi-package.yaml'),
      readFileSync(join(wrong, 'phi-package.yaml'), 'utf8').replace(
        'id: visualization',
        'id: other-plugin'
      )
    )

    for (const sourceRoot of [missing, invalidRoot, wrongRoot]) {
      assert.throws(() => installVisualizationSmokePlugin({ agentDir, sourceRoot }))
      assert.deepEqual(readdirSync(agentDir), ['preserved.txt'])
      assert.equal(readFileSync(join(agentDir, 'preserved.txt'), 'utf8'), 'existing account state')
      assert.equal(existsSync(join(agentDir, 'packages')), false)
      assert.equal(existsSync(join(agentDir, 'runtime')), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt existing enablement is rejected without account changes or default-user logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-smoke-corrupt-state-'))
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  try {
    const sourceRoot = join(root, 'source')
    writeVisualizationFixture(sourceRoot)
    const userAgent = join(root, 'default-user-account')
    mkdirSync(userAgent)
    writeFileSync(join(userAgent, 'preserved.txt'), 'user state')
    process.env.PI_CODING_AGENT_DIR = userAgent
    const invalidStates = [
      '{not-json}\n',
      '{"version":1,"global":{"plugin:visualization":"yes"},"projects":{}}\n'
    ]
    for (const [index, state] of invalidStates.entries()) {
      const agentDir = join(root, `isolated-agent-${index}`)
      mkdirSync(join(agentDir, 'state'), { recursive: true })
      const enabledPath = join(agentDir, 'state/enabled.json')
      writeFileSync(enabledPath, state)

      assert.throws(
        () => installVisualizationSmokePlugin({ agentDir, sourceRoot }),
        /invalid enablement state/i
      )
      assert.equal(readFileSync(enabledPath, 'utf8'), state)
      assert.deepEqual(readdirSync(agentDir), ['state'])
      assert.equal(existsSync(join(agentDir, 'packages')), false)
      assert.equal(existsSync(join(agentDir, 'runtime')), false)
      assert.deepEqual(readdirSync(userAgent), ['preserved.txt'])
      assert.equal(readFileSync(join(userAgent, 'preserved.txt'), 'utf8'), 'user state')
    }
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    rmSync(root, { recursive: true, force: true })
  }
})

test('an installation failure preserves installed payload, registry and enablement without user logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-viz-smoke-install-failure-'))
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  try {
    const sourceRoot = join(root, 'source')
    writeVisualizationFixture(sourceRoot)
    const userAgent = join(root, 'default-user-account')
    mkdirSync(userAgent)
    writeFileSync(join(userAgent, 'preserved.txt'), 'user state')
    process.env.PI_CODING_AGENT_DIR = userAgent
    const agentDir = join(root, 'isolated-agent')
    const installed = installVisualizationSmokePlugin({ agentDir, sourceRoot })
    const enabledPath = join(agentDir, 'state/enabled.json')
    const scriptPath = join(installed.dir, 'skills/omics-visualization/scripts/run.py')
    const before = {
      enablement: readFileSync(enabledPath),
      registry: readFileSync(pluginRegistryPath(agentDir)),
      script: readFileSync(scriptPath),
      entries: readdirSync(agentDir)
    }

    assert.throws(
      () => installVisualizationSmokePlugin({ agentDir, sourceRoot }),
      /already installed; use upgrade/
    )
    assert.deepEqual(readFileSync(enabledPath), before.enablement)
    assert.deepEqual(readFileSync(pluginRegistryPath(agentDir)), before.registry)
    assert.deepEqual(readFileSync(scriptPath), before.script)
    assert.deepEqual(readdirSync(agentDir), before.entries)
    assert.deepEqual(readdirSync(userAgent), ['preserved.txt'])
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    rmSync(root, { recursive: true, force: true })
  }
})
