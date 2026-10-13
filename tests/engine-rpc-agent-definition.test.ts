import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'
import { AGENT_REPORT_PROTOCOL } from '../src/main/agent/agents/report'
import { compileRpcAgentDefinitions } from '../src/main/agent/engine/rpc/subagents/definition-compiler'
import {
  RPC_AGENT_MAX_BUNDLE_BYTES,
  RPC_AGENT_MAX_FILE_BYTES
} from '../src/main/agent/engine/rpc/subagents/definition-validation'
import { compileOptions, definition, safeModel } from './helpers/rpcAgentDefinitionFixture'

test('compiler preserves prompts and safe YAML, emits scoped foreground/background files and hashes', async () => {
  const options = compileOptions()
  const result = await compileRpcAgentDefinitions(options)
  assert.equal(result.files.length, 3)
  assert.equal(result.manifest.schema, 1)
  assert.deepEqual(result.manifest.binding, options.binding)
  for (const [index, file] of result.files.slice(0, 2).entries()) {
    assert.match(file.path, /^agents\/phi_[a-f0-9]{24}_0_(fg|bg)\.md$/)
    assert.equal(file.sha256, createHash('sha256').update(file.bytes).digest('hex'))
    const content = file.bytes.toString('utf8')
    const end = content.indexOf('\n---\n', 4)
    assert.ok(end > 0)
    const yaml = parseYaml(content.slice(4, end))
    assert.equal(yaml.name, result.manifest.entries[index].nativeName)
    assert.equal(yaml.description, options.definitions[0].description)
    assert.deepEqual(yaml.tools, ['read', 'web_search'])
    assert.deepEqual(yaml.spawns, [])
    assert.deepEqual(yaml.model, ['fixture/model'])
    assert.deepEqual(yaml.autoloadSkills, ['paper-lookup'])
    assert.equal(yaml.blocking, index === 0)
    assert.equal(
      content.slice(end + 5),
      `${options.definitions[0].systemPrompt}\n\n${AGENT_REPORT_PROTOCOL}\n`
    )
  }
  assert.equal(result.manifestHash, result.files.at(-1)!.sha256)
  assert.equal(result.files.at(-1)!.path, 'phi-agent-definitions.json')
  assert.deepEqual(JSON.parse(result.files.at(-1)!.bytes.toString()), result.manifest)
  assert.deepEqual(result.warnings, [])
})

test('safe projection excludes desktop paths, credentials, plugin objects and SDK metadata', async () => {
  const agent = Object.assign(definition(), {
    plugin: { token: 'synthetic-secret' },
    apiKey: 'synthetic-secret'
  })
  const model = Object.assign(safeModel(), {
    baseUrl: 'https://secret.invalid',
    apiKey: 'synthetic-secret'
  })
  const result = await compileRpcAgentDefinitions(
    compileOptions({ definitions: [agent], availableModels: [model] })
  )
  const serialized = Buffer.concat(result.files.map((file) => file.bytes)).toString()
  for (const value of [
    '/Users/desktop',
    'synthetic-secret',
    'secret.invalid',
    'filePath',
    'apiKey',
    'baseUrl'
  ])
    assert.equal(serialized.includes(value), false, value)
  assert.deepEqual(result.manifest.entries[0].model, { provider: 'fixture', id: 'model' })
})

test('names are deterministic across definition order, distinguish foreground/background and change with trusted profiles', async () => {
  const a = definition({ name: 'Alpha' })
  const b = definition({ name: 'AlphaBackground' })
  const first = await compileRpcAgentDefinitions(compileOptions({ definitions: [b, a] }))
  const second = await compileRpcAgentDefinitions(compileOptions({ definitions: [a, b] }))
  assert.deepEqual(first.files, second.files)
  assert.equal(new Set(first.manifest.entries.map((entry) => entry.nativeName)).size, 4)
  const changed = await compileRpcAgentDefinitions(
    compileOptions({
      definitions: [a, b],
      binding: { ...compileOptions().binding, serverId: 'other' }
    })
  )
  assert.notEqual(changed.manifest.entries[0].nativeName, first.manifest.entries[0].nativeName)
  const prompt = await compileRpcAgentDefinitions(
    compileOptions({ definitions: [definition({ name: 'Alpha', systemPrompt: 'changed' }), b] })
  )
  assert.notEqual(
    prompt.manifest.entries[0].definitionHash,
    first.manifest.entries[0].definitionHash
  )
})

