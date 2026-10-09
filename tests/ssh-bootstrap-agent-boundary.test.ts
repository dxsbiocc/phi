import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentRunTools } from '../src/main/agent/agents/run-tools'
import { buildRemoteWorkspaceBashTool } from '../src/main/agent/remote-workspace-bash-tool'
import { buildRemoteWorkspaceEditTool } from '../src/main/agent/remote-workspace-edit-tool'
import { buildRemoteWorkspaceReadTool } from '../src/main/agent/remote-workspace-read-tool'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../src/main/agent/remote-workspace-search-tools'
import { buildRemoteWorkspaceWriteTool } from '../src/main/agent/remote-workspace-write-tool'

test('SSH password bootstrap is absent from the agent-visible tool registries', () => {
  const runToolNames = buildAgentRunTools(new AgentRunRegistry()).map((tool) => tool.name)
  const workerSource = readFileSync(
    new URL('../src/main/agent/omp/omp-sdk-worker.ts', import.meta.url),
    'utf8'
  )

  assert.deepEqual(runToolNames, ['agent_status', 'agent_wait', 'agent_steer', 'agent_stop'])
  assert.doesNotMatch(workerSource, /ssh[_-]?bootstrap|password[_-]?bootstrap/i)
})

test('remote agent tools expose operations only, never credential or setup tools', () => {
  const reject = async (): Promise<never> => {
    throw new Error('not used')
  }
  const names = [
    buildRemoteWorkspaceReadTool(reject).name,
    buildRemoteWorkspaceWriteTool(reject).name,
    buildRemoteWorkspaceEditTool(reject).name,
    buildRemoteWorkspaceBashTool(reject).name,
    buildRemoteWorkspaceGlobTool(reject).name,
    buildRemoteWorkspaceGrepTool(reject).name
  ]

  assert.deepEqual(names, ['read', 'write', 'edit', 'bash', 'glob', 'grep'])
  assert.doesNotMatch(names.join(' '), /password|passphrase|credential|bootstrap|settings?/i)
})
