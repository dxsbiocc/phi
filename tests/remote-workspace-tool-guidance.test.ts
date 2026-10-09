import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRemoteWorkspaceBashTool } from '../src/main/agent/remote-workspace-bash-tool'
import { buildRemoteWorkspaceEditTool } from '../src/main/agent/remote-workspace-edit-tool'
import { buildRemoteWorkspaceReadTool } from '../src/main/agent/remote-workspace-read-tool'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../src/main/agent/remote-workspace-search-tools'
import { buildRemoteWorkspaceWriteTool } from '../src/main/agent/remote-workspace-write-tool'
import {
  RemoteSshConnectionError,
  sshConnectionDiagnosis
} from '../src/main/agent/wrappers/remote-ssh-diagnostics'

const SETTINGS_GUIDANCE = '请在设置 → 远程中添加或修复服务器'

type Tool = ReturnType<typeof buildRemoteWorkspaceReadTool>

function toolsRejecting(error: Error): Array<{ name: string; tool: Tool; params: object }> {
  return [
    {
      name: 'read',
      tool: buildRemoteWorkspaceReadTool(async () => {
        throw error
      }),
      params: { path: 'note.txt' }
    },
    {
      name: 'write',
      tool: buildRemoteWorkspaceWriteTool(async () => {
        throw error
      }) as Tool,
      params: { path: 'note.txt', content: 'content' }
    },
    {
      name: 'edit',
      tool: buildRemoteWorkspaceEditTool(async () => {
        throw error
      }) as Tool,
      params: { path: 'note.txt', old_string: 'old', new_string: 'new' }
    },
    {
      name: 'bash',
      tool: buildRemoteWorkspaceBashTool(async () => {
        throw error
      }) as Tool,
      params: { command: 'pwd' }
    },
    {
      name: 'glob',
      tool: buildRemoteWorkspaceGlobTool(async () => {
        throw error
      }) as Tool,
      params: { path: '**/*.ts' }
    },
    {
      name: 'grep',
      tool: buildRemoteWorkspaceGrepTool(async () => {
        throw error
      }) as Tool,
      params: { pattern: 'TODO' }
    }
  ]
}

async function errorText(tool: Tool, params: object): Promise<string> {
  const result = await tool.execute('call', params, undefined, {} as never)
  assert.equal(result.isError, true)
  const content = result.content[0]
  assert.equal(content?.type, 'text')
  if (!content || content.type !== 'text') assert.fail('expected text tool output')
  return content.text
}

test('remote agent tools only direct unavailable, authentication, trust and cooldown failures to settings', async () => {
  const boundaryFailures = [
    new Error('远程项目的 SSH 服务器档案不可用'),
    new RemoteSshConnectionError(sshConnectionDiagnosis('authentication_failed')),
    new RemoteSshConnectionError(sshConnectionDiagnosis('identity_not_loaded')),
    new RemoteSshConnectionError(sshConnectionDiagnosis('host_key_changed')),
    new RemoteSshConnectionError(sshConnectionDiagnosis('host_key_unknown')),
    new RemoteSshConnectionError(sshConnectionDiagnosis('host_key_unverified')),
    new Error('SSH 认证或主机信任失败后处于冷却期，剩余约 15 分钟。在设置里点测试连接可立即重试。')
  ]

  for (const failure of boundaryFailures) {
    for (const { name, tool, params } of toolsRejecting(failure)) {
      const text = await errorText(tool, params)
      assert.equal(text, SETTINGS_GUIDANCE, `${name}: ${failure.message}`)
      assert.doesNotMatch(text, /密码|口令|password|passphrase/iu)
    }
  }
})

test('remote agent tools preserve ordinary operation errors and parameter validation', async () => {
  const ordinary = new Error('SSH 服务器无法连接。请检查网络')
  for (const { name, tool, params } of toolsRejecting(ordinary)) {
    assert.equal(await errorText(tool, params), ordinary.message, name)
  }

  const invalidCases: Array<{ tool: Tool; expected: RegExp }> = [
    {
      tool: buildRemoteWorkspaceReadTool(async () => assert.fail()),
      expected: /请提供远程项目内路径/u
    },
    {
      tool: buildRemoteWorkspaceWriteTool(async () => assert.fail()) as Tool,
      expected: /请提供远程项目内路径和文本内容/u
    },
    {
      tool: buildRemoteWorkspaceEditTool(async () => assert.fail()) as Tool,
      expected: /请提供远程路径、old_string 和 new_string/u
    },
    {
      tool: buildRemoteWorkspaceBashTool(async () => assert.fail()) as Tool,
      expected: /请提供远程 Bash 命令/u
    },
    {
      tool: buildRemoteWorkspaceGrepTool(async () => assert.fail()) as Tool,
      expected: /请提供远程 grep 正则表达式/u
    }
  ]
  for (const { tool, expected } of invalidCases) {
    assert.match(await errorText(tool, {}), expected)
  }
})
