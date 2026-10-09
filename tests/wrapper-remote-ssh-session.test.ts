import assert from 'node:assert/strict'
import { execSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildControlArgs,
  buildExecArgs,
  buildExistsCommand,
  buildMasterArgs,
  buildMkdirpCommand,
  buildReadTextFileCommand,
  buildSftpArgs,
  buildWriteTextFileCommand,
  connectRemoteSshSession,
  quoteSftpPath,
  shellQuote,
  validateHostAlias,
  type OpenSshRuntime
} from '../src/main/agent/wrappers/remote-ssh-session'
import { RemoteSshConnectionError } from '../src/main/agent/wrappers/remote-ssh-diagnostics'

function runInRealBash(command: string): { stdout: string; code: number } {
  try {
    return { stdout: execSync(command, { shell: '/bin/bash', encoding: 'utf-8' }), code: 0 }
  } catch (error) {
    const err = error as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', code: err.status ?? 1 }
  }
}

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-remote-ssh-test-'))
  try {
    return callback(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('generated remote file commands are valid shell and preserve text byte-for-byte', () => {
  withTempDir((dir) => {
    const path = join(dir, "file with 'quotes'.txt")
    const content = 'line with $VAR and `backticks`\n__PHI_EOF__\nlast line'
    const commands = [
      buildMkdirpCommand(dir),
      buildExistsCommand(path),
      buildReadTextFileCommand(path),
      buildWriteTextFileCommand(path)
    ]
    for (const command of commands) {
      assert.equal(runInRealBash(`bash -n -c ${shellQuote(command)}`).code, 0)
    }
    execSync(buildWriteTextFileCommand(path), { shell: '/bin/bash', input: content })
    assert.equal(readFileSync(path, 'utf-8'), content)
    assert.equal(runInRealBash(buildReadTextFileCommand(path)).stdout, content)
    assert.equal(runInRealBash(buildExistsCommand(path)).code, 0)
    assert.equal(runInRealBash(buildExistsCommand(join(dir, 'missing'))).code, 1)
  })
})

test('OpenSSH arguments enforce known hosts and reject option-shaped aliases', () => {
  const master = buildMasterArgs('lab-hpc', '/tmp/phi-ssh-test/master')
  const exec = buildExecArgs('lab-hpc', '/tmp/phi-ssh-test/master', 'printf ok')
  const sftp = buildSftpArgs('lab-hpc', '/tmp/phi-ssh-test/master')
  const check = buildControlArgs('lab-hpc', '/tmp/phi-ssh-test/master', 'check')
  const exit = buildControlArgs('lab-hpc', '/tmp/phi-ssh-test/master', 'exit')
  for (const args of [master, exec, sftp, check, exit]) {
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    assert.ok(args.includes('ForwardAgent=no'))
    assert.ok(args.includes('ClearAllForwardings=yes'))
    assert.equal(args.includes('-F'), false)
  }
  assert.equal(master.at(-1), 'lab-hpc')
  assert.equal(sftp.at(-1), 'lab-hpc')
  assert.equal(exec.at(-1), 'printf ok')
  assert.equal(exec.at(-2), 'lab-hpc')
  for (const host of ['-oProxyCommand=evil', 'host;evil', 'host name', '']) {
    assert.throws(() => validateHostAlias(host))
  }
  assert.equal(quoteSftpPath('a "quoted" path'), '"a \\"quoted\\" path"')
  assert.throws(() => quoteSftpPath('bad\npath'))
})

test('manual user, port and key apply to master, commands, control and SFTP', () => {
  const config = { host: 'lab-hpc', user: 'scientist', port: 22022, identityFile: '/tmp/lab-key' }
  const commands = [
    buildMasterArgs(config.host, '/tmp/master', config),
    buildExecArgs(config.host, '/tmp/master', 'true', config),
    buildControlArgs(config.host, '/tmp/master', 'check', config)
  ]
  for (const args of commands) {
    assert.deepEqual(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2), ['-l', 'scientist'])
    assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '22022'])
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/tmp/lab-key'])
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    assert.ok(args.includes('BatchMode=yes'))
  }
  const sftp = buildSftpArgs(config.host, '/tmp/master', config)
  assert.ok(sftp.includes('User=scientist'))
  assert.deepEqual(sftp.slice(sftp.indexOf('-P'), sftp.indexOf('-P') + 2), ['-P', '22022'])
  assert.deepEqual(sftp.slice(sftp.indexOf('-i'), sftp.indexOf('-i') + 2), ['-i', '/tmp/lab-key'])
  assert.throws(
    () => buildMasterArgs('lab-hpc', '/tmp/master', { host: 'lab-hpc', user: '-evil' }),
    /用户名/
  )
  assert.throws(
    () => buildMasterArgs('lab-hpc', '/tmp/master', { host: 'lab-hpc', port: 0 }),
    /端口/
  )
})

