import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'

import { computeEnvId, readEnvironmentIndex, updateEnvironmentEntry } from '../src/main/agent/envs'
import { installBundledPlugins } from '../src/main/agent/plugins/bundled-install'
import {
  installPlugin,
  listInstalledPlugins,
  loadedPlugins,
  setPluginEnabled,
  uninstallPlugin,
  upgradePlugin,
  type PluginEnvironmentBuilder
} from '../src/main/agent/plugins/loader'
import {
  pluginRegistryPath,
  pluginVersionDir,
  readPluginRegistry
} from '../src/main/agent/plugins/store'
import { copyMinimal, installReady } from './helpers/fakeEnvironment'
import { describeEnvironment } from '../src/main/agent/content/environment-refs'

const PLATFORM = 'darwin-arm64' as const
const MD5 = '0123456789abcdef0123456789abcdef'

interface FixtureOptions {
  id?: string
  version?: string
  agentName?: string
  skillName?: string
  toolPrefix?: string
  environmentName?: string
  lockSalt?: string
  withEnvironment?: boolean
}

function writePlugin(root: string, options: FixtureOptions = {}): string {
  const id = options.id ?? 'alpha-plugin'
  const version = options.version ?? '1.0.0'
  const agentName = options.agentName ?? 'Alpha'
  const skillName = options.skillName ?? 'alpha-skill'
  const toolPrefix = options.toolPrefix ?? 'alph'
  const environmentName = options.environmentName ?? 'alpha-env'
  const withEnvironment = options.withEnvironment ?? true
  const environmentRef = withEnvironment ? `plugin:${environmentName}` : 'phi:python@1'
  const dir = join(root, `${id}-${version}-${Math.random().toString(16).slice(2)}`)
  const skillDir = join(dir, 'skills', skillName)
  const environmentDir = join(dir, 'environments', environmentName)
  mkdirSync(join(dir, 'agents'), { recursive: true })
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  mkdirSync(join(skillDir, 'scripts', '__pycache__'), { recursive: true })
  mkdirSync(join(skillDir, 'work'), { recursive: true })
  mkdirSync(join(skillDir, 'results'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })

  writeFileSync(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id,
      type: 'plugin',
      version,
      title: `${agentName} plugin`,
      summary: `Fixture for ${id}.`,
      toolPrefix,
      components: {
        agents: [`agents/${agentName}.md`],
        skills: [`skills/${skillName}`]
      },
      ...(withEnvironment
        ? {
            environments: {
              [environmentName]: { spec: `environments/${environmentName}/environment.yml` }
            }
          }
        : {})
    })
  )
  writeFileSync(join(dir, 'README.md'), `# ${agentName}\n`)
  writeFileSync(
    join(dir, 'agents', `${agentName}.md`),
    `---
name: ${agentName}
description: ${agentName} fixture agent.
tools: [bash]
skills: [${skillName}]
environment: ${environmentRef}
---
Run the fixture skill and report the result.
`
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: ${skillName}
description: Fixture plugin skill.
phi:
  environment: ${environmentRef}
  attachTo: [${agentName}]
  scripts:
    - name: run
      description: Run the fixture.
      run: [python, ./scripts/run.py]
      args:
        type: object
        additionalProperties: false
        properties: {}
      approval: read
---
Use this fixture skill.
`
  )
  writeFileSync(join(skillDir, 'scripts', 'run.py'), 'print({"ok": True})\n')
  writeFileSync(join(skillDir, 'references', 'keep.md'), 'keep\n')
  writeFileSync(join(skillDir, '.DS_Store'), 'noise\n')
  writeFileSync(join(skillDir, '.nextflow.log'), 'noise\n')
  writeFileSync(join(skillDir, 'scripts', '__pycache__', 'cache.pyc'), 'noise\n')
  writeFileSync(join(skillDir, 'work', 'run.txt'), 'noise\n')
  writeFileSync(join(skillDir, 'results', 'result.txt'), 'noise\n')
  writeFileSync(join(dir, 'assets', 'palette.json'), '{}\n')
  writeFileSync(join(dir, 'not-allowlisted.txt'), 'must not be copied\n')

  if (withEnvironment) copyMinimal(environmentDir, environmentName)
  if (withEnvironment && options.lockSalt) {
    const lockPath = join(environmentDir, 'locks', `${PLATFORM}.txt`)
    writeFileSync(
      lockPath,
      `${readFileSync(lockPath, 'utf8').trimEnd()}\nhttps://example.invalid/${options.lockSalt}.conda#${MD5}\n`
    )
  }
  return dir
}

