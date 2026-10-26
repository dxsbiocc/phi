import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindSessionEnvironment,
  sessionContextFiles,
  sessionMcpServers
} from '../src/main/agent/engine/in-process/session-resource-input'

test('trusted context and MCP snapshots are copied without sharing mutable input', () => {
  const context = [{ path: '/project/AGENTS.md', content: 'project rules' }]
  const mcp = [
    {
      name: 'fixture',
      config: { type: 'stdio', command: 'fixture-server', args: ['--stdio'] }
    }
  ]

  const files = sessionContextFiles(context)
  const servers = sessionMcpServers(mcp)
  context[0]!.content = 'changed'
  ;(mcp[0]!.config.args as string[]).push('--changed')

  assert.deepEqual(files, [{ path: '/project/AGENTS.md', content: 'project rules' }])
  assert.deepEqual(servers, [
    {
      name: 'fixture',
      config: { type: 'stdio', command: 'fixture-server', args: ['--stdio'] }
    }
  ])
})

test('environment binding uses the kernel session identity and rejects malformed host results', async () => {
  const calls: Array<{ method: string; params: unknown }> = []
  const binding = await bindSessionEnvironment(
    { ref: 'phi:python@1', pluginId: 'analysis' },
    {
      sessionId: 'kernel-session-1',
      cwd: '/project',
      request: async (method, params) => {
        calls.push({ method, params })
        return {
          ref: 'phi:python@1',
          envId: 'environment-1',
          variables: { PATH: '/runtime/bin', PYTHONNOUSERSITE: '1' }
        }
      }
    }
  )

  assert.deepEqual(calls, [
    {
      method: 'environments.bindSession',
      params: {
        runtimeSessionId: 'kernel-session-1',
        ref: 'phi:python@1',
        agent: 'Main',
        cwd: '/project',
        pluginId: 'analysis'
      }
    }
  ])
  assert.deepEqual(binding, {
    ref: 'phi:python@1',
    pluginId: 'analysis',
    variables: { PATH: '/runtime/bin', PYTHONNOUSERSITE: '1' }
  })

  await assert.rejects(
    bindSessionEnvironment(
      { ref: 'phi:python@1' },
      {
        sessionId: 'kernel-session-1',
        cwd: '/project',
        request: async () => ({ notReady: { message: 'environment is unavailable' } })
      }
    ),
    /environment is unavailable/
  )
})
