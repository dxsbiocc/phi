import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, realpath, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { HelperWorkspaceHost } from '../src/main/agent/workspace-host/helper-host'
import { parseHostCapabilityProbe } from '../src/main/agent/workspace-host/probe'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'
import { createLocalShellSession, installSetsidShim } from './helpers/localShellSession'

async function sshFixture(
  options: { lostReply?: Error; cleanupError?: Error; gateOnFirstExec?: boolean } = {}
): Promise<{
  host: SshHost
  root: string
  marker: string
  ready: Promise<void>
  release(): void
  launches(): number
  runDirectory(): string
  close(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-prelaunch-cancel-')))
  let reached!: () => void,
    release!: () => void,
    launches = 0,
    directory = ''
  const ready = new Promise<void>((resolve) => {
    reached = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => {
      const session = createLocalShellSession(root)
      const write = session.writeTextFile.bind(session),
        execute = session.exec.bind(session),
        openStdio = session.openStdio!.bind(session)
      let gated = false
      return {
        ...session,
        async openStdio(command) {
          launches++
          return openStdio(command)
        },
        async writeTextFile(path, value) {
          await write(path, value)
          if (path.endsWith('/launch.sh')) {
            directory = dirname(path)
            reached()
            await gate
          }
        },
        async exec(command) {
          if (options.gateOnFirstExec && !gated) {
            gated = true
            reached()
            await gate
          }
          if (options.cleanupError && command.startsWith('rm -rf --')) throw options.cleanupError
          if (command.includes('setsid bash')) {
            launches++
            const result = await execute(command)
            if (options.lostReply) throw options.lostReply
            return result
          }
          return execute(command)
        }
      }
    }
  })
  return {
    host,
    root,
    marker: join(root, 'executed'),
    ready,
    release,
    launches: () => launches,
    runDirectory: () => directory,
    async close() {
      release()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('SSH foreground cancellation during preparation returns a cancelled result without launch or control leftovers', async (t) => {
  const f = await sshFixture({ gateOnFirstExec: true })
  t.after(() => f.close())
  const controller = new AbortController()
  let admission = 0
  const pending = f.host.exec.run(
    [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(f.marker)}, 'ran')`
    ],
    {
      cwd: '.',
      signal: controller.signal,
      beforeExec: () => {
        admission++
      }
    }
  )
  void pending.catch(() => {})
  await f.ready
  controller.abort()
  f.release()
  const result = await pending
  assert.equal(result.code, null)
  assert.ok(result.signal)
  assert.equal(result.terminationReason, 'cancelled')
  assert.equal(admission, 0)
  assert.equal(f.launches(), 0)
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
  assert.equal(existsSync(join(f.root, 'wrappers')), false)
})

test('SSH background prelaunch cancellation rejects the original reason and leaves no fabricated handle or controls', async (t) => {
  const f = await sshFixture()
  t.after(() => f.close())
  const controller = new AbortController()
  const reason = new Error('specific prelaunch cancellation')
  const pending = f.host.exec.spawnBackground([process.execPath, '-e', 'process.exit(0)'], {
    cwd: '.',
    signal: controller.signal
  })
  void pending.catch(() => {})
  await f.ready
  controller.abort(reason)
  f.release()
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(f.launches(), 0)
  assert.deepEqual(await readdir(join(f.root, 'wrappers/runs')), [])
})

test('SSH foreground admission rejection is not converted to cancellation', async (t) => {
  const rejection = new Error('project binding changed')
  const f = await sshFixture({ gateOnFirstExec: true })
  t.after(() => f.close())
  const controller = new AbortController()
  const pending = f.host.exec.run([process.execPath, '-e', 'process.exit(0)'], {
    cwd: '.',
    signal: controller.signal,
    beforeExec: () => {
      controller.abort()
      throw rejection
    }
  })
  void pending.catch(() => {})
  await f.ready
  f.release()
  await assert.rejects(pending, (error) => error === rejection)
  assert.equal(f.launches(), 0)
  assert.equal(existsSync(join(f.root, 'wrappers')), false)
})

for (const cleanupFails of [false, true])
  test(`SSH background admission rejection is not masked by cleanup (${cleanupFails})`, async (t) => {
    const rejection = new Error('project binding changed')
    const f = await sshFixture({
      ...(cleanupFails ? { cleanupError: new Error('cleanup transport failed') } : {})
    })
    t.after(() => f.close())
    const pending = f.host.exec.spawnBackground([process.execPath, '-e', 'process.exit(0)'], {
      cwd: '.',
      beforeExec: () => {
        throw rejection
      }
    })
    void pending.catch(() => {})
    await f.ready
    f.release()
    await assert.rejects(pending, (error) => error === rejection)
    assert.equal(f.launches(), 0)
    if (!cleanupFails) assert.deepEqual(await readdir(join(f.root, 'wrappers/runs')), [])
  })

test('SSH background launch preserves submitted control files when an accepted launch reply is lost', async (t) => {
  const lost = new Error('launch reply lost')
  const f = await sshFixture({ lostReply: lost })
  t.after(() => f.close())
  await mkdir(join(f.root, 'shim'))
  const restore = installSetsidShim(join(f.root, 'shim'))
  t.after(restore)
  const pending = f.host.exec.spawnBackground(
    [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(f.marker)}, 'ran')`
    ],
    { cwd: '.' }
  )
  void pending.catch(() => {})
  await f.ready
  f.release()
  await assert.rejects(pending, (error) => error === lost)
  assert.equal(f.launches(), 1)
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      await access(join(f.runDirectory(), 'exit_code')).then(
        () => true,
        () => false
      )
    )
      break
    await delay(10)
  }
  await access(f.marker)
  await access(join(f.runDirectory(), 'launch.sh'))
  await access(join(f.runDirectory(), '.phi-launch-claim/run-id'))
})

