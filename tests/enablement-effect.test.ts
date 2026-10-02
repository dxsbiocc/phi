import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  filterEnabledMainSkills,
  filterMainScriptTools,
  isEnabled,
  selectDeclaredSpecialistSkills,
  setEnabled,
  writeEnablementState
} from '../src/main/agent/enablement'
import { installPlugin, loadedPlugins, setPluginEnabled } from '../src/main/agent/plugins/loader'
import { readPluginRegistry, writePluginRegistry } from '../src/main/agent/plugins/store'

const silentLogger = {
  info(message: string) {
    void message
  },
  warn(message: string) {
    void message
  }
}

interface TestSkill {
  name: string
  description: string
  filePath: string
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: string
    baseDir?: string
  }
}

function withScratch(
  run: (paths: { root: string; agentDir: string; projectDir: string }) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-enablement-effect-'))
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  try {
    run({ root, agentDir, projectDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function testSkills(root: string): TestSkill[] {
  const bundledRoot = join(root, 'resources', 'skills')
  const userRoot = join(root, 'agent', 'skills')
  return [
    {
      name: 'bundled-analysis',
      description: 'Bundled analysis fixture.',
      filePath: join(bundledRoot, 'bundled-analysis', 'SKILL.md'),
      sourceInfo: {
        source: 'bundled',
        scope: 'user',
        origin: 'resources',
        baseDir: bundledRoot
      }
    },
    {
      name: 'user-analysis',
      description: 'User analysis fixture.',
      filePath: join(userRoot, 'user-analysis', 'SKILL.md'),
      sourceInfo: {
        source: 'local',
        scope: 'user',
        origin: 'top-level',
        baseDir: userRoot
      }
    }
  ]
}

function writePluginFixture(root: string): string {
  const pluginDir = join(root, 'plugin-source')
  const skillDir = join(pluginDir, 'skills', 'plugin-analysis')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'phi-package.yaml'),
    `schemaVersion: 1
id: disabled-plugin
type: plugin
version: 1.0.0
title: Disabled plugin fixture
summary: Verifies enablement state hides installed plugin components.
toolPrefix: disable
components:
  skills: [skills/plugin-analysis]
`
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: plugin-analysis
description: Plugin-owned analysis fixture.
---
Use the plugin fixture.
`
  )
  return pluginDir
}

test('main skill filtering excludes a disabled bundled skill', () => {
  withScratch(({ root, agentDir, projectDir }) => {
    setEnabled('skill:bundled-analysis', false, { agentDir, logger: silentLogger })

    const filtered = filterEnabledMainSkills(testSkills(root), {
      agentDir,
      projectDir,
      logger: silentLogger
    })

    assert.deepEqual(
      filtered.map((skill) => skill.name),
      ['user-analysis']
    )
  })
})

test('main script-tool filtering excludes descriptors owned by disabled skills', () => {
  const tools = [
    {
      name: 'bundle_run',
      description: 'Run the bundled fixture.',
      parameters: { type: 'object' },
      attachTo: ['main'],
      skill: 'bundled-analysis',
      approval: 'read' as const
    },
    {
      name: 'user_run',
      description: 'Run the user fixture.',
      parameters: { type: 'object' },
      attachTo: ['main'],
      skill: 'user-analysis',
      approval: 'read' as const
    }
  ]

  const filtered = filterMainScriptTools(tools, ['user-analysis'])

  assert.deepEqual(
    filtered.map((tool) => tool.name),
    ['user_run']
  )
})

test('specialist skill selection keeps a declared skill disabled for the main agent', () => {
  withScratch(({ root, agentDir, projectDir }) => {
    setEnabled('skill:bundled-analysis', false, { agentDir, logger: silentLogger })
    assert.equal(
      isEnabled(
        { key: 'skill:bundled-analysis', source: 'bundled' },
        { agentDir, projectDir, logger: silentLogger }
      ),
      false
    )

    const selected = selectDeclaredSpecialistSkills(testSkills(root), ['bundled-analysis'])

    assert.deepEqual(
      selected.map((skill) => skill.name),
      ['bundled-analysis']
    )
  })
})

test('enabled.json hides plugin components even when plugins.json remains enabled', () => {
  withScratch(({ root, agentDir }) => {
    writeEnablementState(
      { version: 1, global: {}, projects: {} },
      { agentDir, logger: silentLogger }
    )
    const installed = installPlugin(writePluginFixture(root), {
      agentDir,
      runtimeRoot: join(root, 'runtime'),
      now: () => new Date('2026-10-02T00:00:00.000Z')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    const legacyRegistry = readPluginRegistry(agentDir)
    const legacyEntry = legacyRegistry.plugins['disabled-plugin']
    assert.ok(legacyEntry)
    writePluginRegistry(
      {
        ...legacyRegistry,
        plugins: {
          ...legacyRegistry.plugins,
          'disabled-plugin': { ...legacyEntry, enabled: true }
        }
      },
      agentDir
    )
    assert.equal(readPluginRegistry(agentDir).plugins['disabled-plugin']?.enabled, true)

    setEnabled('plugin:disabled-plugin', false, { agentDir, logger: silentLogger })

    const loaded = loadedPlugins({ agentDir })
    assert.deepEqual(
      loaded.map((plugin) => plugin.id),
      []
    )
    assert.deepEqual(
      loaded.flatMap((plugin) => plugin.components.agents),
      []
    )
    assert.deepEqual(
      loaded.flatMap((plugin) => plugin.components.skills),
      []
    )
    assert.equal(readPluginRegistry(agentDir).plugins['disabled-plugin']?.enabled, true)
  })
})

test('a project plugin override hides components only in that project', () => {
  withScratch(({ root, agentDir, projectDir }) => {
    writeEnablementState(
      { version: 1, global: {}, projects: {} },
      { agentDir, logger: silentLogger }
    )
    const installed = installPlugin(writePluginFixture(root), {
      agentDir,
      runtimeRoot: join(root, 'runtime')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))

    setEnabled('plugin:disabled-plugin', false, {
      agentDir,
      projectDir,
      logger: silentLogger
    })

    assert.deepEqual(
      loadedPlugins({ agentDir }).map((plugin) => plugin.id),
      ['disabled-plugin']
    )
    assert.deepEqual(loadedPlugins({ agentDir, projectDir }), [])
  })
})

test('an explicit project plugin override is kept when it matches the inherited value', () => {
  withScratch(({ root, agentDir, projectDir }) => {
    writeEnablementState(
      { version: 1, global: {}, projects: {} },
      { agentDir, logger: silentLogger }
    )
    assert.equal(
      installPlugin(writePluginFixture(root), {
        agentDir,
        runtimeRoot: join(root, 'runtime')
      }).ok,
      true
    )
    setEnabled('plugin:disabled-plugin', false, { agentDir, logger: silentLogger })

    assert.equal(setPluginEnabled('disabled-plugin', false, { agentDir, projectDir }).ok, true)
    setEnabled('plugin:disabled-plugin', true, { agentDir, logger: silentLogger })

    assert.deepEqual(loadedPlugins({ agentDir, projectDir }), [])
  })
})