function withSandbox(
  run: (root: string, agentDir: string, runtimeRoot: string) => Promise<void> | void
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-plugin-loader-'))
  const agentDir = join(root, 'agent')
  const runtimeRoot = join(root, 'runtime')
  return Promise.resolve(run(root, agentDir, runtimeRoot)).finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

test('install copies only allowlisted package files and records an environment referrer', async () => {
  await withSandbox((root, agentDir, runtimeRoot) => {
    const source = writePlugin(root)
    const installed = installPlugin(source, {
      agentDir,
      runtimeRoot,
      platform: PLATFORM,
      now: () => new Date('2026-10-01T00:00:00.000Z')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    assert.equal(installed.plugin?.dir, pluginVersionDir('alpha-plugin', '1.0.0', agentDir))

    const destination = installed.plugin?.dir ?? ''
    assert.equal(existsSync(join(destination, 'README.md')), true)
    assert.equal(
      existsSync(join(destination, 'skills', 'alpha-skill', 'references', 'keep.md')),
      true
    )
    assert.equal(existsSync(join(destination, 'assets', 'palette.json')), true)
    assert.equal(existsSync(join(destination, 'not-allowlisted.txt')), false)
    assert.equal(existsSync(join(destination, 'skills', 'alpha-skill', '.DS_Store')), false)
    assert.equal(existsSync(join(destination, 'skills', 'alpha-skill', '.nextflow.log')), false)
    assert.equal(
      existsSync(join(destination, 'skills', 'alpha-skill', 'scripts', '__pycache__')),
      false
    )
    assert.equal(existsSync(join(destination, 'skills', 'alpha-skill', 'work')), false)
    assert.equal(existsSync(join(destination, 'skills', 'alpha-skill', 'results')), false)

    const registry = readPluginRegistry(agentDir)
    assert.deepEqual(registry.plugins['alpha-plugin'], {
      version: '1.0.0',
      source: 'local',
      installedAt: '2026-10-01T00:00:00.000Z'
    })
    assert.equal(JSON.parse(readFileSync(pluginRegistryPath(agentDir), 'utf8')).version, 1)
    assert.deepEqual(
      readdirSync(join(agentDir, 'packages')).filter((name) => name.endsWith('.tmp')),
      []
    )

    const index = readEnvironmentIndex(runtimeRoot)
    const entries = Object.entries(index.environments)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.[1].status, 'absent')
    assert.deepEqual(entries[0]?.[1].referrers, ['plugin:alpha-plugin'])
    assert.deepEqual(
      loadedPlugins({ agentDir }).map((plugin) => plugin.id),
      ['alpha-plugin']
    )
  })
})

test('enablement is persisted and loaded-plugin namespace clashes are no-ops', async () => {
  await withSandbox((root, agentDir, runtimeRoot) => {
    const options = { agentDir, runtimeRoot, platform: PLATFORM }
    const initial = installPlugin(writePlugin(root), options)
    assert.equal(initial.ok, true, JSON.stringify(initial.errors))
    assert.equal(setPluginEnabled('alpha-plugin', false, options).ok, true)
    assert.deepEqual(loadedPlugins({ agentDir }), [])
    assert.equal(listInstalledPlugins({ agentDir })[0]?.enabled, false)
    assert.equal(setPluginEnabled('alpha-plugin', true, options).ok, true)

    const agentClash = installPlugin(
      writePlugin(root, {
        id: 'agent-clash',
        agentName: 'Alpha',
        skillName: 'agent-clash-skill',
        toolPrefix: 'agcl'
      }),
      options
    )
    assert.equal(agentClash.ok, false)
    assert.match(agentClash.errors[0]?.message ?? '', /agent name 'Alpha'/)

    const skillClash = installPlugin(
      writePlugin(root, {
        id: 'skill-clash',
        agentName: 'SkillClash',
        skillName: 'alpha-skill',
        toolPrefix: 'skcl'
      }),
      options
    )
    assert.equal(skillClash.ok, false)
    assert.match(skillClash.errors[0]?.message ?? '', /skill name 'alpha-skill'/)

    const prefixClash = installPlugin(
      writePlugin(root, {
        id: 'prefix-clash',
        agentName: 'PrefixClash',
        skillName: 'prefix-clash-skill',
        toolPrefix: 'alph'
      }),
      options
    )
    assert.equal(prefixClash.ok, false)
    assert.match(prefixClash.errors[0]?.message ?? '', /toolPrefix 'alph'/)

    const standaloneClash = installPlugin(
      writePlugin(root, {
        id: 'standalone-clash',
        agentName: 'StandaloneClash',
        skillName: 'standalone-clash-skill',
        toolPrefix: 'solo'
      }),
      { ...options, names: { toolPrefixes: ['solo'] } }
    )
    assert.equal(standaloneClash.ok, false)
    assert.deepEqual(Object.keys(readPluginRegistry(agentDir).plugins), ['alpha-plugin'])
    assert.equal(existsSync(join(agentDir, 'packages', 'plugin', 'agent-clash')), false)
  })
})

test('upgrade builds changed environments before switching and rolls back a failed build', async () => {
  await withSandbox(async (root, agentDir, runtimeRoot) => {
    const options = { agentDir, runtimeRoot, platform: PLATFORM }
    const original = writePlugin(root)
    const initial = installPlugin(original, options)
    assert.equal(initial.ok, true, JSON.stringify(initial.errors))
    const oldIndex = readEnvironmentIndex(runtimeRoot)
    const oldEnvId = Object.keys(oldIndex.environments)[0] ?? ''
    // The user had built the old environment, so the upgrade must build the new one first.
    installReady(
      runtimeRoot,
      describeEnvironment('plugin:alpha-env', {
        pluginId: 'alpha-plugin',
        agentDir,
        platform: PLATFORM
      }),
      {}
    )

    const built: string[] = []
    const build: PluginEnvironmentBuilder = async (descriptor) => {
      built.push(
        computeEnvId({
          scope: descriptor.scope,
          owner: descriptor.owner,
          name: descriptor.spec.name,
          platform: descriptor.platform,
          lockText: descriptor.lockText,
          sourcePackages: descriptor.spec.sourcePackages
        })
      )
      installReady(runtimeRoot, descriptor, {})
    }
    let gcCalls = 0
    const upgraded = await upgradePlugin(
      writePlugin(root, { version: '1.1.0', lockSalt: 'upgrade-one' }),
      { ...options, build, garbageCollect: () => void (gcCalls += 1) }
    )
    assert.equal(upgraded.ok, true)
    assert.equal(upgraded.plugin?.version, '1.1.0')
    assert.equal(built.length, 1)
    assert.notEqual(built[0], oldEnvId)
    assert.equal(gcCalls, 1)
    assert.equal(existsSync(pluginVersionDir('alpha-plugin', '1.0.0', agentDir)), false)
    assert.equal(existsSync(pluginVersionDir('alpha-plugin', '1.1.0', agentDir)), true)
    assert.deepEqual(readEnvironmentIndex(runtimeRoot).environments[built[0]]?.referrers, [
      'plugin:alpha-plugin'
    ])
    assert.deepEqual(readEnvironmentIndex(runtimeRoot).environments[oldEnvId]?.referrers, [])

    await assert.rejects(
      upgradePlugin(writePlugin(root, { version: '1.2.0', lockSalt: 'upgrade-two' }), {
        ...options,
        build: async () => {
          throw new Error('fixture build failed')
        },
        garbageCollect: () => void (gcCalls += 1)
      }),
      /fixture build failed/
    )
    assert.equal(readPluginRegistry(agentDir).plugins['alpha-plugin']?.version, '1.1.0')
    assert.equal(existsSync(pluginVersionDir('alpha-plugin', '1.1.0', agentDir)), true)
    assert.equal(existsSync(pluginVersionDir('alpha-plugin', '1.2.0', agentDir)), false)
    assert.equal(loadedPlugins({ agentDir })[0]?.version, '1.1.0')
    assert.equal(gcCalls, 2)
  })
})

test('upgrade to a plugin without environments drops the old referrer and garbage-collects it', async () => {
  await withSandbox(async (root, agentDir, runtimeRoot) => {
    const options = { agentDir, runtimeRoot, platform: PLATFORM }
    assert.equal(installPlugin(writePlugin(root), options).ok, true)
    const descriptor = describeEnvironment('plugin:alpha-env', {
      pluginId: 'alpha-plugin',
      agentDir,
      platform: PLATFORM
    })
    const oldEnvId = installReady(runtimeRoot, descriptor, {})
    const oldPrefix = join(runtimeRoot, 'envs', oldEnvId)
    updateEnvironmentEntry(runtimeRoot, oldEnvId, { status: 'ready' })

    const upgraded = await upgradePlugin(
      writePlugin(root, { version: '1.1.0', withEnvironment: false }),
      options
    )

    assert.equal(upgraded.ok, true, JSON.stringify(upgraded.errors))
    assert.deepEqual(upgraded.plugin?.environments, {})
    assert.equal(readEnvironmentIndex(runtimeRoot).environments[oldEnvId], undefined)
    assert.equal(existsSync(oldPrefix), false)
  })
})

test('uninstall unregisters files and referrers, then runs garbage collection', async () => {
  await withSandbox((root, agentDir, runtimeRoot) => {
    const options = { agentDir, runtimeRoot, platform: PLATFORM }
    const initial = installPlugin(writePlugin(root), options)
    assert.equal(initial.ok, true, JSON.stringify(initial.errors))
    const envId = Object.keys(readEnvironmentIndex(runtimeRoot).environments)[0] ?? ''
    let collectedRoot = ''
    const removed = uninstallPlugin('alpha-plugin', {
      ...options,
      garbageCollect: (nextRoot) => {
        collectedRoot = nextRoot
        return { removed: [], orphans: [], skipped: [], logsRemoved: 0 }
      }
    })
    assert.equal(removed.ok, true)
    assert.equal(collectedRoot, runtimeRoot)
    assert.deepEqual(readPluginRegistry(agentDir).plugins, {})
    assert.deepEqual(readEnvironmentIndex(runtimeRoot).environments[envId]?.referrers, [])
    assert.equal(existsSync(join(agentDir, 'packages', 'plugin', 'alpha-plugin')), false)
    assert.deepEqual(listInstalledPlugins({ agentDir }), [])
  })
})

test('bundled install upgrades newer versions and respects a bundled-uninstall tombstone', async () => {
  await withSandbox(async (root, agentDir, runtimeRoot) => {
    const bundledDir = join(root, 'bundled')
    mkdirSync(bundledDir, { recursive: true })
    let source = writePlugin(root, { id: 'bundled-plugin' })
    const target = join(bundledDir, 'bundled-plugin')
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) {
      const sourcePath = join(source, name)
      const targetPath = join(target, name)
      const stat = statSync(sourcePath)
      if (stat.isDirectory()) {
        cpSync(sourcePath, targetPath, { recursive: true })
      } else {
        writeFileSync(targetPath, readFileSync(sourcePath))
      }
    }
    const options = {
      bundledDir,
      agentDir,
      runtimeRoot,
      platform: PLATFORM,
      build: (async () => undefined) as PluginEnvironmentBuilder,
      garbageCollect: () => ({ removed: [], orphans: [], skipped: [], logsRemoved: 0 })
    }
    const first = await installBundledPlugins(options)
    assert.deepEqual(
      first.installed.map((plugin) => plugin.id),
      ['bundled-plugin'],
      JSON.stringify(first.errors)
    )
    assert.equal(first.errors.length, 0)
    assert.equal(readPluginRegistry(agentDir).plugins['bundled-plugin']?.source, 'bundled')

    rmSync(target, { recursive: true, force: true })
    source = writePlugin(root, {
      id: 'bundled-plugin',
      version: '1.1.0',
      lockSalt: 'bundled-upgrade'
    })
    cpSync(source, target, { recursive: true })
    const second = await installBundledPlugins(options)
    assert.deepEqual(
      second.upgraded.map((plugin) => plugin.version),
      ['1.1.0']
    )
    assert.equal(readPluginRegistry(agentDir).plugins['bundled-plugin']?.version, '1.1.0')

    assert.equal(uninstallPlugin('bundled-plugin', options).ok, true)
    assert.equal(readPluginRegistry(agentDir).plugins['bundled-plugin']?.uninstalledBundled, true)
    assert.deepEqual(listInstalledPlugins({ agentDir }), [])

    rmSync(target, { recursive: true, force: true })
    cpSync(
      writePlugin(root, { id: 'bundled-plugin', version: '1.2.0', lockSalt: 'newer-bundle' }),
      target,
      { recursive: true }
    )
    const third = await installBundledPlugins(options)
    assert.deepEqual(third.skipped, ['bundled-plugin'])
    assert.deepEqual(third.installed, [])
    assert.deepEqual(third.upgraded, [])
    assert.equal(existsSync(pluginVersionDir('bundled-plugin', '1.2.0', agentDir)), false)
  })
})

test('upgrade does not build an environment the user never built; it builds on first use', async () => {
  await withSandbox(async (root, agentDir, runtimeRoot) => {
    const options = { agentDir, runtimeRoot, platform: PLATFORM }
    assert.equal(installPlugin(writePlugin(root), options).ok, true)
    let builds = 0
    const upgraded = await upgradePlugin(
      writePlugin(root, { version: '1.1.0', lockSalt: 'never-built' }),
      {
        ...options,
        build: async () => {
          builds += 1
        },
        garbageCollect: () => undefined
      }
    )
    assert.equal(upgraded.ok, true, JSON.stringify(upgraded.errors))
    assert.equal(builds, 0)
    assert.equal(readPluginRegistry(agentDir).plugins['alpha-plugin']?.version, '1.1.0')
  })
})

test('the install phase installs missing bundled plugins and never upgrades', async () => {
  await withSandbox(async (root, agentDir, runtimeRoot) => {
    const bundledDir = join(root, 'bundled')
    const place = (version: string): void => {
      const source = writePlugin(root, { id: 'phase-plugin', version })
      rmSync(join(bundledDir, 'phase-plugin'), { recursive: true, force: true })
      cpSync(source, join(bundledDir, 'phase-plugin'), { recursive: true })
    }
    const options = {
      bundledDir,
      agentDir,
      runtimeRoot,
      platform: PLATFORM,
      build: (async () => undefined) as PluginEnvironmentBuilder,
      garbageCollect: () => ({ removed: [], orphans: [], skipped: [], logsRemoved: 0 })
    }
    place('1.0.0')
    assert.equal(
      (await installBundledPlugins({ ...options, phase: 'upgrade' })).installed.length,
      0
    )
    const installed = await installBundledPlugins({ ...options, phase: 'install' })
    assert.deepEqual(
      installed.installed.map((plugin) => plugin.id),
      ['phase-plugin']
    )
    place('1.1.0')
    const skipped = await installBundledPlugins({ ...options, phase: 'install' })
    assert.equal(skipped.upgraded.length, 0)
    assert.equal(readPluginRegistry(agentDir).plugins['phase-plugin']?.version, '1.0.0')
    const upgraded = await installBundledPlugins({ ...options, phase: 'upgrade' })
    assert.deepEqual(
      upgraded.upgraded.map((plugin) => plugin.version),
      ['1.1.0']
    )
  })
})