function helperFixture(): { host: HelperWorkspaceHost; requests: string[] } {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough()
  let finish!: (result: { code: number | null; signal: string | null }) => void
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    finish = resolve
  })
  const requests: string[] = []
  stdin.on('data', (bytes: Buffer) => {
    const request = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString())
    requests.push(request.method)
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { stdout: '', stderr: '', code: 0, signal: null, truncated: false }
      })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    stdout.write(Buffer.concat([header, body]))
  })
  const process: RemoteStdioProcess = {
    stdin,
    stdout,
    stderr,
    closed,
    async close() {
      stdin.end()
      stdout.end()
      stderr.end()
      finish({ code: 0, signal: null })
    }
  }
  const profile = parseHostCapabilityProbe(
    '__PHI_CAPABILITY_PROBE_V1_BEGIN__\nplatform.os=Linux\nplatform.arch=x86_64\nprobe.complete=1\n__PHI_CAPABILITY_PROBE_V1_END__'
  )
  return {
    requests,
    host: new HelperWorkspaceHost(
      createLocalShellSession(),
      process,
      profile,
      async () => [],
      undefined,
      { remoteRoot: '/workspace', canonicalRoot: '/workspace' }
    )
  }
}

test('helper foreground pre-cancellation returns a Promise/result without any execution request', async (t) => {
  const f = helperFixture()
  t.after(() => f.host.close())
  const controller = new AbortController()
  controller.abort(new Error('cancel before helper dispatch'))
  const pending = f.host.exec.run(['unused-command'], { cwd: '.', signal: controller.signal })
  assert.ok(pending instanceof Promise)
  const result = await pending
  assert.equal(result.code, null)
  assert.ok(result.signal)
  assert.equal(result.terminationReason, 'cancelled')
  assert.deepEqual(f.requests, [])
})

test('helper background pre-cancellation rejects without a handle, and unrelated admission errors keep their identity', async (t) => {
  const f = helperFixture()
  t.after(() => f.host.close())
  const cancelled = new AbortController(),
    reason = new Error('background cancelled')
  cancelled.abort(reason)
  await assert.rejects(
    f.host.exec.spawnBackground(['unused-command'], { cwd: '.', signal: cancelled.signal }),
    (error) => error === reason
  )
  const controller = new AbortController(),
    rejection = new Error('helper binding changed')
  await assert.rejects(
    f.host.exec.run(['unused-command'], {
      cwd: '.',
      signal: controller.signal,
      beforeExec: () => {
        controller.abort()
        throw rejection
      }
    }),
    (error) => error === rejection
  )
  assert.deepEqual(f.requests, [])
})
