import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadRemoteProjectMcpCatalog,
  revokeRemoteProjectMcpTrust,
  trustRemoteProjectMcp,
  type RemoteProjectMcpServiceDependencies
} from '../src/main/agent/mcp/remote-project-mcp-service'
import { remoteProjectMcpRuntimeServersValue } from '../src/main/agent/mcp/remote-project-mcp-runtime'
import {
  remoteProjectMcpTrustState,
  remoteProjectMcpTrustStorePath,
  trustRemoteProjectMcpIdentity
} from '../src/main/agent/mcp/remote-project-mcp-trust-store'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { createLocalShellSession } from './helpers/localShellSession'

function fixture(): {
  root: string
  projectRoot: string
  agentDir: string
  context: {
    sessionId: string
    projectId: string
    cwd: string
    agentDir: string
  }
  dependencies: RemoteProjectMcpServiceDependencies
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-project-mcp-'))
  const projectRoot = join(root, 'server project')
  const agentDir = join(root, 'local-phi')
  mkdirSync(projectRoot, { recursive: true })
  const binding = {
    sessionId: 'session-1',
    projectId: 'project-1',
    hostAlias: 'lab',
    remoteRoot: projectRoot,
    canonicalRoot: realpathSync(projectRoot),
    cacheKey: 'test',
    config: {
      remoteRoot: projectRoot,
      canonicalRoot: realpathSync(projectRoot),
      connect: async () => createLocalShellSession(projectRoot)
    }
  }
  return {
    root,
    projectRoot,
    agentDir,
    context: {
      sessionId: binding.sessionId,
      projectId: binding.projectId,
      cwd: join(agentDir, 'workspace', binding.projectId),
      agentDir
    },
    dependencies: {
      resolveBinding: () => binding,
      resolveConnection: () => ({
        sessionId: binding.sessionId,
        projectId: binding.projectId,
        hostAlias: binding.hostAlias,
        connection: { host: binding.hostAlias }
      }),
      createHost: () => new SshHost(binding.config)
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

test('server project MCP entries stay visible but cannot enter the runtime before trust', async () => {
  const setup = fixture()
  try {
    mkdirSync(join(setup.projectRoot, '.phi'), { recursive: true })
    writeFileSync(
      join(setup.projectRoot, '.phi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          literature: { type: 'http', url: 'https://mcp.example.test/api' },
          analysis: {
            command: '/opt/tools/mcp server',
            args: ['--root', 'data set', '--literal=$(touch nope)'],
            env: { API_MODE: 'safe', TOKEN_NAME: 'not-a-secret-in-this-test' }
          }
        }
      })
    )

    const catalog = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)

    assert.deepEqual(
      catalog.summaries.map((server) => ({
        name: server.name,
        trustState: server.trustState,
        available: server.available,
        relativePath: server.relativePath
      })),
      [
        {
          name: 'analysis',
          trustState: 'pending',
          available: false,
          relativePath: '.phi/mcp.json'
        },
        {
          name: 'literature',
          trustState: 'pending',
          available: false,
          relativePath: '.phi/mcp.json'
        }
      ]
    )
    assert.deepEqual(catalog.runtimeServers, [])
    assert.deepEqual(
      catalog.summaries[0]?.confirmationItems.map((item) => ({
        kind: item.kind,
        value: item.value
      })),
      [
        { kind: 'stdio-command', value: '/opt/tools/mcp server' },
        { kind: 'stdio-arg', value: '--root' },
        { kind: 'stdio-arg', value: 'data set' },
        { kind: 'stdio-arg', value: '--literal=$(touch nope)' },
        { kind: 'stdio-env', value: 'API_MODE' },
        { kind: 'stdio-env', value: 'TOKEN_NAME' },
        { kind: 'https-url', value: 'https://mcp.example.test/api' }
      ]
    )
  } finally {
    setup.cleanup()
  }
})

