import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openRemoteRuntimeWorkspace,
  resolveRemoteRuntimeRoot
} from '../src/main/agent/remote-runtime/workspace'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'
import type { LocalShellSession } from './helpers/localShellSession'
import { HOST_CAPABILITY_FAST_PROBE_SCRIPT } from '../src/main/agent/workspace-host/probe'
import {
  FAST_PROBE_START_SENTINEL,
  FAST_PROBE_END_SENTINEL
} from '../src/main/agent/workspace-host/probe-script'

const completeProbe = `${FAST_PROBE_START_SENTINEL}\nplatform.os=Linux\nplatform.arch=aarch64\nprobe.fast_complete=1\n${FAST_PROBE_END_SENTINEL}`

function openWithSession(
  session: LocalShellSession,
  signal?: AbortSignal
): ReturnType<typeof openRemoteRuntimeWorkspace> {
  return openRemoteRuntimeWorkspace(
    {
      runtimeSessionId: 'runtime-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      configuredRoot: '/runtime'
    },
    signal,
    () => ({
      sessionId: 'session-1',
      projectId: 'project-1',
      hostAlias: 'unit-host',
      remoteRoot: '/project',
      canonicalRoot: '/project',
      cacheKey: 'unit-host',
      config: { remoteRoot: '/project', canonicalRoot: '/project', connect: async () => session }
    })
  )
}

function probeSession(stdout: string, code = 0): LocalShellSession {
  const session = createLocalShellSession()
  session.openStdio = undefined
  session.exec = async () => assert.fail('an unverified platform must not reach root resolution')
  session.execWithInput = async (command, input) => {
    assert.equal(command, 'sh -s')
    assert.equal(input, HOST_CAPABILITY_FAST_PROBE_SCRIPT)
    return { stdout, stderr: '', code, signal: null }
  }
  return session
}

test('remote runtime workspace expands a tilde root through the SSH host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-remote-runtime-workspace-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const runtime = join(home, '.phi', 'runtime')
  const shim = join(root, 'shim')
  for (const path of [project, runtime, shim]) mkdirSync(path, { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = home
  const restoreSetsid = installSetsidShim(shim)
  const connections: LocalShellSession[] = []
  try {
    const workspace = await openRemoteRuntimeWorkspace(
      {
        runtimeSessionId: 'runtime-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        configuredRoot: '~/.phi/runtime'
      },
      undefined,
      () => ({
        sessionId: 'session-1',
        projectId: 'project-1',
        hostAlias: 'local-bash',
        remoteRoot: realpathSync(project),
        canonicalRoot: realpathSync(project),
        cacheKey: 'local',
        config: {
          remoteRoot: realpathSync(project),
          canonicalRoot: realpathSync(project),
          connect: async () => {
            const session = createLocalShellSession(realpathSync(project))
            connections.push(session)
            return session
          }
        }
      })
    )

    assert.equal(workspace.projectRoot, realpathSync(project))
    assert.equal(workspace.runtimeRoot, realpathSync(runtime))
    const expected = {
      os: execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim().toLowerCase(),
      arch: execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim().toLowerCase()
    }
    for (const host of [workspace.projectHost, workspace.runtimeHost]) {
      const { os, arch } = host.capabilities().platform
      assert.deepEqual({ os, arch }, expected)
      assert.equal(host.capabilities().toolchain.git.state, 'unavailable')
    }
    assert.equal((await workspace.runtimeHost.fs.stat('.')).kind, 'directory')
    await workspace.close?.()
    // Platform probe and runtime-root resolution: one stdin script each (the test's own stat is the third connection).
    assert.equal(connections.filter((session) => session.commands.includes('sh -s')).length, 2)
    assert.ok(connections.every((session) => session.closed))
  } finally {
    restoreSetsid()
    process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('remote runtime root resolution identifies a slow server timeout', async () => {
  await assert.rejects(
    resolveRemoteRuntimeRoot(async (_script, options) => {
      assert.equal(options.timeoutMs, 30000)
      return {
        stdout: '',
        stderr: '',
        code: null,
        signal: 'SIGTERM',
        truncated: false,
        terminationReason: 'timeout' as const
      }
    }, '/runtime'),
    /server is responding slowly.*Retry later/u
  )
})

test('unknown, unsuccessful, incomplete or oversized fast probes fail closed and close their owned connection', async () => {
  for (const [stdout, code] of [
    [completeProbe.replace('aarch64', 'unrecognized-cpu'), 0],
    [completeProbe.replace('Linux', 'unrecognized-os'), 0],
    [completeProbe.replace('probe.fast_complete=1', ''), 0],
    [completeProbe.replace(FAST_PROBE_END_SENTINEL, ''), 0],
    [completeProbe, 1],
    [completeProbe + 'x'.repeat(64 * 1024), 0]
  ] as const) {
    const session = probeSession(stdout, code)
    await assert.rejects(
      openWithSession(session),
      /Unable to safely detect the server OS and architecture/u
    )
    assert.equal(session.closed, true)
  }
})

test('fast probe execution errors preserve failure and close their owned connection', async () => {
  const session = probeSession('')
  const failure = new Error('private test transport failed')
  session.execWithInput = async () => {
    throw failure
  }
  await assert.rejects(openWithSession(session), (error) => error === failure)
  assert.equal(session.closed, true)
})

test('cancelling an in-flight fast probe closes its connection and refuses workspace publication', async () => {
  const session = probeSession('')
  const controller = new AbortController()
  const cancelled = new Error('selected workspace was cancelled')
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let finish!: () => void
  session.execWithInput = async () => {
    enter()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { stdout: completeProbe, stderr: '', code: 0, signal: null }
  }
  const close = session.close.bind(session)
  session.close = async () => {
    await close()
    finish()
  }
  const pending = openWithSession(session, controller.signal)
  const rejected = assert.rejects(pending, (error) => error === cancelled)
  await entered
  controller.abort(cancelled)
  await rejected
  assert.equal(session.closed, true)
})

test('fast probe keeps its ten-second deadline and closes a timed-out connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const session = probeSession('')
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let finish!: () => void
  session.execWithInput = async () => {
    enter()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { stdout: completeProbe, stderr: '', code: 0, signal: null }
  }
  const close = session.close.bind(session)
  session.close = async () => {
    await close()
    finish()
  }
  const pending = openWithSession(session)
  const rejected = assert.rejects(
    pending,
    /Unable to safely detect the server OS and architecture/u
  )
  await entered
  t.mock.timers.tick(9999)
  assert.equal(session.closed, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(session.closed, true)
})
