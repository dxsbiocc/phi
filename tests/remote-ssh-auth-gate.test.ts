import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { remoteDoctor } from '../src/main/agent/remote-doctor'
import { saveRemoteHostProfile } from '../src/main/agent/remote-hosts'
import { createRemoteSshAuthGate } from '../src/main/agent/wrappers/remote-ssh-auth-gate'
import {
  connectRemoteSshSession,
  type OpenSshRuntime
} from '../src/main/agent/wrappers/remote-ssh-session'
import { RemoteSshConnectionError } from '../src/main/agent/wrappers/remote-ssh-diagnostics'

type SpawnRecord = { binary: string; args: string[] }

function fakeOpenSsh(settings: { startupError?: string } = {}): {
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
      return settings.startupError
        ? spawn(
            process.execPath,
            [
              '-e',
              'process.stderr.write(process.argv[1]); process.exit(255)',
              settings.startupError
            ],
            spawnOptions
          )
        : spawn('/bin/sh', ['-c', 'exec sleep 30'], spawnOptions)
    }
    if (binary === 'ssh' && args.includes('-O')) {
      const action = args[args.indexOf('-O') + 1]
      return spawn(
        '/bin/sh',
        ['-c', action === 'check' && settings.startupError ? 'exit 1' : 'exit 0'],
        spawnOptions
      )
    }
    throw new Error(`unexpected ${binary}`)
  }
  return { runtime: { spawnImpl }, calls }
}

test('authentication failure blocks the same SSH target without spawning again', async () => {
  let now = 1_000
  const authGate = createRemoteSshAuthGate({ now: () => now })
  const fixture = fakeOpenSsh({ startupError: 'Permission denied (publickey).' })
  const runtime = { ...fixture.runtime, authGate }

  await assert.rejects(
    connectRemoteSshSession({ host: 'lab-hpc', readyTimeoutMs: 100 }, runtime),
    (error: unknown) =>
      error instanceof RemoteSshConnectionError && error.code === 'authentication_failed'
  )
  fixture.calls.length = 0

  await assert.rejects(
    connectRemoteSshSession({ host: 'lab-hpc' }, runtime),
    (error: unknown) =>
      error instanceof RemoteSshConnectionError &&
      error.code === 'authentication_failed' &&
      error.message.includes('测试连接可立即重试')
  )
  assert.equal(fixture.calls.length, 0)
  now += 1
})

test('the SSH target can connect again after the cooldown expires', async () => {
  let now = 1_000
  const authGate = createRemoteSshAuthGate({ now: () => now, cooldownMs: 1_000 })
  const failed = fakeOpenSsh({ startupError: 'Permission denied (publickey).' })

  await assert.rejects(
    connectRemoteSshSession(
      { host: 'lab-hpc', readyTimeoutMs: 100 },
      { ...failed.runtime, authGate }
    )
  )
  now += 1_000

  const recovered = fakeOpenSsh()
  const session = await connectRemoteSshSession(
    { host: 'lab-hpc' },
    { ...recovered.runtime, authGate }
  )
  assert.ok(recovered.calls.some((call) => call.binary === 'ssh' && call.args.includes('-M')))
  await session.close()
})

test('network, timeout and unknown failures do not start a cooldown', () => {
  const authGate = createRemoteSshAuthGate()
  for (const code of ['network_unreachable', 'timeout', 'unknown'] as const) {
    authGate.recordSshFailure(`lab-${code}`, code)
    assert.doesNotThrow(() => authGate.assertSshNotBlocked(`lab-${code}`))
  }
})

test('a successful connection clears an existing block', async () => {
  const authGate = createRemoteSshAuthGate()
  const failed = fakeOpenSsh({ startupError: 'Permission denied (publickey).' })
  await assert.rejects(
    connectRemoteSshSession(
      { host: 'lab-hpc', readyTimeoutMs: 100 },
      { ...failed.runtime, authGate }
    )
  )

  const probe = fakeOpenSsh()
  const probeSession = await connectRemoteSshSession(
    { host: 'lab-hpc', userInitiated: true },
    { ...probe.runtime, authGate }
  )
  await probeSession.close()

  const retried = fakeOpenSsh()
  const retriedSession = await connectRemoteSshSession(
    { host: 'lab-hpc' },
    { ...retried.runtime, authGate }
  )
  assert.ok(retried.calls.some((call) => call.args.includes('-M')))
  await retriedSession.close()
})