test('trust requires every disclosed field before stdio receives an injection-safe SSH launch', async () => {
  const setup = fixture()
  const savedSecret = process.env.PHI_REMOTE_MCP_LOCAL_SECRET
  process.env.PHI_REMOTE_MCP_LOCAL_SECRET = 'must-not-leak'
  try {
    mkdirSync(join(setup.projectRoot, '.omp'), { recursive: true })
    const script = [
      'process.stdout.write(JSON.stringify({',
      'argv: process.argv.slice(1),',
      'cwd: process.cwd(),',
      'mode: process.env.API_MODE,',
      'leaked: process.env.PHI_REMOTE_MCP_LOCAL_SECRET',
      '}))'
    ].join('')
    writeFileSync(
      join(setup.projectRoot, '.omp', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          analysis: {
            command: process.execPath,
            args: ['-e', script, "quote' and $(touch nope)"],
            env: { API_MODE: "review's mode" }
          },
          literature: { type: 'http', url: 'https://mcp.example.test/api' }
        }
      })
    )

    const pending = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    const disclosure = pending.summaries[0]
    assert.ok(disclosure)
    const confirmedItemIds = disclosure.confirmationItems.map((item) => item.id)
    await assert.rejects(
      trustRemoteProjectMcp(
        setup.context,
        {
          relativePath: disclosure.relativePath,
          contentHash: disclosure.contentHash,
          confirmedItemIds: confirmedItemIds.slice(1)
        },
        setup.dependencies
      ),
      /逐项确认/
    )

    await trustRemoteProjectMcp(
      setup.context,
      {
        relativePath: disclosure.relativePath,
        contentHash: disclosure.contentHash,
        confirmedItemIds
      },
      setup.dependencies
    )

    assert.equal(statSync(remoteProjectMcpTrustStorePath(setup.agentDir)).mode & 0o777, 0o600)
    const trusted = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    assert.deepEqual(
      trusted.summaries.map((server) => [server.name, server.trustState, server.available]),
      [
        ['analysis', 'trusted', true],
        ['literature', 'trusted', true]
      ]
    )
    assert.deepEqual(
      trusted.runtimeServers.map((server) => server.name),
      ['analysis', 'literature']
    )
    assert.equal(
      remoteProjectMcpRuntimeServersValue(trusted.runtimeServers, setup.agentDir).length,
      2
    )

    const stdio = trusted.runtimeServers.find((server) => server.name === 'analysis')
    assert.equal(stdio?.config.command, 'ssh')
    const sshArgs = stdio?.config.args
    assert.ok(Array.isArray(sshArgs))
    assert.equal(sshArgs[0], '-T')
    assert.ok(sshArgs.includes('BatchMode=yes'))
    assert.ok(sshArgs.includes('StrictHostKeyChecking=yes'))
    assert.ok(sshArgs.includes('SendEnv=-*'))
    assert.ok(sshArgs.includes('lab'))
    const remoteCommand = sshArgs.at(-1)
    assert.equal(typeof remoteCommand, 'string')

    const localSsh = createLocalShellSession(setup.projectRoot)
    const processHandle = await localSsh.openStdio!(remoteCommand as string)
    const output: Buffer[] = []
    for await (const chunk of processHandle.stdout) output.push(Buffer.from(chunk))
    await processHandle.closed
    const result = JSON.parse(Buffer.concat(output).toString('utf8')) as {
      argv: string[]
      cwd: string
      mode: string
      leaked?: string
    }
    assert.deepEqual(result.argv, ["quote' and $(touch nope)"])
    assert.equal(result.cwd, realpathSync(setup.projectRoot))
    assert.equal(result.mode, "review's mode")
    assert.equal(result.leaked, undefined)
    assert.equal(existsSync(join(setup.projectRoot, 'nope')), false)
    assert.equal(
      trusted.runtimeServers.find((server) => server.name === 'literature')?.config.url,
      'https://mcp.example.test/api'
    )
  } finally {
    if (savedSecret === undefined) delete process.env.PHI_REMOTE_MCP_LOCAL_SECRET
    else process.env.PHI_REMOTE_MCP_LOCAL_SECRET = savedSecret
    setup.cleanup()
  }
})

test('an invalid higher-priority remote config is diagnosed without hiding other config files', async () => {
  const setup = fixture()
  try {
    mkdirSync(join(setup.projectRoot, '.phi'), { recursive: true })
    writeFileSync(join(setup.projectRoot, '.phi', 'mcp.json'), '{ invalid json')
    writeFileSync(
      join(setup.projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          literature: { url: 'https://mcp.example.test/api' }
        }
      })
    )

    const catalog = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    assert.equal(catalog.summaries.length, 2)
    assert.equal(catalog.summaries[0]?.trustState, 'invalid')
    assert.match(catalog.summaries[0]?.diagnostics[0] ?? '', /不是有效 JSON/)
    assert.equal(catalog.summaries[1]?.name, 'literature')
    assert.equal(catalog.summaries[1]?.trustState, 'pending')
    assert.deepEqual(catalog.runtimeServers, [])
  } finally {
    setup.cleanup()
  }
})