test('model selectors retain exact ordered matching and explicit warning plus parent fallback', async () => {
  const models = [
    safeModel(),
    safeModel('vendor', 'family/v2'),
    safeModel('vendor', 'literal*[a]?')
  ]
  const selected = await compileRpcAgentDefinitions(
    compileOptions({
      availableModels: models,
      definitions: [definition({ model: ['missing/one', 'vendor/family/v2', 'fixture/model'] })]
    })
  )
  assert.deepEqual(selected.manifest.entries[0].model, { provider: 'vendor', id: 'family/v2' })
  const literal = await compileRpcAgentDefinitions(
    compileOptions({
      availableModels: models,
      definitions: [definition({ model: ['vendor/literal*[a]?'] })]
    })
  )
  assert.deepEqual(literal.manifest.entries[0].model, { provider: 'vendor', id: 'literal*[a]?' })
  for (const selector of ['vendor/family', 'vendor/*', '@task', 'model', 'VENDOR/family/v2']) {
    const unavailable = await compileRpcAgentDefinitions(
      compileOptions({ availableModels: models, definitions: [definition({ model: [selector] })] })
    )
    assert.deepEqual(unavailable.manifest.entries[0].model, { provider: 'fixture', id: 'model' })
    assert.deepEqual(unavailable.warnings, [
      `Phi agent Research: model ${selector} not available; using the conversation's model`
    ])
  }
  const empty = await compileRpcAgentDefinitions(
    compileOptions({ definitions: [definition({ model: [] })] })
  )
  assert.deepEqual(empty.warnings, [])
})

test('every supported Phi thinking level is preserved without advertising effort overrides', async () => {
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
    const result = await compileRpcAgentDefinitions(
      compileOptions({ definitions: [definition({ thinkingLevel })] })
    )
    assert.equal(result.manifest.entries[0].thinkingLevel, thinkingLevel)
    assert.ok(result.files[0].bytes.toString().includes(`thinkingLevel: "${thinkingLevel}"`))
    assert.equal(result.files[0].bytes.toString().includes('effort:'), false)
  }
})

test('agent thinking override wins and absent declaration inherits the exact parent level', async () => {
  const inherited = await compileRpcAgentDefinitions(
    compileOptions({ parentThinkingLevel: 'minimal' })
  )
  assert.equal(inherited.manifest.entries[0].thinkingLevel, 'minimal')
  const overridden = await compileRpcAgentDefinitions(
    compileOptions({
      parentThinkingLevel: 'high',
      definitions: [definition({ thinkingLevel: 'off' })]
    })
  )
  assert.equal(overridden.manifest.entries[0].thinkingLevel, 'off')
  await assert.rejects(
    compileRpcAgentDefinitions(compileOptions({ parentThinkingLevel: 'auto' as 'high' })),
    /thinking level/
  )
})