test('a user-driven remote doctor probe bypasses and clears the block', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-ssh-auth-gate-'))
  try {
    const profile = saveRemoteHostProfile({ label: 'Lab', hostAlias: 'lab-hpc' }, agentDir)
    const authGate = createRemoteSshAuthGate()
    const failed = fakeOpenSsh({ startupError: 'Permission denied (publickey).' })
    await assert.rejects(
      connectRemoteSshSession(
        { host: 'lab-hpc', readyTimeoutMs: 100 },
        { ...failed.runtime, authGate }
      )
    )

    let userInitiated = false
    const probe = fakeOpenSsh()
    const report = await remoteDoctor(
      profile.id,
      undefined,
      { scope: 'connection' },
      {
        agentDir,
        userInitiated: true,
        connectImpl: async (config) => {
          userInitiated = config.userInitiated === true
          return connectRemoteSshSession(config, { ...probe.runtime, authGate })
        }
      }
    )
    assert.equal(userInitiated, true)
    assert.equal(report.ok, true)

    const retried = fakeOpenSsh()
    const session = await connectRemoteSshSession(
      { host: 'lab-hpc' },
      { ...retried.runtime, authGate }
    )
    await session.close()
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('different hosts and effective connection overrides have independent blocks', async () => {
  const authGate = createRemoteSshAuthGate()
  const blockedConfig = {
    host: 'lab-a',
    user: 'scientist',
    port: 22,
    identityFile: '/tmp/key-a',
    readyTimeoutMs: 100
  }
  const failed = fakeOpenSsh({ startupError: 'Permission denied (publickey).' })
  await assert.rejects(connectRemoteSshSession(blockedConfig, { ...failed.runtime, authGate }))

  const otherHost = fakeOpenSsh()
  const otherHostSession = await connectRemoteSshSession(
    { ...blockedConfig, host: 'lab-b' },
    { ...otherHost.runtime, authGate }
  )
  await otherHostSession.close()

  const otherOverrides = fakeOpenSsh()
  const otherOverridesSession = await connectRemoteSshSession(
    { ...blockedConfig, identityFile: '/tmp/key-b' },
    { ...otherOverrides.runtime, authGate }
  )
  await otherOverridesSession.close()
})

test('all authentication and host-trust blocks reject with zero spawn and sanitized guidance', async () => {
  const cases = [
    ['authentication_failed', 'Permission denied (publickey).'],
    [
      'host_key_changed',
      'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Offending key in /private/key-path'
    ],
    [
      'host_key_unknown',
      'No ED25519 host key is known for lab and you have requested strict checking.'
    ],
    ['host_key_unverified', 'Host key verification failed.']
  ] as const

  for (const [code, startupError] of cases) {
    const authGate = createRemoteSshAuthGate()
    const host = `lab-${code.replaceAll('_', '-')}`
    const failed = fakeOpenSsh({ startupError })
    await assert.rejects(
      connectRemoteSshSession({ host, readyTimeoutMs: 100 }, { ...failed.runtime, authGate }),
      (error: unknown) => error instanceof RemoteSshConnectionError && error.code === code
    )

    const blocked = fakeOpenSsh()
    await assert.rejects(
      connectRemoteSshSession({ host }, { ...blocked.runtime, authGate }),
      (error: unknown) =>
        error instanceof RemoteSshConnectionError &&
        error.code === code &&
        error.message.includes('剩余约 15 分钟') &&
        error.message.includes('不要自行更换 -i、端口或 StrictHostKeyChecking') &&
        !error.message.includes('/private/key-path')
    )
    assert.equal(blocked.calls.length, 0)
  }
})
