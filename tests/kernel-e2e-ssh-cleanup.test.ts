import assert from 'node:assert/strict'
import { deriveKernelSocketPaths } from '../src/kernel/lifecycle/paths'
import { kernelSocketIdentity } from '../src/main/agent/engine/kernel-client/remote/launcher'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildSshKernelShutdownCommand,
  remoteProcessAlive,
  shutdownSshScenarioKernel
} from '../scripts/kernel-e2e/ssh-kernel-cleanup'
import type { LaunchedRemoteKernel } from '../src/main/agent/engine/kernel-client/remote'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function helperProcess(
  handle: (request: Record<string, unknown>) => Record<string, unknown>
): RemoteStdioProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveClosed: (result: { code: number | null; signal: string | null }) => void = () =>
    undefined
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveClosed = resolve
  })
  stdin.on('data', (request: Buffer) => {
    const length = request.readUInt32BE(0)
    const body = JSON.parse(request.subarray(4, 4 + length).toString('utf8')) as Record<
      string,
      unknown
    >
    stdout.write(frame({ jsonrpc: '2.0', id: body.id, result: handle(body) }))
  })
  return {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      stdin.end()
      stdout.end()
      stderr.end()
      resolveClosed({ code: 0, signal: null })
    }
  }
}

function launch(close: () => Promise<void>): LaunchedRemoteKernel {
  return {
    close,
    homePath: '/srv/home',
    agentDir: '/srv/agent',
    deployment: {
      phiVersion: '0.1.0',
      kernelSha256: 'ab'.repeat(32),
      runtimeRoot: '/srv/phi runtime',
      executablePath: '/srv/phi runtime/kernel/phi-kernel',
      nativePath: '/srv/phi runtime/kernel/pi-natives.node',
      homePath: '/srv/home',
      agentDir: '/srv/agent',
      profile: { os: 'linux', arch: 'x64', libc: 'glibc', variant: 'baseline' },
      variant: 'baseline',
      reused: false,
      remoteCommandCount: 0
    },
    helper: { remotePath: '/srv/helper/phi-helper' }
  } as LaunchedRemoteKernel
}

test('SSH scenario cleanup closes the controller before helper process and socket cleanup', async () => {
  const calls: string[] = []
  const launched = launch(async () => {
    calls.push('close')
  })
  let helperCommand = ''

  await shutdownSshScenarioKernel({
    launch: launched,
    session: {
      async openStdio(command) {
        calls.push('helper')
        helperCommand = command
        return helperProcess((request) => {
          assert.equal(request.method, 'exec.run')
          const params = request.params as Record<string, unknown>
          const command = params.command as string[]
          assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-c'])
          assert.match(command[2], /phi_kernel_executable='\/srv\/phi runtime\/kernel\/phi-kernel'/)
          assert.match(command[2], /readlink "\$phi_proc\/exe"/)
          assert.match(command[2], /grep -Fqx -- "\$phi_kernel_socket"/)
          assert.match(command[2], /kill -TERM \$phi_kernel_live/)
          assert.match(command[2], /kill -KILL \$phi_kernel_live/)
          assert.match(command[2], /rm -f -- "\$phi_kernel_socket" "\$phi_kernel_token"/)
          return {
            stdout: 'PHI_KERNEL_CLEANUP=graceful\n',
            stderr: '',
            code: 0,
            signal: null,
            truncated: false
          }
        })
      }
    }
  })

  assert.deepEqual(calls, ['close', 'helper'])
  assert.equal(helperCommand, "'/srv/helper/phi-helper' serve --root '/srv/phi runtime'")
})

test('SSH scenario cleanup still runs the helper fallback when controller close fails', async () => {
  const launched = launch(async () => {
    throw new Error('channel already closed')
  })
  let command = ''

  await shutdownSshScenarioKernel({
    launch: launched,
    session: {
      async openStdio() {
        return helperProcess((request) => {
          command = ((request.params as Record<string, unknown>).command as string[])[2]
          return {
            stdout: 'PHI_KERNEL_CLEANUP=graceful\n',
            stderr: '',
            code: 0,
            signal: null,
            truncated: false
          }
        })
      }
    }
  })

  assert.equal(command, buildSshKernelShutdownCommand(launched))
})

test('SSH scenario cleanup reports helper termination failures', async () => {
  const launched = launch(async () => undefined)
  await assert.rejects(
    shutdownSshScenarioKernel({
      launch: launched,
      session: {
        async openStdio() {
          return helperProcess(() => ({
            stdout: '',
            stderr: 'permission denied',
            code: 1,
            signal: null,
            truncated: false
          }))
        }
      }
    }),
    /Remote kernel cleanup failed: permission denied/
  )
})