test('ready environment descriptor must match exact selected server/project/reference/owner and exposes no variables', async () => {
  const options = compileOptions({
    definitions: [definition({ environment: 'plugin:research', pluginId: 'plugin-1' })]
  })
  const environment = {
    ref: 'plugin:research',
    pluginId: 'plugin-1',
    environmentId: 'env-1',
    lockSha256: 'b'.repeat(64),
    status: 'ready' as const,
    binding: options.binding
  }
  let calls = 0
  const result = await compileRpcAgentDefinitions({
    ...options,
    resolveEnvironment(agent) {
      calls++
      assert.deepEqual(agent, {
        name: 'Research',
        environment: 'plugin:research',
        pluginId: 'plugin-1'
      })
      assert.equal(Object.isFrozen(agent), true)
      return Object.assign({}, environment, {
        variables: { API_KEY: 'synthetic-key' },
        activationPath: '/desktop/environment'
      })
    }
  })
  assert.equal(calls, 1)
  assert.deepEqual(result.manifest.entries[0].environment, environment)
  assert.equal(result.files.at(-1)!.bytes.includes('synthetic-key'), false)
  for (const changed of [
    { ...environment, ref: 'phi:research@1' },
    { ...environment, pluginId: 'other' },
    { ...environment, status: 'absent' },
    { ...environment, lockSha256: 'invalid' },
    ...['serverId', 'serverIdentitySha256', 'projectId', 'projectRoot'].map((key) => ({
      ...environment,
      binding: {
        ...environment.binding,
        [key]:
          key === 'serverIdentitySha256'
            ? 'c'.repeat(64)
            : key === 'projectRoot'
              ? '/other'
              : 'other'
      }
    }))
  ])
    await assert.rejects(
      compileRpcAgentDefinitions({
        ...options,
        resolveEnvironment: () => changed as typeof environment
      })
    )
  await assert.rejects(compileRpcAgentDefinitions(options), /trusted desktop resolver/)
})

test('all definitions and model/tool/skill/binding inputs are detached before awaiting a resolver', async () => {
  const options = compileOptions({
    definitions: [definition({ environment: 'phi:research@1' }), definition({ name: 'Second' })]
  })
  const expectedBinding = { ...options.binding }
  const originalModel = { ...options.parentModel }
  const result = await compileRpcAgentDefinitions({
    ...options,
    resolveEnvironment() {
      Object.assign(options.binding, { serverId: 'changed' })
      Object.assign(options.parentModel, { id: 'changed' })
      options.definitions[1].tools.push('unavailable')
      options.definitions[1].skills.push('unavailable')
      options.definitions[1].systemPrompt = 'changed'
      Object.assign(options.availableModels[0], { id: 'changed' })
      Object.assign(options.availableTools[0], { site: 'host' })
      return Promise.resolve({
        ref: 'phi:research@1',
        environmentId: 'env-1',
        lockSha256: 'b'.repeat(64),
        status: 'ready',
        binding: expectedBinding
      })
    }
  })
  assert.deepEqual(result.manifest.binding, expectedBinding)
  assert.deepEqual(result.manifest.entries[2].model, originalModel)
  assert.deepEqual(result.manifest.entries[2].tools, [
    { name: 'read', site: 'native' },
    { name: 'web_search', site: 'host' }
  ])
  assert.deepEqual(result.manifest.entries[2].skills, ['paper-lookup'])
  assert.equal(result.files[2].bytes.toString().includes('保留完整提示'), true)
})

