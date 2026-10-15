import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionChildConfig } from '../src/main/agent/engine/rpc/subagents/production-child-config'
import { productionChildOptions } from './helpers/productionChildNodeFixture'

test('trusted child edit is usable only when the real parent native roster includes edit', async () => {
  const old = productionChildOptions()
  const definitions = [{ ...old.definitions[0], tools: ['read', 'edit'] }]
  await assert.rejects(createProductionChildConfig({ ...old, definitions }))
  const prepared = await createProductionChildConfig({
    ...old,
    definitions,
    availableTools: [
      { name: 'read', site: 'native' },
      { name: 'edit', site: 'native' }
    ]
  })
  assert.deepEqual(
    prepared.config.profiles[0].definition.tools.map((tool) => tool.name),
    ['read', 'edit']
  )
  await assert.rejects(
    createProductionChildConfig({
      ...old,
      definitions: [{ ...definitions[0], tools: ['read', 'edit', 'bash'] }],
      availableTools: [
        { name: 'read', site: 'native' },
        { name: 'edit', site: 'native' }
      ]
    }),
    /unavailable/
  )
})

test('trusted expert model is retained independently with its published owned route', async () => {
  const old = productionChildOptions(),
    child = { ...old.modelDescriptors[0], id: 'child-model' }
  const definitions = [{ ...old.definitions[0], model: [child.provider + '/' + child.id] }]
  const prepared = await createProductionChildConfig({
    ...old,
    definitions,
    modelDescriptors: [...old.modelDescriptors, child],
    native: {
      ...old.native,
      models: [...old.native.models, { provider: child.provider, id: child.id }]
    }
  })
  assert.equal(prepared.config.profiles[0].model.id, 'child-model')
  assert.equal(prepared.config.parentModel?.id, old.parentModel.id)
  await assert.rejects(
    createProductionChildConfig({
      ...old,
      definitions,
      modelDescriptors: [...old.modelDescriptors, child]
    }),
    /published|route/
  )
})

test('a non-reasoning expert does not inherit an incompatible parent effort or hide an explicit request', async () => {
  const options = productionChildOptions({ parentThinkingLevel: 'high' })
  const prepared = await createProductionChildConfig(options)
  assert.equal(prepared.config.profiles[0].definition.thinkingLevel, 'off')
  await assert.rejects(
    createProductionChildConfig({
      ...options,
      definitions: [{ ...options.definitions[0], thinkingLevel: 'high' }]
    }),
    /thinking level is unsupported/
  )
})