test('system OpenSSH resolves user, port, identity and jump host from a host alias', () => {
  withTempDir((dir) => {
    const config = join(dir, 'config')
    writeFileSync(
      config,
      [
        'Host lab-hpc',
        '  HostName compute.example.invalid',
        '  User scientist',
        '  Port 22022',
        `  IdentityFile ${join(dir, 'test-key')}`,
        '  ProxyJump jump.example.invalid',
        ''
      ].join('\n')
    )
    const result = spawnSync(
      'ssh',
      ['-G', '-F', config, ...buildMasterArgs('lab-hpc', join(dir, 'master'))],
      { encoding: 'utf-8' }
    )
    assert.equal(result.status, 0, result.stderr)
    for (const line of [
      'hostname compute.example.invalid',
      'user scientist',
      'port 22022',
      `identityfile ${join(dir, 'test-key')}`,
      'proxyjump jump.example.invalid',
      'batchmode yes',
      'stricthostkeychecking true',
      'forwardagent no',
      'clearallforwardings yes'
    ]) {
      assert.ok(result.stdout.split('\n').includes(line), `${line} missing from ssh -G output`)
    }
  })
})

const localSftpServer = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find((path) =>
  existsSync(path)
)

test(
  'SFTP batch quoting transfers byte-exact files with spaces and quotes',
  {
    skip: !localSftpServer
  },
  () => {
    withTempDir((dir) => {
      const source = join(dir, `input 'single' "double".txt`)
      const dest = join(dir, `output 'single' "double".txt`)
      writeFileSync(source, 'hello sftp\n')
      const result = spawnSync(
        'sftp',
        ['-q', '-D', localSftpServer as string, '-b', '-', 'localhost'],
        { input: `put ${quoteSftpPath(source)} ${quoteSftpPath(dest)}\n`, encoding: 'utf-8' }
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(dest, 'utf-8'), 'hello sftp\n')
    })
  }
)

type SpawnRecord = { binary: string; args: string[] }

