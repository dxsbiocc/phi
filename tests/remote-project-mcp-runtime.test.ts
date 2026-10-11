import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeRemoteProjectMcpSnapshot,
  remoteProjectMcpRuntimeServersValue
} from '../src/main/agent/mcp/remote-project-mcp-runtime'

const SAFE_REMOTE_COMMAND =
  'bash -c \'cd -P -- /project\n[ "$PWD" = /project ] || exit 72\nexec /usr/bin/env -i server\''

test('trusted server-project MCP entries override same-name globals in the guarded snapshot', () => {
  const agentDir = '/local/phi'
  const remote = remoteProjectMcpRuntimeServersValue(
    [
      {
        name: 'analysis',
        sourcePath: 'ssh://lab/project/.phi/mcp.json',
        config: {
          type: 'stdio',
          command: 'ssh',
          args: [
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=yes',
            '-o',
            'ForwardAgent=no',
            '-o',
            'ClearAllForwardings=yes',
            '-o',
            'ServerAliveInterval=10',
            '-o',
            'ServerAliveCountMax=3',
            '-o',
            'SendEnv=-*',
            '-o',
            'PermitLocalCommand=no',
            '-o',
            'RequestTTY=no',
            'lab',
            SAFE_REMOTE_COMMAND
          ],
          cwd: agentDir,
          enabled: true
        }
      },
      {
        name: 'literature',
        sourcePath: 'ssh://lab/project/.phi/mcp.json',
        config: { type: 'http', url: 'https://mcp.example.test/api', enabled: true }
      }
    ],
    agentDir
  )
  const merged = mergeRemoteProjectMcpSnapshot(
    {
      configs: {
        analysis: { type: 'http', url: 'https://global.example.test/mcp' },
        globalOnly: { type: 'http', url: 'https://global.example.test/only' }
      },
      sources: {
        analysis: { path: '/local/phi/mcp.json', level: 'user' },
        globalOnly: { path: '/local/phi/mcp.json', level: 'user' }
      },
      exaApiKeys: []
    },
    {
      allowedServerNames: new Set(['analysis', 'globalOnly']),
      blockedServerReasons: new Map([['literature', 'old reason']]),
      preparedEntries: new Map()
    },
    remote
  )

  assert.equal(merged.snapshot.configs.analysis?.command, 'ssh')
  assert.equal(merged.snapshot.configs.literature?.url, 'https://mcp.example.test/api')
  assert.equal(merged.snapshot.configs.globalOnly?.url, 'https://global.example.test/only')
  assert.deepEqual(merged.snapshot.sources.analysis, {
    path: 'ssh://lab/project/.phi/mcp.json',
    level: 'project'
  })
  assert.deepEqual([...merged.policy.allowedServerNames].sort(), [
    'analysis',
    'globalOnly',
    'literature'
  ])
  assert.equal(merged.policy.blockedServerReasons.has('literature'), false)
})

test('worker-side parsing rejects forged remote stdio launch shapes', () => {
  assert.deepEqual(
    remoteProjectMcpRuntimeServersValue(
      [
        {
          name: 'unsafe',
          sourcePath: 'ssh://lab/project/.mcp.json',
          config: {
            type: 'stdio',
            command: 'bash',
            args: ['-c', 'touch /tmp/nope'],
            cwd: '/local/phi'
          }
        },
        {
          name: 'wrong-host',
          sourcePath: 'ssh://lab/project/.mcp.json',
          config: {
            type: 'stdio',
            command: 'ssh',
            args: [
              '-T',
              '-o',
              'BatchMode=yes',
              '-o',
              'StrictHostKeyChecking=yes',
              '-o',
              'ForwardAgent=no',
              '-o',
              'ClearAllForwardings=yes',
              '-o',
              'SendEnv=-*',
              'other-host',
              "bash -c 'exec server'"
            ],
            cwd: '/local/phi'
          }
        },
        {
          name: 'proxy-command',
          sourcePath: 'ssh://lab/project/.mcp.json',
          config: {
            type: 'stdio',
            command: 'ssh',
            args: [
              '-T',
              '-o',
              'BatchMode=yes',
              '-o',
              'StrictHostKeyChecking=yes',
              '-o',
              'ForwardAgent=no',
              '-o',
              'ClearAllForwardings=yes',
              '-o',
              'ServerAliveInterval=10',
              '-o',
              'ServerAliveCountMax=3',
              '-o',
              'SendEnv=-*',
              '-o',
              'PermitLocalCommand=no',
              '-o',
              'RequestTTY=no',
              '-o',
              'ProxyCommand=/bin/sh -c touch /tmp/nope',
              'lab',
              "bash -c 'exec server'"
            ],
            cwd: '/local/phi',
            env: { LEAK: 'x' }
          }
        }
      ],
      '/local/phi'
    ),
    []
  )
})

test('worker-side parsing preserves an OpenSSH alias containing @ when source and argv agree', () => {
  const server = {
    name: 'analysis',
    sourcePath: 'ssh://scientist@lab/project/.phi/mcp.json',
    config: {
      type: 'stdio',
      command: 'ssh',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'SendEnv=-*',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'RequestTTY=no',
        'scientist@lab',
        SAFE_REMOTE_COMMAND
      ],
      cwd: '/local/phi',
      enabled: true
    }
  }
  assert.deepEqual(remoteProjectMcpRuntimeServersValue([server], '/local/phi'), [server])
})
