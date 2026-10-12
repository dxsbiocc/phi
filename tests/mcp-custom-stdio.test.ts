import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { describeEnvironment } from '../src/main/agent/content'
import { currentPlatform } from '../src/main/agent/envs'
import { refreshManagedStdioServers, resolveManagedEnvironment } from '../src/main/agent/mcp'
import {
  addLocalMcpConnector,
  buildLocalStdioEntry,
  listLocalMcpRuntimes,
  removeLocalMcpConnector,
  validateLocalConnectorRequest
} from '../src/main/agent/mcp/custom-stdio'
import { copyMinimal, installReady, shell } from './helpers/fakeEnvironment'

function invocation(entry: { command: string; args: string[] }): {
  env: Record<string, string>
  command: string
  args: string[]
} {
  assert.equal(entry.command, '/usr/bin/env')
  assert.equal(entry.args[0], '-i')
  const env: Record<string, string> = {}
  let index = 1
  for (; index < entry.args.length; index += 1) {
    const value = entry.args[index] ?? ''
    const equals = value.indexOf('=')
    if (equals <= 0 || value.startsWith('/')) break
    env[value.slice(0, equals)] = value.slice(equals + 1)
  }
  return { env, command: entry.args[index] ?? '', args: entry.args.slice(index + 1) }
}

test('validates environment and host local stdio requests without shell parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-validation-'))
  try {
    const cwd = join(root, 'workspace')
    const command = join(root, 'server')
    mkdirSync(cwd)
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)

    assert.deepEqual(
      validateLocalConnectorRequest({
        name: 'local_env',
        runtime: { kind: 'environment', ref: 'phi:python@1' },
        command: 'mcp-server',
        args: ['--stdio', 'one argument'],
        env: { LOG_LEVEL: 'info' },
        cwd
      }),
      {
        name: 'local_env',
        runtime: { kind: 'environment', ref: 'phi:python@1' },
        command: 'mcp-server',
        args: ['--stdio', 'one argument'],
        env: { LOG_LEVEL: 'info' },
        cwd
      }
    )
    assert.equal(
      validateLocalConnectorRequest({
        name: 'local-host',
        runtime: { kind: 'host' },
        command,
        args: [],
        env: {}
      }).command,
      command
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validates only Bun x and run subcommands with the existing argument and env limits', () => {
  const agentDir = join(mkdtempSync(join(tmpdir(), 'phi-custom-stdio-bun-validation-')), 'agent')
  const valid = {
    name: 'bun-server',
    runtime: { kind: 'bun' as const },
    command: 'x',
    args: ['--bun', 'qq-email-mcp@0.1.1'],
    env: { HTTPS_PROXY: 'https://proxy.example' }
  }
  try {
    assert.deepEqual(validateLocalConnectorRequest(valid, { agentDir }), valid)
    assert.equal(
      validateLocalConnectorRequest(
        { ...valid, command: 'run', args: ['/tmp/server.ts'] },
        {
          agentDir
        }
      ).command,
      'run'
    )
    for (const command of ['install', 'add', 'create', 'upgrade', 'pm', 'repl', 'exec']) {
      assert.throws(
        () => validateLocalConnectorRequest({ ...valid, command }, { agentDir }),
        /Bun.*x.*run|x.*run/
      )
    }
    assert.throws(
      () =>
        validateLocalConnectorRequest(
          { ...valid, args: Array.from({ length: 65 }, () => 'x') },
          { agentDir }
        ),
      /64/
    )
    assert.throws(
      () =>
        validateLocalConnectorRequest({ ...valid, env: { BUN_INSTALL: '/tmp/bun' } }, { agentDir }),
      /保留/
    )
  } finally {
    rmSync(dirname(agentDir), { recursive: true, force: true })
  }
})

