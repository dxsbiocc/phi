import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPhiPluginListItem } from '../../src/main/agent/plugins/details'
import type { LoadedPlugin } from '../../src/main/agent/plugins/loader'
import { validatePlugin, type ValidatedPlugin } from '../../src/main/agent/plugins/validate'
import { packageContentPath } from '../helpers/packageContent'

function loadedPlugin(
  plugin: ValidatedPlugin,
  overrides: Partial<LoadedPlugin> = {}
): LoadedPlugin {
  return {
    id: plugin.manifest.id,
    version: plugin.manifest.version,
    enabled: true,
    source: 'local',
    installedAt: '2026-10-07T00:00:00.000Z',
    dir: plugin.dir,
    manifest: plugin.manifest,
    agents: plugin.agents,
    skills: plugin.skills,
    environments: plugin.environments,
    toolPrefix: plugin.manifest.toolPrefix,
    components: { agents: [], skills: [] },
    ...overrides
  }
}

function publicVisualization(): LoadedPlugin {
  const result = validatePlugin(packageContentPath('plugins', 'visualization'))
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.plugin)
  return loadedPlugin(result.plugin)
}

test('the public Visualization plugin validates without errors', () => {
  const result = validatePlugin(packageContentPath('plugins', 'visualization'))
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.errors, [])
  assert.ok(result.plugin)
  assert.equal(result.plugin.manifest.id, 'visualization')
})

test('visualization details attribute phi-r to its skill and agent', () => {
  const item = buildPhiPluginListItem(publicVisualization())

  assert.deepEqual(item.usedEnvironments, [
    {
      ref: 'phi:r@1',
      name: 'phi-r',
      scope: 'builtin',
      skillNames: ['omics-visualization'],
      agentNames: ['Visualization']
    }
  ])
  assert.match(item.agentDetails?.[0]?.description ?? '', /template-guided/)
  assert.equal(item.skillDetails?.[0]?.enabled, true)
})
