import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  buildSshKernelShutdownCommand,
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
          return { stdout: '', stderr: '', code: 0, signal: null, truncated: false }
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
          return { stdout: '', stderr: '', code: 0, signal: null, truncated: false }
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