test('validation can use an injected filesystem without touching host paths', () => {
  const fileSystem = {
    access: (): void => undefined,
    realpath: (path: string): string => path,
    stat: (path: string): { isDirectory: () => boolean; isFile: () => boolean } => ({
      isDirectory: () => path === '/virtual/workspace',
      isFile: () => path === '/virtual/server'
    }),
    readConfig: (): { mcpServers: Record<string, unknown> } => ({ mcpServers: {} }),
    writeConfig: (): void => undefined
  }
  assert.deepEqual(
    validateLocalConnectorRequest(
      {
        name: 'virtual-host',
        runtime: { kind: 'host' },
        command: '/virtual/server',
        args: [],
        env: {},
        cwd: '/virtual/workspace'
      },
      { agentDir: '/virtual/agent', catalogIds: [], fileSystem }
    ),
    {
      name: 'virtual-host',
      runtime: { kind: 'host' },
      command: '/virtual/server',
      args: [],
      env: {},
      cwd: '/virtual/workspace'
    }
  )
})

test('rejects unsafe local stdio input and reserved or existing names', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-invalid-'))
  try {
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'workspace')
    const command = join(root, 'server')
    mkdirSync(agentDir)
    mkdirSync(cwd)
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o600)
    writeFileSync(
      join(agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'existing-server' } } })
    )
    const valid = {
      name: 'local-server',
      runtime: { kind: 'environment', ref: 'phi:python@1' },
      command: 'mcp-server',
      args: [],
      env: {}
    }
    const options = { agentDir, catalogIds: ['catalog-server'] }
    const rejects = (overrides: Record<string, unknown>, pattern: RegExp): void => {
      assert.throws(
        () => validateLocalConnectorRequest({ ...valid, ...overrides }, options),
        pattern
      )
    }

    rejects({ name: 'existing' }, /已有|冲突/)
    rejects({ name: 'catalog-server' }, /目录冲突/)
    rejects({ name: 'Catalog-Server' }, /目录冲突/)
    rejects({ name: 'tavily' }, /目录冲突/)
    rejects({ command: '../mcp-server' }, /命令名/)
    rejects({ command: 'bad\ncommand' }, /换行/)
    rejects({ runtime: { kind: 'environment', ref: 'phi:Python@1' } }, /环境引用/)
    rejects({ args: Array.from({ length: 65 }, () => 'x') }, /64/)
    rejects({ args: ['x'.repeat(4097)] }, /4096/)
    rejects({ env: { path: 'x' } }, /名称无效/)
    for (const name of [
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'PHI_TOKEN',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'PYTHONPATH',
      'PYTHONHOME',
      'NODE_OPTIONS',
      'NODE_PATH',
      'BUN_INSTALL',
      'CONDA_PREFIX',
      'R_LIBS_USER',
      'JAVA_TOOL_OPTIONS',
      'BASH_ENV',
      'ENV',
      'IFS'
    ]) {
      rejects({ env: { [name]: 'unsafe' } }, /保留/)
    }
    rejects({ cwd: 'relative' }, /绝对路径/)
    rejects({ cwd: join(root, 'missing') }, /不存在/)
    rejects({ runtime: { kind: 'host' }, command: 'server' }, /绝对路径/)
    rejects({ runtime: { kind: 'host' }, command: join(root, 'missing') }, /不存在|可执行/)
    rejects({ runtime: { kind: 'host' }, command }, /可执行/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('builds an isolated environment entry with user metadata and no package ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-environment-'))
  try {
    const runtimeRoot = join(root, 'runtime')
    const environmentsDir = join(root, 'environments')
    const platform = currentPlatform()
    copyMinimal(join(environmentsDir, 'phi-python'))
    const descriptor = describeEnvironment('phi:python@1', { environmentsDir, platform })
    const envId = installReady(runtimeRoot, descriptor, {
      'mcp-server': shell(['exec cat'])
    })
    const request = {
      name: 'local-server',
      runtime: { kind: 'environment' as const, ref: 'phi:python@1' },
      command: 'mcp-server',
      args: ['--stdio', 'one argument'],
      env: { LOG_LEVEL: 'info', ZETA: 'last' }
    }
    const entry = buildLocalStdioEntry(request, {
      root: runtimeRoot,
      environmentsDir,
      platform,
      baseEnv: { HOME: '/Users/tester', PATH: '/host/bin' }
    })
    const call = invocation(entry)

    assert.equal(call.env.PHI_ENV_ID, envId)
    assert.equal(call.env.LOG_LEVEL, 'info')
    assert.equal(call.env.ZETA, 'last')
    assert.equal(call.env.PATH?.includes('/host/bin'), false)
    assert.equal(call.command, join(runtimeRoot, 'envs', envId, 'bin', 'mcp-server'))
    assert.deepEqual(call.args, ['--stdio', 'one argument'])
    assert.equal(entry.phiOrigin, 'user-stdio')
    assert.deepEqual(entry.phiUser, { runtime: request.runtime, env: request.env })
    assert.equal(entry.enabled, undefined)
    assert.equal(entry.phiManaged.packageId, undefined)
    assert.equal(entry.phiManaged.packageDir, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed refresh keeps user variables and local ownership after an environment id change', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-refresh-'))
  try {
    const runtimeRoot = join(root, 'runtime')
    const environmentsDir = join(root, 'environments')
    const platform = currentPlatform()
    copyMinimal(join(environmentsDir, 'phi-python'))
    installReady(runtimeRoot, describeEnvironment('phi:python@1', { environmentsDir, platform }), {
      'mcp-server': shell(['exec cat'])
    })
    const lookup = { root: runtimeRoot, environmentsDir, platform }
    const entry = buildLocalStdioEntry(
      {
        name: 'local-server',
        runtime: { kind: 'environment', ref: 'phi:python@1' },
        command: 'mcp-server',
        args: ['--stdio'],
        env: { LOG_LEVEL: 'debug' }
      },
      lookup
    )
    const stale = {
      ...entry,
      args: ['-i', '/usr/bin/false'],
      phiManaged: { ...entry.phiManaged, envId: 'old-environment' }
    }
    const result = refreshManagedStdioServers({ mcpServers: { local: stale } }, (request) =>
      resolveManagedEnvironment(request, lookup)
    )
    const refreshed = result.config.mcpServers?.local as typeof entry

    assert.deepEqual(result.refreshed, ['local'])
    assert.equal(refreshed.phiOrigin, 'user-stdio')
    assert.deepEqual(refreshed.phiUser, entry.phiUser)
    assert.equal(invocation(refreshed).env.LOG_LEVEL, 'debug')
    assert.deepEqual(invocation(refreshed).args, ['--stdio'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('builds a host entry with a sanitized host environment and no managed marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-host-'))
  try {
    const command = join(root, 'server')
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)
    const request = validateLocalConnectorRequest(
      {
        name: 'host-server',
        runtime: { kind: 'host' },
        command,
        args: ['--stdio', 'one argument'],
        env: { LOG_LEVEL: 'info' }
      },
      { agentDir: join(root, 'agent') }
    )
    const entry = buildLocalStdioEntry(request, {
      root: join(root, 'runtime'),
      baseEnv: {
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: '/Users/tester',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp/host',
        PYTHONPATH: '/unsafe/python',
        PHI_SECRET: 'must-not-leak'
      }
    })
    const call = invocation(entry)

    assert.equal(call.env.PATH, '/opt/homebrew/bin:/usr/bin')
    assert.equal(call.env.HOME, '/Users/tester')
    assert.equal(call.env.LANG, 'en_US.UTF-8')
    assert.equal(call.env.TMPDIR, '/tmp/host')
    assert.equal(call.env.LOG_LEVEL, 'info')
    assert.equal(call.env.PYTHONPATH, undefined)
    assert.equal(call.env.PHI_SECRET, undefined)
    assert.equal(call.command, command)
    assert.deepEqual(call.args, ['--stdio', 'one argument'])
    assert.equal(entry.phiOrigin, 'user-stdio')
    assert.deepEqual(entry.phiUser, { runtime: { kind: 'host' }, env: { LOG_LEVEL: 'info' } })
    assert.equal('phiManaged' in entry, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('host and Bun entries share the full safe host allowlist while excluding secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-env-parity-'))
  try {
    const hostCommand = join(root, 'server')
    const bun = join(root, 'Phi Bun', 'bun')
    const runtimeRoot = join(root, 'runtime')
    mkdirSync(dirname(bun), { recursive: true })
    writeFileSync(hostCommand, '#!/bin/sh\nexit 0\n')
    writeFileSync(bun, '#!/bin/sh\nexit 0\n')
    chmodSync(hostCommand, 0o700)
    chmodSync(bun, 0o700)
    const baseEnv = {
      PATH: '/user/bin:/usr/bin',
      HOME: '/Users/tester',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/host',
      TZ: 'Asia/Shanghai',
      HTTPS_PROXY: 'https://parent-proxy.example',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      LC_MESSAGES: 'zh_CN.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
      HTTP_PROXY: 'bad\nvalue'
    }
    const hostEntry = buildLocalStdioEntry(
      {
        name: 'host-server',
        runtime: { kind: 'host' },
        command: hostCommand,
        args: [],
        env: { HTTPS_PROXY: 'https://user-proxy.example' }
      },
      { root: runtimeRoot, baseEnv }
    )
    const bunEntry = buildLocalStdioEntry(
      {
        name: 'bun-server',
        runtime: { kind: 'bun' },
        command: 'x',
        args: ['--bun', 'qq-email-mcp@0.1.1'],
        env: { HTTPS_PROXY: 'https://user-proxy.example' }
      },
      { root: runtimeRoot, baseEnv, resolveBunExecutable: () => bun }
    )

    for (const env of [invocation(hostEntry).env, invocation(bunEntry).env]) {
      assert.equal(env.USER, userInfo().username)
      assert.equal(env.LOGNAME, userInfo().username)
      assert.equal(env.TZ, 'Asia/Shanghai')
      assert.equal(env.HTTPS_PROXY, 'https://user-proxy.example')
      assert.equal(env.SSL_CERT_FILE, '/etc/ssl/cert.pem')
      assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh.sock')
      assert.equal(env.LC_MESSAGES, 'zh_CN.UTF-8')
      assert.equal(env.HTTP_PROXY, undefined)
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
      assert.equal(env.GITHUB_TOKEN, undefined)
    }
    assert.equal(invocation(hostEntry).env.PATH, '/user/bin:/usr/bin')
    assert.equal(invocation(bunEntry).env.PATH, `${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`)
    assert.equal(invocation(bunEntry).command, bun)
    assert.deepEqual(invocation(bunEntry).args, ['x', '--bun', 'qq-email-mcp@0.1.1'])
    const cacheDir = join(runtimeRoot, 'cache', 'bun-user')
    assert.equal(invocation(bunEntry).env.BUN_INSTALL_CACHE_DIR, cacheDir)
    assert.equal(statSync(cacheDir).mode & 0o777, 0o700)
    assert.equal('phiManaged' in bunEntry, false)
    assert.deepEqual(bunEntry.phiUser, {
      runtime: { kind: 'bun' },
      env: { HTTPS_PROXY: 'https://user-proxy.example' }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unresolved or non-absolute Bun fails before probing, writing config, or creating cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-no-bun-'))
  try {
    const agentDir = join(root, 'agent')
    const runtimeRoot = join(root, 'runtime')
    mkdirSync(agentDir)
    const configPath = join(agentDir, 'mcp.json')
    const initial = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
    writeFileSync(configPath, initial)
    let probed = false
    const request = {
      name: 'bun-server',
      runtime: { kind: 'bun' as const },
      command: 'run',
      args: ['/tmp/server.ts'],
      env: {}
    }
    for (const resolveBunExecutable of [
      (): string => {
        throw new Error('missing')
      },
      (): string => 'relative/bun'
    ]) {
      await assert.rejects(
        addLocalMcpConnector(request, {
          agentDir,
          runtimeRoot,
          resolveBunExecutable,
          probe: async () => {
            probed = true
            return []
          }
        }),
        /找不到内置 Bun/
      )
    }
    assert.equal(probed, false)
    assert.equal(readFileSync(configPath, 'utf8'), initial)
    assert.equal(statExists(join(runtimeRoot, 'cache', 'bun-user')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('host user variables cannot override host contract assignments', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-host-env-'))
  try {
    const command = join(root, 'server')
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)
    for (const name of ['LANG', 'TMPDIR']) {
      assert.throws(
        () =>
          buildLocalStdioEntry(
            {
              name: 'host-server',
              runtime: { kind: 'host' },
              command,
              args: [],
              env: { [name]: 'override' }
            },
            { root: join(root, 'runtime') }
          ),
        new RegExp(name)
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probes before an atomic config write and returns discovered tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-add-'))
  try {
    const agentDir = join(root, 'agent')
    const command = join(root, 'server')
    mkdirSync(agentDir)
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)
    const path = join(agentDir, 'mcp.json')
    const initial = JSON.stringify({ settings: { keep: true }, mcpServers: {} }, null, 2)
    writeFileSync(path, `${initial}\n`)
    const request = {
      name: 'host-server',
      runtime: { kind: 'host' as const },
      command,
      args: ['--stdio'],
      env: { LOG_LEVEL: 'info' }
    }
    const seen: unknown[] = []

    await assert.rejects(
      addLocalMcpConnector(request, {
        agentDir,
        runtimeRoot: join(root, 'runtime'),
        probe: async (probeRequest) => {
          seen.push(probeRequest)
          throw new Error('fixture probe failed')
        }
      }),
      /fixture probe failed/
    )
    assert.equal(readFileSync(path, 'utf8'), `${initial}\n`)

    const result = await addLocalMcpConnector(request, {
      agentDir,
      runtimeRoot: join(root, 'runtime'),
      probe: async (probeRequest) => {
        seen.push(probeRequest)
        return ['search', 'fetch']
      }
    })
    assert.deepEqual(result, { tools: ['search', 'fetch'] })
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      settings: unknown
      mcpServers: Record<string, Record<string, unknown>>
    }
    assert.deepEqual(config.settings, { keep: true })
    assert.equal(config.mcpServers['host-server']?.enabled, true)
    assert.equal(config.mcpServers['host-server']?.phiOrigin, 'user-stdio')
    assert.equal(seen.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing managed environment fails clearly without probing or host fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-not-ready-'))
  try {
    const agentDir = join(root, 'agent')
    const environmentsDir = join(root, 'environments')
    mkdirSync(agentDir)
    copyMinimal(join(environmentsDir, 'phi-python'))
    const path = join(agentDir, 'mcp.json')
    const initial = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
    writeFileSync(path, initial)
    let probed = false

    await assert.rejects(
      addLocalMcpConnector(
        {
          name: 'env-server',
          runtime: { kind: 'environment', ref: 'phi:python@1' },
          command: 'mcp-server',
          args: [],
          env: {}
        },
        {
          agentDir,
          runtimeRoot: join(root, 'runtime'),
          environmentsDir,
          platform: currentPlatform(),
          probe: async () => {
            probed = true
            return []
          }
        }
      ),
      /运行环境尚未就绪，请先在环境页构建/
    )
    assert.equal(probed, false)
    assert.equal(readFileSync(path, 'utf8'), initial)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent adds for the same name serialize so only one can win', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-concurrent-'))
  try {
    const agentDir = join(root, 'agent')
    const command = join(root, 'server')
    mkdirSync(agentDir)
    writeFileSync(command, '#!/bin/sh\nexit 0\n')
    chmodSync(command, 0o700)
    const request = {
      name: 'same-server',
      runtime: { kind: 'host' as const },
      command,
      args: [],
      env: {}
    }
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    let probes = 0
    const deps = {
      agentDir,
      runtimeRoot: join(root, 'runtime'),
      probe: async (): Promise<string[]> => {
        probes += 1
        await probeGate
        return ['tool']
      }
    }
    const first = addLocalMcpConnector(request, deps)
    const second = addLocalMcpConnector(request, deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(probes, 1)
    releaseProbe()
    const results = await Promise.allSettled([first, second])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    assert.match(String(rejected && rejected.status === 'rejected' ? rejected.reason : ''), /已有/)
    assert.equal(probes, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removal requires exact user-stdio ownership and never removes other entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-remove-'))
  try {
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const path = join(agentDir, 'mcp.json')
    const writeFixture = (): void => {
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            settings: { keep: true },
            mcpServers: {
              owned: {
                command: '/usr/bin/env',
                args: ['-i', '/bin/true'],
                phiOrigin: 'user-stdio'
              },
              handwritten: { command: 'custom-server' },
              packaged: { command: '/usr/bin/env', phiPackage: 'packaged' }
            }
          },
          null,
          2
        )}\n`
      )
    }
    writeFixture()
    const before = readFileSync(path, 'utf8')

    assert.throws(
      () => removeLocalMcpConnector('handwritten', { agentDir }),
      /只能移除通过本地 stdio 添加的连接器/
    )
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.throws(
      () => removeLocalMcpConnector('packaged', { agentDir }),
      /只能移除通过本地 stdio 添加的连接器/
    )
    assert.equal(readFileSync(path, 'utf8'), before)

    removeLocalMcpConnector('owned', { agentDir })
    const remaining = JSON.parse(readFileSync(path, 'utf8')) as {
      settings: unknown
      mcpServers: Record<string, unknown>
    }
    assert.deepEqual(remaining.settings, { keep: true })
    assert.deepEqual(Object.keys(remaining.mcpServers).sort(), ['handwritten', 'packaged'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local runtime choices include ready base Phi environments and resolvable Bun', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-runtimes-'))
  try {
    const runtimeRoot = join(root, 'runtime')
    const environmentsDir = join(root, 'environments')
    const agentDir = join(root, 'agent')
    const platform = currentPlatform()
    copyMinimal(join(environmentsDir, 'phi-python'))
    copyMinimal(join(environmentsDir, 'phi-r'), 'phi-r')
    installReady(
      runtimeRoot,
      describeEnvironment('phi:python@1', { environmentsDir, platform }),
      {}
    )

    const runtimes = await listLocalMcpRuntimes({
      root: runtimeRoot,
      environmentsDir,
      agentDir,
      platform,
      resolveBunExecutable: () =>
        '/Applications/Phi.app/Contents/Resources/runtime/bun/darwin-arm64/bun'
    })
    assert.deepEqual(runtimes, [
      { ref: 'phi:python@1', label: runtimes[0]?.label },
      { ref: 'bun', label: 'Phi 内置 Bun', kind: 'bun' }
    ])
    assert.ok(runtimes[0]?.label)
    assert.deepEqual(
      await listLocalMcpRuntimes({
        root: runtimeRoot,
        environmentsDir,
        agentDir,
        platform,
        resolveBunExecutable: () => {
          throw new Error('missing')
        }
      }),
      [{ ref: 'phi:python@1', label: runtimes[0]!.label }]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

test('host command keeps the path the user gave so venv-style symlinks still resolve themselves', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-custom-stdio-symlink-'))
  try {
    const target = join(root, 'interpreter')
    const link = join(root, 'venv-python')
    writeFileSync(target, '#!/bin/sh\nexit 0\n')
    chmodSync(target, 0o700)
    symlinkSync(target, link)
    const request = validateLocalConnectorRequest(
      { name: 'venv_server', runtime: { kind: 'host' }, command: link, args: [], env: {} },
      { agentDir: join(root, 'agent') }
    )
    assert.equal(request.command, link)
    assert.throws(
      () =>
        validateLocalConnectorRequest(
          {
            name: 'dangling',
            runtime: { kind: 'host' },
            command: join(root, 'missing-link'),
            args: [],
            env: {}
          },
          { agentDir: join(root, 'agent') }
        ),
      /不存在/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
