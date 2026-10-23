import {
  WRAPPER_COMPOSITION_TOOL_NAMES,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'
import { createHostJobClient } from '../src/main/agent/wrappers/composition/job-host-client'
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

test('application RPC Notebook roster reuses existing authoring and owned execution classifications', () => {
  assert.deepEqual(APP_RPC_NOTEBOOK_TOOL_NAMES, NOTEBOOK_TOOL_NAMES)
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
      ['notebook_list', 'read'],
      ['notebook_read', 'read'],
      ['notebook_insert_cell', 'write'],
      ['notebook_update_cell', 'write'],
      ['notebook_delete_cell', 'write'],
      ['notebook_run_cell', 'write'],
      ['notebook_save', 'write']
    ]
  )
})

test('application Wrapper roster reuses the six existing tools and their approval contract', () => {
  const tools = buildWrapperCompositionTools(
    createHostJobClient(async () => {
      throw new Error('roster inspection cannot call a service')
    })
  )
  assert.deepEqual(
    tools.map((tool) => tool.name),
    WRAPPER_COMPOSITION_TOOL_NAMES
  )
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.approval]),
    [
      ['wrapper_search', 'read'],
      ['wrapper_inspect', 'read'],
      ['wrapper_run', 'write'],
      ['wrapper_status', 'read'],
      ['wrapper_wait', 'read'],
      ['wrapper_cancel', 'write']
    ]
  )
  assert.equal(APP_RPC_NOTEBOOK_TOOL_NAMES.length, 7)
  assert.equal(APP_RPC_NOTEBOOK_TOOL_NAMES.includes('notebook_run_cell'), true)
})
