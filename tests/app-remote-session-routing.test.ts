import {
  NOTEBOOK_TOOL_NAMES,
  buildNotebookCustomTools
} from '../src/main/agent/notebook/notebook-tools'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_RPC_NOTEBOOK_TOOL_NAMES,
  createAppRemoteSessionManager,
  installAppRemoteSessionRouting,
  selectAppForegroundAgents,
  type AppRemoteSessionRoutingOptions
} from '../src/main/agent/remote-session-routing'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'

const checker = (): PhiAgentDefinition => ({
  name: 'Checker',
  description: 'Bounded check',
  tools: ['read', 'write', 'bash'],
  skills: [],
  visibility: 'entry',
  warnings: [],
  source: 'phi',
  filePath: '/trusted/Checker.md',
  systemPrompt: 'Check the requested file.'
})

test('application foreground names select immutable copies of complete trusted catalog profiles', () => {
  const trusted = checker()
  const selected = selectAppForegroundAgents(['Checker'], [trusted])
  trusted.systemPrompt = 'changed after selection'
  trusted.tools.push('edit')
  assert.equal(selected[0].systemPrompt, 'Check the requested file.')
  assert.deepEqual(selected[0].tools, ['read', 'write', 'bash'])
  assert.equal(Object.isFrozen(selected), true)
  assert.deepEqual(selectAppForegroundAgents([], [trusted]), [])
})

test('application foreground selection rejects unavailable, ambiguous, invalid and duplicate names', () => {
  for (const [names, catalog] of [
    [['Missing'], [checker()]],
    [['Checker'], [checker(), checker()]],
    [['Checker', 'Checker'], [checker()]],
    [['checker'], [checker()]]
  ] as const)
    assert.throws(() => selectAppForegroundAgents(names, catalog))
})

test('application foreground selection never strips unsupported fields from a selected profile', () => {
  for (const patch of [
    { tools: ['read', 'edit'] },
    { skills: ['paper-search'] },
    { environment: 'plugin:python' },
    { warnings: ['legacy field'] }
  ])
    assert.throws(
      () => selectAppForegroundAgents(['Checker'], [{ ...checker(), ...patch }]),
      /Unsupported RPC foreground agent profile/
    )
})

test('disabled application routing acquires no resources and installs no remote factory', () => {
  const unexpected = (): never => {
    throw new Error('disabled routing touched a resource')
  }
  const options: AppRemoteSessionRoutingOptions = {
    enabled: false,
    agentDir: '/unused',
    runners: {} as AppRemoteSessionRoutingOptions['runners'],
    appPaths: unexpected,
    configuredRoot: unexpected,
    loadAgents: unexpected,
    foregroundAgentNames: 'invalid-renderer-name',
    approval: { shouldGate: unexpected, requestToolApproval: unexpected }
  }
  assert.doesNotThrow(installAppRemoteSessionRouting(options))
  assert.throws(
    () => installAppRemoteSessionRouting({ ...options, enabled: true }),
    /Invalid RPC foreground agent selection/
  )
})

test('application recovery manager keeps the Phi locator out of local journal opening', () => {
  const fresh = createAppRemoteSessionManager('/local/anchor', 'phi-session-id', false)
  assert.equal(fresh.kind, 'persistent')
  assert.equal(fresh.path, undefined)
  const resumed = createAppRemoteSessionManager('/local/anchor', 'phi-session-id', true)
  assert.equal(resumed.kind, 'open')
  assert.equal(resumed.getSessionFile(), 'phi-session:phi-session-id')
  assert.equal(resumed.getCwd(), '/local/anchor')
})

test('application RPC Notebook roster reuses all existing authoring tools with read/write classifications', () => {
  assert.deepEqual(
    APP_RPC_NOTEBOOK_TOOL_NAMES,
    NOTEBOOK_TOOL_NAMES.filter((name) => name !== 'notebook.run_cell')
  )
  const tools = buildNotebookCustomTools(async () => undefined)
  assert.deepEqual(
    tools
      .filter((tool) =>
        APP_RPC_NOTEBOOK_TOOL_NAMES.includes(
          tool.name as (typeof APP_RPC_NOTEBOOK_TOOL_NAMES)[number]
        )
      )
      .map((tool) => [tool.name, tool.approval]),
    [
      ['notebook.list', 'read'],
      ['notebook.read', 'read'],
      ['notebook.insert_cell', 'write'],
      ['notebook.update_cell', 'write'],
      ['notebook.delete_cell', 'write'],
      ['notebook.save', 'write']
    ]
  )
})