test('SSH cleanup addresses the exact home-scoped socket used by the launcher', () => {
  const launched = launch(async () => undefined)
  const expected = deriveKernelSocketPaths(
    launched.deployment.runtimeRoot,
    kernelSocketIdentity(launched.deployment, {
      home: launched.homePath,
      agentDir: launched.agentDir
    }),
    0
  )
  assert.ok(buildSshKernelShutdownCommand(launched).includes(`phi_kernel_stem='${expected.stem}'`))
})

test('SSH cleanup reports whether termination needed a signal and rejects missing evidence', async () => {
  for (const mode of ['graceful', 'term', 'kill']) {
    const result = await shutdownSshScenarioKernel({
      launch: launch(async () => undefined),
      session: {
        async openStdio() {
          return helperProcess(() => ({
            stdout: `PHI_KERNEL_CLEANUP=${mode}\n`,
            stderr: '',
            code: 0,
            signal: null,
            truncated: false
          }))
        }
      }
    })
    assert.equal(result, mode)
  }
  await assert.rejects(
    shutdownSshScenarioKernel({
      launch: launch(async () => undefined),
      session: {
        async openStdio() {
          return helperProcess(() => ({
            stdout: '',
            stderr: '',
            code: 0,
            signal: null,
            truncated: false
          }))
        }
      }
    }),
    /cleanup evidence/
  )
})

test('SSH process absence requires a successful explicit remote observation', async () => {
  for (const [stdout, alive] of [
    ['alive', true],
    ['absent', false]
  ] as const) {
    assert.equal(
      await remoteProcessAlive(
        { exec: async () => ({ stdout, stderr: '', code: 0, signal: null }) },
        123
      ),
      alive
    )
  }
  for (const result of [
    { stdout: '', stderr: 'connection lost', code: 255, signal: null },
    { stdout: '', stderr: 'inspection denied', code: 1, signal: null },
    { stdout: '', stderr: '', code: 0, signal: null },
    { stdout: 'absent', stderr: '', code: 0, signal: 'SIGTERM' }
  ]) {
    await assert.rejects(remoteProcessAlive({ exec: async () => result }, 123), /inspection failed/)
  }
})

test('generated cleanup verifies translated process ownership and fails closed on inspection errors', () => {
  for (const kind of ['translated', 'unknown-exe', 'foreign-argv', 'ps-error']) {
    const root = mkdtempSync(join(tmpdir(), 'phi-cleanup-shell-'))
    try {
      const proc = join(root, 'proc', '1234')
      const bin = join(root, 'bin')
      mkdirSync(proc, { recursive: true })
      mkdirSync(bin)
      const launched = launch(async () => undefined)
      const identity = kernelSocketIdentity(launched.deployment, {
        home: launched.homePath,
        agentDir: launched.agentDir
      })
      const { stem } = deriveKernelSocketPaths(launched.deployment.runtimeRoot, identity, 0)
      const socketDir = join(root, 'sockets-0')
      mkdirSync(socketDir)
      const socket = join(socketDir, `${stem}.sock`)
      const token = join(socketDir, `${stem}.token`)
      writeFileSync(socket, '')
      writeFileSync(token, '')
      const args = [
        kind === 'foreign-argv' ? '/unrelated/program' : launched.deployment.executablePath,
        '--listen',
        socket,
        '--token-file',
        token
      ]
      writeFileSync(join(proc, 'cmdline'), args.join('\0') + '\0')
      symlinkSync(
        kind === 'unknown-exe' ? '/unknown/translator' : '/run/rosetta/rosetta',
        join(proc, 'exe')
      )
      writeFileSync(
        join(bin, 'ps'),
        `#!/bin/sh\n${kind === 'ps-error' ? 'exit 77' : `if [ -d '${proc}' ]; then printf '1234\\n'; fi`}\n`,
        { mode: 0o755 }
      )
      const command = buildSshKernelShutdownCommand(launched)
        .replace('/proc/$phi_pid', `${root}/proc/$phi_pid`)
        .replace('/tmp/phi-k-', `${root}/sockets-`)
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          `id() { printf 0; }; sleep() { :; }; kill() { printf '%s\\n' "$*" >> '${root}/signals'; rm -rf '${proc}'; };\n${command}`
        ],
        {
          env: { PATH: `${bin}:/usr/bin:/bin` },
          encoding: 'utf8',
          timeout: 10_000
        }
      )
      if (kind === 'translated') {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, 'PHI_KERNEL_CLEANUP=term\n')
        assert.equal(readFileSync(join(root, 'signals'), 'utf8'), '-TERM 1234\n')
        assert.equal(existsSync(socket), false)
      } else {
        assert.notEqual(result.status, 0)
        assert.equal(existsSync(join(root, 'signals')), false)
        assert.equal(existsSync(socket), true)
        assert.equal(result.stdout.includes('PHI_KERNEL_CLEANUP='), false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
