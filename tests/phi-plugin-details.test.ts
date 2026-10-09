import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import type { ValidatedSkill } from '../src/main/agent/content/skill'
import {
  buildPhiPluginListItem,
  PLUGIN_DETAIL_IPC_STRING_LIMITS
} from '../src/main/agent/plugins/details'
import type { LoadedPlugin } from '../src/main/agent/plugins/loader'
import { validatePlugin, type ValidatedPlugin } from '../src/main/agent/plugins/validate'

const REPO_ROOT = join(import.meta.dirname, '..')

function loadedPlugin(
  plugin: ValidatedPlugin,
  overrides: Partial<LoadedPlugin> = {}
): LoadedPlugin {
  return {
    id: plugin.manifest.id,
    version: plugin.manifest.version,
    enabled: true,
    source: 'bundled',
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

function bundledPlugin(name: string): LoadedPlugin {
  const result = validatePlugin(join(REPO_ROOT, 'resources', 'plugins', name))
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.plugin)
  return loadedPlugin(result.plugin)
}

function agent(name: string, environment?: string): PhiAgentDefinition {
  return {
    name,
    description: `${name} description`,
    tools: ['read'],
    skills: [],
    ...(environment ? { environment } : {}),
    visibility: 'entry',
    warnings: [],
    systemPrompt: 'Prompt.',
    source: 'phi',
    filePath: `/agents/${name}.md`
  }
}

function skill(name: string, description = `${name} description`): ValidatedSkill {
  return {
    dir: `/skills/${name}`,
    name,
    description,
    body: 'Instructions.',
    frontmatter: { name, description }
  }
}

function localEnvironmentSkill(name: string): ValidatedSkill {
  const item = skill(name)
  return {
    ...item,
    phi: { environment: './environment.yml' },
    frontmatter: { ...item.frontmatter, phi: { environment: './environment.yml' } },
    environment: { kind: 'path', path: './environment.yml' }
  }
}

function barePlugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'detail-fixture',
    version: '1.0.0',
    enabled: true,
    source: 'local',
    installedAt: '2026-10-07T00:00:00.000Z',
    dir: '/plugins/detail-fixture',
    manifest: {
      schemaVersion: 1,
      id: 'detail-fixture',
      type: 'plugin',
      version: '1.0.0',
      title: 'Detail fixture',
      summary: 'Fixture summary.',
      toolPrefix: 'detl',
      components: { agents: [], skills: [] }
    },
    agents: [],
    skills: [],
    environments: {},
    toolPrefix: 'detl',
    components: { agents: [], skills: [] },
    ...overrides
  }
}

test('office details expose five skills, six final tools and shared Python consumers', () => {
  const item = buildPhiPluginListItem(bundledPlugin('office'), {
    isSkillEnabled: (name) => name !== 'pdf'
  })

  assert.equal(item.skillDetails?.length, 5)
  assert.ok(item.skillDetails?.every((entry) => entry.description.length > 0))
  assert.equal(item.skillDetails?.find((entry) => entry.name === 'pdf')?.enabled, false)
  assert.ok(
    item.skillDetails?.every((entry) => entry.environmentRef === 'phi:python@1'),
    JSON.stringify(item.skillDetails)
  )

  assert.equal(item.scriptToolDetails?.length, 6)
  assert.ok(item.scriptToolDetails?.every((entry) => entry.description.length > 0))
  assert.deepEqual(
    item.scriptToolDetails?.map(({ name, approval, skillName }) => ({
      name,
      approval,
      skillName
    })),
    [
      { name: 'officepy_check_formulas', approval: 'read', skillName: 'xlsx' },
      { name: 'officepy_check_runtime', approval: 'read', skillName: 'office-workflow' },
      { name: 'officepy_docx_inspect', approval: 'read', skillName: 'docx' },
      { name: 'officepy_extract_text', approval: 'read', skillName: 'office-workflow' },
      { name: 'officepy_pdf_inspect', approval: 'read', skillName: 'pdf' },
      { name: 'officepy_render_pages', approval: 'write', skillName: 'pdf' }
    ]
  )
  assert.deepEqual(item.usedEnvironments, [
    {
      ref: 'phi:python@1',
      name: 'phi-python',
      scope: 'builtin',
      skillNames: ['docx', 'office-workflow', 'pdf', 'pptx', 'xlsx'],
      agentNames: []
    }
  ])

  assert.deepEqual(item.skills, ['docx', 'office-workflow', 'pdf', 'pptx', 'xlsx'])
  assert.deepEqual(
    item.scriptTools,
    item.scriptToolDetails?.map((entry) => entry.name)
  )
  assert.deepEqual(item.agents, [])
  assert.deepEqual(item.environments, [])
})

