import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import {
  resolveRemoteAgentTools,
  shouldAttachRemoteParentTool
} from '../src/main/agent/agents/remote-agent-tools'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import {
  remoteAgentSupportedToolNames,
  remoteWorkspaceToolsVerified
} from '../src/main/agent/engine/phi-extension'
import { writeEnablementState } from '../src/main/agent/enablement'
import { NOTEBOOK_TOOL_NAMES } from '../src/main/agent/notebook/notebook-tools'
import { installPlugin } from '../src/main/agent/plugins/loader'
import { PHI_REMOTE_BASH_DESCRIPTION } from '../src/main/agent/remote-workspace-bash-tool'
import { PHI_REMOTE_READ_DESCRIPTION } from '../src/main/agent/remote-workspace-read-tool'
import { writeRuntimePluginFixture } from './helpers/runtimePluginFixture'

function agent(tools: string[]): PhiAgentDefinition {
  return {
    name: 'Researcher',
    description: 'Researches.',
    tools,
    skills: [],
    visibility: 'entry',
    warnings: [],
    systemPrompt: 'Research carefully.',
    source: 'phi',
    filePath: '/local/Researcher.md'
  }
}

function writeAgent(root: string, path: string, name: string): void {
  const filePath = join(root, path)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${name} agent.\ntools: [read]\n---\nRun ${name}.\n`
  )
}

test('remote agent tools keep verified registrations and diagnose each rejected tool', () => {
  const result = resolveRemoteAgentTools(
    agent(['read', 'bash', 'office_read', 'lib.save', 'unknown_tool']),
    [
      {
        name: 'read',
        description: PHI_REMOTE_READ_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'bash',
        description: PHI_REMOTE_BASH_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      }
    ]
  )

  assert.equal(result.available, true)
  assert.deepEqual(result.agent.tools, ['read', 'bash'])
  assert.deepEqual(result.diagnostics, [
    '该 agent 在远程项目中缺少：office_read',
    '该 agent 在远程项目中缺少：lib.save',
    '该 agent 在远程项目中缺少：unknown_tool'
  ])
})

test('remote agent needs at least one of read or bash after intersection', () => {
  const browserOnly = resolveRemoteAgentTools(agent(['browser']), [
    {
      name: 'browser',
      description: 'Phi browser',
      sourceInfo: { source: 'extension' }
    }
  ])
  assert.equal(browserOnly.available, false)
  assert.match(browserOnly.unavailableReason ?? '', /read.*bash/)

  const readOnly = resolveRemoteAgentTools(agent(['read']), [
    {
      name: 'read',
      description: PHI_REMOTE_READ_DESCRIPTION,
      sourceInfo: { source: 'extension' }
    }
  ])
  assert.equal(readOnly.available, true)

  const empty = resolveRemoteAgentTools(agent(['office_read']), [])
  assert.equal(empty.available, false)
  assert.match(empty.unavailableReason ?? '', /没有可用工具/)
})

test('remote specialists keep scoped tools and receive only explicitly declared parent tools', () => {
  const definition = agent(['read', 'browser', 'skill_run', 'env_request'])

  assert.equal(shouldAttachRemoteParentTool(definition, 'read', false), true)
  assert.equal(shouldAttachRemoteParentTool(definition, 'browser', true), false)
  assert.equal(shouldAttachRemoteParentTool(definition, 'skill_run', false), false)
  assert.equal(shouldAttachRemoteParentTool(definition, 'env_request', false), false)
  assert.equal(shouldAttachRemoteParentTool(definition, 'agent_status', false), false)
})

test('remote specialist inventory excludes parent management and agent-specific unavailable tools', () => {
  const available = remoteAgentSupportedToolNames()
  const researcher = resolveRemoteAgentTools(
    agent(['read', 'Wrapper', 'agent_status', 'wrapper_run', 'skill_run', 'env_request']),
    available
  )

  assert.deepEqual(researcher.agent.tools, ['read'])
  for (const name of ['Wrapper', 'agent_status', 'wrapper_run', 'skill_run', 'env_request']) {
    assert.ok(researcher.diagnostics.includes(`该 agent 在远程项目中缺少：${name}`))
  }

  const wrapper = resolveRemoteAgentTools(
    { ...agent(['read', 'wrapper_run']), name: 'Wrapper' },
    available
  )
  assert.deepEqual(wrapper.agent.tools, ['read', 'wrapper_run'])
})

test('remote-local discovery reads only global, remote Wrapper, and plugin agents in priority order', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-agent-discovery-'))
  try {
    const cwd = join(root, 'project')
    const agentDir = join(root, 'home', '.phi')
    writeAgent(root, 'project/.phi/agents/ProjectOnly.md', 'ProjectOnly')
    writeAgent(root, 'project/.claude/agents/CompatProject.md', 'CompatProject')
    writeAgent(root, 'home/.phi/agents/Global.md', 'Global')
    writeAgent(root, 'home/.claude/agents/CompatGlobal.md', 'CompatGlobal')
    writeAgent(root, 'bundled/Wrapper.md', 'Wrapper')
    writeAgent(root, 'plugin/PluginOnly.md', 'PluginOnly')
    writeAgent(root, 'plugin/Global.md', 'Global')

    const result = discoverPhiAgents({
      cwd,
      agentDir,
      bundledDir: join(root, 'bundled'),
      homeDir: join(root, 'home'),
      pluginAgentDirs: [join(root, 'plugin')],
      scope: 'remote-local'
    })

    assert.deepEqual(
      result.agents.map((item) => item.name),
      ['Global', 'Wrapper', 'PluginOnly']
    )
    const wrapper = result.agents.find((item) => item.name === 'Wrapper')
    assert.match(wrapper?.description ?? '', /Remote-project Wrapper/)
    assert.match(wrapper?.systemPrompt ?? '', /selected SSH host/)
    assert.deepEqual(result.diagnostics, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote workspace verification checks only the tools declared by the specialist', () => {
  const read = {
    name: 'read',
    description: PHI_REMOTE_READ_DESCRIPTION,
    sourceInfo: { source: 'extension' }
  }
  assert.equal(remoteWorkspaceToolsVerified([read], ['read']), true)
  assert.equal(remoteWorkspaceToolsVerified([read], ['read', 'bash']), false)
  assert.equal(remoteWorkspaceToolsVerified([read]), false)
})

test('remote agent static inventory comes from the guard policy and filters discovery', () => {
  const supported = remoteAgentSupportedToolNames()
  for (const name of [
    'read',
    'bash',
    'glob',
    'grep',
    'write',
    'edit',
    'wrapper_run',
    'skill_run',
    'env_request',
    'download_file',
    'present_files',
    'browser',
    'web_search',
    ...NOTEBOOK_TOOL_NAMES
  ]) {
    assert.equal(supported.has(name), true, name)
  }
  for (const name of ['office_read', 'lib.save', 'mcp__server_tool', 'unknown_tool']) {
    assert.equal(supported.has(name), false, name)
  }

  const result = resolveRemoteAgentTools(
    agent(['read', 'browser', 'office_read', 'lib.save']),
    supported
  )
  assert.deepEqual(result.agent.tools, ['read', 'browser'])
  assert.deepEqual(result.diagnostics, [
    '该 agent 在远程项目中缺少：office_read',
    '该 agent 在远程项目中缺少：lib.save'
  ])
})

test('remote-local plugin discovery ignores enablement overrides from the local anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-plugin-anchor-'))
  try {
    const cwd = join(root, 'anchor')
    const agentDir = join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const installed = installPlugin(writeRuntimePluginFixture(root), {
      agentDir,
      runtimeRoot: join(root, 'runtime')
    })
    assert.equal(installed.ok, true, JSON.stringify(installed.errors))
    writeEnablementState(
      {
        version: 1,
        global: { 'plugin:visualization': true },
        projects: { [realpathSync(cwd)]: { 'plugin:visualization': false } }
      },
      { agentDir }
    )

    const local = discoverPhiAgents({ cwd, agentDir, scope: 'local' })
    const remote = discoverPhiAgents({ cwd, agentDir, scope: 'remote-local' })
    assert.equal(
      local.agents.some((item) => item.name === 'Visualization'),
      false
    )
    assert.equal(
      remote.agents.some((item) => item.name === 'Visualization'),
      true
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