/** An actual child-process fake for the OpenSSH wire: command channels run local Bash. */
function fakeOpenSsh(
  options: {
    checkFails?: boolean
    slowExec?: boolean
    startupError?: string
    missingSsh?: boolean
    execError?: string
  } = {}
): {
  runtime: OpenSshRuntime
  calls: SpawnRecord[]
} {
  const calls: SpawnRecord[] = []
  const spawnImpl = (
    binary: string,
    args: string[],
    spawnOptions: { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams => {
    calls.push({ binary, args })
    if (binary === 'ssh' && args.includes('-M')) {
      if (options.missingSsh) return spawn('/missing-phi-ssh-test-binary', [], spawnOptions)
      if (options.startupError) {
        return spawn(
          process.execPath,
          ['-e', 'process.stderr.write(process.argv[1]); process.exit(255)', options.startupError],
          spawnOptions
        )
      }
      return spawn('/bin/sh', ['-c', 'exec sleep 30'], spawnOptions)
    }
    if (binary === 'ssh' && args.includes('-O')) {
      const action = args[args.indexOf('-O') + 1]
      return spawn(
        '/bin/sh',
        [
          '-c',
          action === 'check' && (options.checkFails || options.startupError || options.missingSsh)
            ? 'exit 1'
            : 'exit 0'
        ],
        spawnOptions
      )
    }
    if (binary === 'ssh') {
      if (options.execError) {
        return spawn(
          process.execPath,
          ['-e', 'process.stderr.write(process.argv[1]); process.exit(255)', options.execError],
          spawnOptions
        )
      }
      return spawn(
        '/bin/bash',
        ['-c', options.slowExec ? 'sleep 5' : (args.at(-1) ?? '')],
        spawnOptions
      )
    }
    if (binary === 'sftp') return spawn('/bin/cat', [], spawnOptions)
    throw new Error(`unexpected binary ${binary}`)
  }
  return { runtime: { spawnImpl }, calls }
}

test('OpenSSH session uses one private master and executes file operations through it', async () => {
  const fixture = fakeOpenSsh()
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  try {
    const masterArgs = fixture.calls.find((call) => call.args.includes('-M'))?.args
    assert.ok(masterArgs)
    const controlPath = masterArgs[masterArgs.indexOf('-S') + 1]
    assert.equal(statSync(controlPath.slice(0, controlPath.lastIndexOf('/'))).mode & 0o777, 0o700)

    const result = await session.exec('printf hello')
    assert.deepEqual(result, { stdout: 'hello', stderr: '', code: 0, signal: null })
    const inputResult = await session.execWithInput?.('wc -c', 'α\nβ')
    assert.equal(inputResult?.stdout.trim(), '5')
    const dir = mkdtempSync(join(tmpdir(), 'phi-remote-session-'))
    try {
      const remoteDir = join(dir, 'nested')
      const remoteFile = join(remoteDir, 'params.json')
      await session.mkdirp(remoteDir)
      await session.writeTextFile(remoteFile, '{"value":1}')
      assert.equal(await session.exists(remoteFile), true)
      assert.equal(await session.readTextFile(remoteFile), '{"value":1}')
      await session.uploadFile(remoteFile, join(remoteDir, 'bundle.tar.gz'))
      assert.ok(fixture.calls.some((call) => call.binary === 'sftp' && call.args.includes('-b')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    await session.close()
  }
  assert.ok(fixture.calls.some((call) => call.args.includes('exit') && call.args.includes('-O')))
  assert.equal(
    fixture.calls.some((call) => call.args.at(-1)?.startsWith('kill ')),
    false
  )
})

test('closing an OpenSSH session terminates its raw stdio channel', async () => {
  const fixture = fakeOpenSsh()
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  assert.ok(session.openStdio)
  const channel = await session.openStdio('cat')
  const echoed = new Promise<string>((resolve) =>
    channel.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
  )
  channel.stdin.write('helper-frame')

  assert.equal(await echoed, 'helper-frame')
  const closed = channel.closed
  await session.close()
  const result = await closed
  assert.ok(result.signal || result.code !== null)
})

test('writeTextFile streams content over stdin so large files never hit the argv limit', async () => {
  const fixture = fakeOpenSsh()
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  const dir = mkdtempSync(join(tmpdir(), 'phi-remote-session-'))
  try {
    // A wrapper bundle's file list: well past Linux's 128 KiB single-argument limit.
    const content = 'modules/nf-core/x/main.nf 0123456789abcdef\n'.repeat(8000)
    const noTrailingNewline = 'last line without newline'
    await session.writeTextFile(join(dir, 'manifest.txt'), content)
    await session.writeTextFile(join(dir, 'tail.txt'), noTrailingNewline)
    assert.equal(readFileSync(join(dir, 'manifest.txt'), 'utf-8'), content)
    assert.equal(readFileSync(join(dir, 'tail.txt'), 'utf-8'), noTrailingNewline)
    const writeCommands = fixture.calls
      .filter((call) => call.binary === 'ssh' && call.args.at(-1)?.startsWith('cat > '))
      .map((call) => call.args.at(-1) ?? '')
    assert.equal(writeCommands.length, 2)
    for (const command of writeCommands) assert.ok(command.length < 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await session.close()
  }
})

test('bounded OpenSSH exec keeps draining after output truncation and preserves exit status', async () => {
  const fixture = fakeOpenSsh()
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  try {
    assert.ok(session.execBounded)
    const result = await session.execBounded('printf abcdef; printf error >&2; exit 7', {
      timeoutMs: 2_000,
      maxOutputBytes: 4
    })
    assert.equal(result.code, 7)
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 4)
    assert.equal(result.stdoutTruncated || result.stderrTruncated, true)
  } finally {
    await session.close()
  }
})

test('bounded OpenSSH exec aborts or times out without claiming the remote process stopped', async () => {
  const fixture = fakeOpenSsh({ slowExec: true })
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  try {
    assert.ok(session.execBounded)
    const controller = new AbortController()
    const pending = session.execBounded('sleep 5', {
      timeoutMs: 5_000,
      maxOutputBytes: 256,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 40)
    await assert.rejects(pending, /SSH 调用已取消；远端命令结果可能尚未确认/)
    await assert.rejects(
      session.execBounded('sleep 5', { timeoutMs: 40, maxOutputBytes: 256 }),
      /SSH 命令超时；远端命令结果可能尚未确认/
    )
  } finally {
    await session.close()
  }
})

test('OpenSSH startup times out when the control master never becomes ready', async () => {
  const fixture = fakeOpenSsh({ checkFails: true })
  await assert.rejects(
    () => connectRemoteSshSession({ host: 'lab-hpc', readyTimeoutMs: 120 }, fixture.runtime),
    (error: unknown) => error instanceof RemoteSshConnectionError && error.code === 'timeout'
  )
  assert.ok(fixture.calls.some((call) => call.args.includes('exit') && call.args.includes('-O')))
})

test('unknown and changed host keys fail closed with distinct sanitized diagnoses', async () => {
  const cases = [
    [
      'host_key_unknown',
      'No ED25519 host key is known for lab and you have requested strict checking. Host key verification failed.'
    ],
    [
      'host_key_changed',
      'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Offending key in /private/key-path'
    ]
  ] as const
  for (const [code, startupError] of cases) {
    const fixture = fakeOpenSsh({ startupError })
    await assert.rejects(
      () => connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime),
      (error: unknown) =>
        error instanceof RemoteSshConnectionError &&
        error.code === code &&
        !error.message.includes('/private/key-path')
    )
  }
})

test('missing system ssh is classified without exposing a process error', async () => {
  const fixture = fakeOpenSsh({ missingSsh: true })
  await assert.rejects(
    () => connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime),
    (error: unknown) => error instanceof RemoteSshConnectionError && error.code === 'ssh_missing'
  )
})

test('SSH exit 255 never exposes unknown raw transport diagnostics', async () => {
  const fixture = fakeOpenSsh({ execError: 'private key path /secret/key and password hunter2' })
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  try {
    await assert.rejects(
      () => session.exec('printf ok'),
      (error: unknown) =>
        error instanceof RemoteSshConnectionError &&
        error.code === 'unknown' &&
        !error.message.includes('/secret/key') &&
        !error.message.includes('hunter2')
    )
  } finally {
    await session.close()
  }
})

test('remote exec times out rather than leaving a pending promise forever', async () => {
  const fixture = fakeOpenSsh({ slowExec: true })
  const session = await connectRemoteSshSession(
    { host: 'lab-hpc', execTimeoutMs: 40 },
    fixture.runtime
  )
  try {
    await assert.rejects(() => session.exec('sleep 5'), /超时/)
  } finally {
    await session.close()
  }
})

test('closing the connection aborts an in-flight local SSH command with an unknown-result error', async () => {
  const fixture = fakeOpenSsh({ slowExec: true })
  const session = await connectRemoteSshSession({ host: 'lab-hpc' }, fixture.runtime)
  const running = session.exec('sleep 5')
  const rejection = assert.rejects(running, /SSH 连接已关闭；远端操作结果可能尚未确认/)
  await session.close()
  await rejection
  assert.equal(
    fixture.calls.some((call) => call.args.at(-1)?.startsWith('kill ')),
    false
  )
})