test('invalid shapes, duplicate identity, unavailable declarations and unsafe names fail closed', async () => {
  const invalidAgents = [
    { name: '../Escape' },
    { name: 'ResearchAgent' },
    { name: 'A'.repeat(129) },
    { description: '' },
    { systemPrompt: '\ud800' },
    { systemPrompt: '\u0000' },
    { tools: ['task'] },
    { tools: ['Task'] },
    { thinkingLevel: { toString: () => 'high' } },
    { tools: ['read', 'read'] },
    { tools: ['unknown'] },
    { tools: ['../read'] },
    { tools: ['read\nbash'] },
    { skills: ['unknown'] },
    { skills: ['../skill'] },
    { skills: ['paper-lookup', 'paper-lookup'] },
    { model: ['fixture/model\napiKey: key'] },
    { thinkingLevel: 'auto' },
    { environment: './desktop' },
    { environment: 'plugin:research' },
    { pluginId: '/desktop/plugin' },
    { visibility: 'internal' },
    { source: 'unknown' }
  ]
  for (const invalid of invalidAgents)
    await assert.rejects(
      compileRpcAgentDefinitions(
        compileOptions({ definitions: [definition(invalid as Parameters<typeof definition>[0])] })
      ),
      JSON.stringify(invalid)
    )
  await assert.rejects(
    compileRpcAgentDefinitions(compileOptions({ definitions: [definition(), definition()] })),
    /Duplicate/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        definitions: Array.from({ length: 65 }, (_, i) => definition({ name: `Agent${i}` }))
      })
    ),
    /count/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(compileOptions({ availableModels: [safeModel(), safeModel()] })),
    /Duplicate/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({ parentModel: { provider: 'missing', id: 'model' } })
    ),
    /parent model/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({ binding: { ...compileOptions().binding, projectRoot: '/srv/../project' } })
    ),
    /canonical/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        availableTools: [
          { name: 'read', site: 'native' },
          { name: 'read', site: 'host' }
        ]
      })
    ),
    /duplicate/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(compileOptions({ availableSkills: ['../skill'] }))
  )
  const accessor = definition()
  let reads = 0
  Object.defineProperty(accessor, 'systemPrompt', {
    get() {
      reads++
      return 'bad'
    }
  })
  await assert.rejects(
    compileRpcAgentDefinitions(compileOptions({ definitions: [accessor] })),
    /accessor/
  )
  assert.equal(reads, 0)
})

test('empty compat tool lists stay explicit and cannot accidentally activate default native tools', async () => {
  const result = await compileRpcAgentDefinitions(
    compileOptions({ definitions: [definition({ source: 'compat', tools: [], skills: [] })] })
  )
  assert.deepEqual(result.manifest.entries[0].tools, [])
  assert.deepEqual(result.manifest.entries[0].skills, [])
  const content = result.files[0].bytes.toString()
  const yaml = content.slice(4, content.indexOf('\n---\n', 4))
  assert.deepEqual(parseYaml(yaml).tools, [])
})

test('UTF-8 byte limits bound individual source, manifest and aggregate bundle without truncation', async () => {
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        definitions: [definition({ systemPrompt: '🧬'.repeat(RPC_AGENT_MAX_FILE_BYTES / 4) })]
      })
    ),
    /file exceeds/
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        definitions: Array.from({ length: 5 }, (_, i) =>
          definition({
            name: `Research${i}`,
            systemPrompt: 'a'.repeat(RPC_AGENT_MAX_BUNDLE_BYTES / 10)
          })
        )
      })
    ),
    /bundle exceeds/
  )
  const largeRoster = Array.from({ length: 256 }, (_, i) => ({
    name: `tool_${'x'.repeat(115)}_${i}`,
    site: 'host' as const
  }))
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        availableTools: largeRoster,
        definitions: Array.from({ length: 32 }, (_, i) =>
          definition({ name: `Research${i}`, tools: largeRoster.map((tool) => tool.name) })
        )
      })
    ),
    /file exceeds/
  )
  const empty = await compileRpcAgentDefinitions(compileOptions({ definitions: [] }))
  assert.deepEqual(empty.manifest.entries, [])
  assert.equal(empty.files.length, 1)
})

for (const [label, names] of [
  ['legacy search alias', ['search']],
  ['builtin case alias', ['Read']],
  ['normalization collision', ['read', 'Read']],
  ['other noncanonical native identities', ['wEb_sEaRcH', 'GOAL', 'SeArCh']]
] as const) {
  test(`compiler rejects ${label} before native parsing can change the exact whitelist`, async () => {
    await assert.rejects(
      compileRpcAgentDefinitions(
        compileOptions({
          definitions: [definition({ tools: [...names] })],
          availableTools: names.map((name) => ({ name, site: 'host' as const }))
        })
      ),
      /native parser would rewrite/
    )
  })
}