test('details group agents and skills sharing the same declared environment', () => {
  const declared = skill('environment-skill')
  declared.phi = { environment: 'phi:r@1' }
  const item = buildPhiPluginListItem(
    barePlugin({ skills: [declared], agents: [agent('EnvironmentSpecialist', 'phi:r@1')] })
  )
  assert.deepEqual(item.usedEnvironments, [
    {
      ref: 'phi:r@1',
      name: 'phi-r',
      scope: 'builtin',
      skillNames: ['environment-skill'],
      agentNames: ['EnvironmentSpecialist']
    }
  ])
  assert.equal(item.skillDetails?.[0]?.environmentWarning, undefined)
})

test('fallback warnings, unused private declarations and empty references stay truthful', () => {
  const fallback = skill('fallback')
  const unusedPrivate = {
    name: 'private-env',
    spec: 'environments/private-env/environment.yml',
    specPath: '/plugins/detail-fixture/environments/private-env/environment.yml',
    locks: {} as never,
    environment: {
      name: 'private-env',
      channels: ['conda-forge'],
      dependencies: ['python=3.12'],
      description: 'Private fixture environment.'
    }
  }
  const item = buildPhiPluginListItem(
    barePlugin({
      agents: [agent('Zulu'), agent('Alpha')],
      skills: [fallback],
      environments: { 'private-env': unusedPrivate }
    })
  )

  assert.deepEqual(
    item.agentDetails?.map((entry) => entry.name),
    ['Alpha', 'Zulu']
  )
  assert.deepEqual(item.skillDetails, [
    {
      name: 'fallback',
      description: 'fallback description',
      enabled: true,
      environmentRef: 'phi:python@1',
      environmentWarning: 'skill fallback declares no environment'
    }
  ])
  assert.deepEqual(item.usedEnvironments, [
    {
      ref: 'phi:python@1',
      name: 'phi-python',
      scope: 'builtin',
      skillNames: ['fallback'],
      agentNames: [],
      warnings: ['skill fallback declares no environment']
    },
    {
      ref: 'plugin:private-env',
      name: 'private-env',
      description: 'Private fixture environment.',
      scope: 'private',
      skillNames: [],
      agentNames: []
    }
  ])

  const noReferences = buildPhiPluginListItem(barePlugin({ agents: [agent('Solo')] }))
  assert.deepEqual(noReferences.usedEnvironments, [])
})

test('details are stable, bounded and disabled with their plugin', () => {
  const longDescription = 'd'.repeat(PLUGIN_DETAIL_IPC_STRING_LIMITS.description + 25)
  const item = buildPhiPluginListItem(
    barePlugin({
      enabled: false,
      agents: [agent('Zulu'), agent('Alpha')],
      skills: [skill('zeta', longDescription), skill('alpha')]
    }),
    { isSkillEnabled: () => true }
  )

  assert.deepEqual(
    item.agentDetails?.map((entry) => entry.name),
    ['Alpha', 'Zulu']
  )
  assert.deepEqual(
    item.skillDetails?.map((entry) => entry.name),
    ['alpha', 'zeta']
  )
  assert.ok(item.skillDetails?.every((entry) => entry.enabled === false))
  assert.equal(
    item.skillDetails?.find((entry) => entry.name === 'zeta')?.description.length,
    PLUGIN_DETAIL_IPC_STRING_LIMITS.description
  )
  assert.deepEqual(item.usedEnvironments?.[0]?.skillNames, ['alpha', 'zeta'])
})

test('skill-local environments with the same declared ref remain owner-specific', () => {
  const item = buildPhiPluginListItem(
    barePlugin({ skills: [localEnvironmentSkill('beta'), localEnvironmentSkill('alpha')] })
  )

  assert.deepEqual(item.usedEnvironments, [
    {
      ref: './environment.yml',
      name: 'alpha',
      scope: 'skill',
      skillNames: ['alpha'],
      agentNames: []
    },
    {
      ref: './environment.yml',
      name: 'beta',
      scope: 'skill',
      skillNames: ['beta'],
      agentNames: []
    }
  ])
})