test('content changes withdraw runtime MCP until re-trusted and revoke returns to pending', async () => {
  const setup = fixture()
  const configPath = join(setup.projectRoot, '.mcp.json')
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { api: { url: 'https://one.example.test/mcp' } } })
    )
    const pending = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    const first = pending.summaries[0]
    assert.ok(first)
    await trustRemoteProjectMcp(
      setup.context,
      {
        relativePath: first.relativePath,
        contentHash: first.contentHash,
        confirmedItemIds: first.confirmationItems.map((item) => item.id)
      },
      setup.dependencies
    )

    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { api: { url: 'https://two.example.test/mcp' } } })
    )
    const changed = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    assert.equal(changed.summaries[0]?.trustState, 'changed')
    assert.deepEqual(changed.runtimeServers, [])
    await assert.rejects(
      trustRemoteProjectMcp(
        setup.context,
        {
          relativePath: first.relativePath,
          contentHash: first.contentHash,
          confirmedItemIds: first.confirmationItems.map((item) => item.id)
        },
        setup.dependencies
      ),
      /已变化/
    )

    const next = changed.summaries[0]
    assert.ok(next)
    await trustRemoteProjectMcp(
      setup.context,
      {
        relativePath: next.relativePath,
        contentHash: next.contentHash,
        confirmedItemIds: next.confirmationItems.map((item) => item.id)
      },
      setup.dependencies
    )
    assert.equal(
      (await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)).summaries[0]
        ?.trustState,
      'trusted'
    )
    await revokeRemoteProjectMcpTrust(
      setup.context,
      { relativePath: next.relativePath, contentHash: next.contentHash },
      setup.dependencies
    )
    const revoked = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    assert.equal(revoked.summaries[0]?.trustState, 'pending')
    assert.deepEqual(revoked.runtimeServers, [])
  } finally {
    setup.cleanup()
  }
})

test('project config symlinks cannot escape the canonical server project root', async () => {
  const setup = fixture()
  try {
    const outside = join(setup.root, 'outside-mcp.json')
    writeFileSync(
      outside,
      JSON.stringify({ mcpServers: { escaped: { url: 'https://escaped.example.test/mcp' } } })
    )
    mkdirSync(join(setup.projectRoot, '.pi'), { recursive: true })
    symlinkSync(outside, join(setup.projectRoot, '.pi', 'mcp.json'))

    const catalog = await loadRemoteProjectMcpCatalog(setup.context, setup.dependencies)
    assert.equal(catalog.summaries.length, 1)
    assert.equal(catalog.summaries[0]?.trustState, 'invalid')
    assert.match(catalog.summaries[0]?.diagnostics[0] ?? '', /符号链接|项目|workspace|outside/u)
    assert.equal(
      catalog.summaries.some((server) => server.name === 'escaped'),
      false
    )
    assert.deepEqual(catalog.runtimeServers, [])
  } finally {
    setup.cleanup()
  }
})

test('remote MCP trust is isolated by host alias and canonical project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-mcp-trust-scope-'))
  const agentDir = join(root, 'agent')
  const identity = {
    hostAlias: 'lab-a',
    projectRoot: '/srv/project-a',
    relativePath: '.phi/mcp.json',
    contentHash: 'a'.repeat(64)
  }
  try {
    trustRemoteProjectMcpIdentity(identity, agentDir)
    assert.equal(remoteProjectMcpTrustState(identity, agentDir), 'trusted')
    assert.equal(
      remoteProjectMcpTrustState({ ...identity, hostAlias: 'lab-b' }, agentDir),
      'pending'
    )
    assert.equal(
      remoteProjectMcpTrustState({ ...identity, projectRoot: '/srv/project-b' }, agentDir),
      'pending'
    )
    assert.equal(
      remoteProjectMcpTrustState({ ...identity, relativePath: '.mcp.json' }, agentDir),
      'pending'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
