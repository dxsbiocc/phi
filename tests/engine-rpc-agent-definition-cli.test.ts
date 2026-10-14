import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_REPORT_PROTOCOL } from '../src/main/agent/agents/report'
import { compileRpcAgentDefinitions } from '../src/main/agent/engine/rpc/subagents/definition-compiler'
import { compileOptions, definition } from './helpers/rpcAgentDefinitionFixture'
import { rpcAgentDefinitionCli } from './helpers/rpcAgentDefinitionCli'

test('actual private OMP CLI discovers generated agents and exposes its real native task schema', async () => {
  const options = compileOptions({
    definitions: (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map(
      (thinkingLevel, index) => definition({ name: `Research${index}`, thinkingLevel })
    )
  })
  const compilation = await compileRpcAgentDefinitions(options)
  const { result, frames } = await rpcAgentDefinitionCli(compilation)
  assert.equal(result.agents.length, 12)
  for (const entry of compilation.manifest.entries) {
    const discovered = result.agents.find((agent) => agent.name === entry.nativeName)
    assert.ok(discovered)
    assert.equal(discovered.description, options.definitions[0].description)
    assert.deepEqual(
      discovered.tools,
      entry.tools.map((tool) => tool.name)
    )
    // The SDK parser normalizes an empty spawns list to undefined; tools excludes task.
    assert.equal(discovered.spawns, undefined)
    assert.deepEqual(discovered.model, [`${entry.model.provider}/${entry.model.id}`])
    assert.equal(discovered.thinkingLevel, entry.thinkingLevel)
    assert.equal(discovered.blocking, entry.blocking)
    assert.deepEqual(discovered.autoloadSkills, ['paper-lookup'])
    assert.equal(
      discovered.systemPrompt,
      `${options.definitions[0].systemPrompt}\n\n${AGENT_REPORT_PROTOCOL}`
    )
    assert.equal(discovered.source, 'user')
    assert.ok(discovered.filePath?.includes(`/agent/agents/${entry.nativeName}.md`))
    assert.ok(result.task.description.includes(entry.nativeName))
  }
  assert.equal(result.task.source, 'builtin')
  assert.ok(result.task.parameters.properties.agent)
  assert.ok(result.task.parameters.properties.task)
  assert.ok(result.task.parameters.properties.solutionSpace)
  assert.equal(result.task.parameters.properties.effort, undefined)
  assert.equal(result.task.parameters.properties.tools, undefined)
  assert.equal(result.task.parameters.properties.isolated, undefined)
  assert.equal(
    frames.some((frame) => frame.type === 'agent_start'),
    false
  )
})

test('actual project agent shadowing remains visible and compiler artifacts alone grant no execution authority', async () => {
  const compilation = await compileRpcAgentDefinitions(compileOptions())
  const name = compilation.manifest.entries[0].nativeName
  const { result, frames } = await rpcAgentDefinitionCli(compilation, {
    name,
    content: `---\nname: ${name}\ndescription: Project shadow\ntools: [bash]\nmodel: [fixture/model]\nblocking: false\n---\nUNTRUSTED PROJECT SHADOW\n`
  })
  const discovered = result.agents.find((agent) => agent.name === name)
  assert.ok(discovered)
  assert.equal(discovered.source, 'project')
  assert.deepEqual(discovered.tools, ['bash'])
  assert.equal(discovered.systemPrompt, 'UNTRUSTED PROJECT SHADOW')
  assert.ok(discovered.filePath?.includes('/project/.omp/agents/'))
  assert.equal(
    frames.some((frame) => frame.type === 'agent_start'),
    false
  )
})

test('every accepted canonical builtin and exact custom identity survives actual SDK discovery without rewriting or deduplication', async () => {
  const tools = [
    'read',
    'bash',
    'edit',
    'ast_grep',
    'ast_edit',
    'ask',
    'debug',
    'ida',
    'eval',
    'github',
    'glob',
    'grep',
    'find',
    'lsp',
    'checkpoint',
    'rewind',
    'context_notes',
    'new_context',
    'security_scan',
    'wait',
    'todo',
    'web_search',
    'write',
    'memory_edit',
    'retain',
    'recall',
    'reflect',
    'learn',
    'manage_skill',
    'yield',
    'goal',
    'think',
    'CustomTool',
    'SearchFunction',
    'ReadModel',
    'plugin.tool:Run',
    'mcp__Host_action'
  ]
  const compilation = await compileRpcAgentDefinitions(
    compileOptions({
      definitions: [definition({ tools })],
      availableTools: tools.map((name) => ({ name, site: 'host' as const }))
    })
  )
  const { result, frames } = await rpcAgentDefinitionCli(compilation)
  for (const entry of compilation.manifest.entries) {
    const discovered = result.agents.find((agent) => agent.name === entry.nativeName)
    assert.ok(discovered)
    assert.deepEqual(
      entry.tools.map((tool) => tool.name),
      tools
    )
    assert.deepEqual(
      discovered.tools,
      entry.tools.map((tool) => tool.name)
    )
  }
  assert.equal(
    frames.some((frame) => frame.type === 'agent_start'),
    false
  )
  await assert.rejects(
    compileRpcAgentDefinitions(
      compileOptions({
        definitions: [definition({ tools: ['UnknownCustomTool'] })]
      })
    ),
    /unavailable tool/
  )
})
