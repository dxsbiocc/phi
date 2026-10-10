import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  buildSshPortForwardArgs,
  openSshPortForward,
  sshPortForwardActivity
} from '../src/main/agent/workspace-host/ssh-port-forward'

const sandboxes: string[] = []

afterEach(async () => {
  delete process.env.PHI_FAKE_SSH_ARGS
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('notebook tunnel keeps explicit loopback -L after clearing inherited forwards', () => {
  const args = buildSshPortForwardArgs(
    { host: 'lab-alias', user: 'researcher', port: 2222, identityFile: '/tmp/phi-key' },
    43123,
    53234
  )

  assert.deepEqual(args.slice(-3), ['-L', '127.0.0.1:43123:127.0.0.1:53234', 'lab-alias'])
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('ClearAllForwardings=no'))
  assert.ok(!args.includes('ClearAllForwardings=yes'))
  assert.deepEqual(args.slice(0, 8), [
    '-N',
    '-T',
    '-l',
    'researcher',
    '-p',
    '2222',
    '-i',
    '/tmp/phi-key'
  ])
})

test('fake ssh forward retries only to its limit and reaps every child', async () => {
  const sandbox = await fakeSshSandbox()
  const ports = [41001, 41002, 41003]
  let waitCalls = 0
  const spawnCalls: string[][] = []
  const spawnImpl = (
    binary: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams => {
    spawnCalls.push(args)
    return fakeSpawn(sandbox.binary)(binary, args, options)
  }

  await assert.rejects(
    openSshPortForward({
      connection: { host: 'fake-host' },
      remotePort: 52001,
      maxAttempts: ports.length,
      allocateLocalPort: async () => ports.shift()!,
      waitUntilReady: async () => {
        waitCalls += 1
        throw new Error('simulated local bind collision')
      },
      spawnImpl,
      shutdownGraceMs: 50
    }),
    /3 次尝试/
  )

  assert.equal(waitCalls, 3)
  assert.equal(spawnCalls.filter((args) => args.includes('-L')).length, 3)
  assert.equal(spawnCalls.filter((args) => args.includes('ClearAllForwardings=no')).length, 3)
  assert.deepEqual(sshPortForwardActivity(), { children: 0, timers: 0 })
})

test('fake ssh forward closes without leaving its child active', async () => {
  const sandbox = await fakeSshSandbox()
  let child: ChildProcessWithoutNullStreams | undefined
  const lease = await openSshPortForward({
    connection: { host: 'fake-host' },
    remotePort: 52002,
    allocateLocalPort: async () => 41004,
    waitUntilReady: async () => undefined,
    spawnImpl(binary, args, options) {
      child = fakeSpawn(sandbox.binary)(binary, args, options)
      return child
    },
    shutdownGraceMs: 50
  })

  assert.equal(lease.localPort, 41004)
  assert.equal(child?.exitCode, null)
  await lease.close()
  const result = await lease.closed
  assert.ok(result.signal === 'SIGTERM' || result.code === 0)
  assert.notEqual(child?.exitCode ?? child?.signalCode, null)
  assert.deepEqual(sshPortForwardActivity(), { children: 0, timers: 0 })
})

async function fakeSshSandbox(): Promise<{ binary: string; argsPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'phi-fake-ssh-forward-'))
  sandboxes.push(root)
  const binary = join(root, 'ssh')
  const argsPath = join(root, 'args.log')
  await writeFile(
    binary,
    [
      '#!/bin/bash',
      'printf "%s\\n" "$@" >> "$PHI_FAKE_SSH_ARGS"',
      "trap 'exit 0' TERM INT",
      'while :; do sleep 1; done',
      ''
    ].join('\n')
  )
  await chmod(binary, 0o755)
  process.env.PHI_FAKE_SSH_ARGS = argsPath
  return { binary, argsPath }
}

function fakeSpawn(binary: string) {
  return (
    _ssh: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams => spawn(binary, args, options)
}
