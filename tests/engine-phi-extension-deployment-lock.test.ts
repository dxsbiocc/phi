import assert from 'node:assert/strict'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { RemoteStdioProcess } from '../src/main/agent/wrappers/remote-ssh-session'
import { ensurePhiExtensionDeployment } from '../src/main/agent/engine/rpc/extension-deployment'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'

test('a disconnected holder releases its kernel lock even when all exec cleanup is unavailable, so retry resumes', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const open = fixture.deploymentOptions.openLockStdio
  let holder: RemoteStdioProcess | undefined
  fixture.deploymentOptions.openLockStdio = async (command) => {
    holder = await open(command)
    return holder
  }
  const upload = fixture.host.transfer.uploadFile
  const exec = fixture.host.exec.run
  let unavailableExecCalls = 0
  let partial = ''
  fixture.host.transfer.uploadFile = async (_local, remote) => {
    partial = `${remote}.transport-owned.partial`
    await writeFile(partial, 'checkpoint')
    fixture.host.exec.run = async () => {
      unavailableExecCalls++
      throw new Error('SSH exec disconnected')
    }
    await holder!.close()
    throw new Error('upload connection interrupted')
  }
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /interrupted|lock channel disconnected|lock output ended/
  )
  assert.equal(unavailableExecCalls, 0)
  assert.equal(await readFile(partial, 'utf8'), 'checkpoint')
  const lockPath = join(fixture.runtimeRoot, 'extension-locks', fixture.bundle.contentHash)
  const inode = (await stat(lockPath)).ino
  fixture.host.exec.run = exec
  fixture.host.transfer.uploadFile = async (...args) => {
    await rm(partial, { force: true })
    await upload(...args)
  }
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
  assert.equal((await stat(lockPath)).ino, inode)
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600)
})

test('a live kernel lock cannot be reclaimed by age and cancellation of a waiter preserves its holder and inode', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const upload = fixture.host.transfer.uploadFile
  let uploadCalls = 0
  fixture.host.transfer.uploadFile = async (...args) => {
    uploadCalls++
    entered()
    await gate
    await upload(...args)
  }
  const first = ensurePhiExtensionDeployment(fixture.deploymentOptions)
  await started
  const lockPath = join(fixture.runtimeRoot, 'extension-locks', fixture.bundle.contentHash)
  const inode = (await stat(lockPath)).ino
  await utimes(lockPath, new Date(0), new Date(0))
  const controller = new AbortController()
  const second = ensurePhiExtensionDeployment({
    ...fixture.deploymentOptions,
    uploadOptions: { ...fixture.deploymentOptions.uploadOptions, hostKey: 'another-client' },
    signal: controller.signal
  })
  const rejected = assert.rejects(second, { name: 'AbortError' })
  await delay(250)
  assert.equal(uploadCalls, 1)
  controller.abort()
  try {
    await Promise.race([
      rejected,
      delay(1000).then(() => {
        throw new Error('Kernel lock waiter did not cancel')
      })
    ])
  } finally {
    release()
  }
  assert.equal((await first).reused, false)
  assert.equal((await stat(lockPath)).ino, inode)
})

test('pending lock stdio acquisition cancels before its gate opens and separately closes a late channel', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const open = fixture.deploymentOptions.openLockStdio
  let release!: () => void
  let entered!: () => void
  let lateClosed!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const closed = new Promise<void>((resolve) => {
    lateClosed = resolve
  })
  const controller = new AbortController()
  const pending = ensurePhiExtensionDeployment({
    ...fixture.deploymentOptions,
    signal: controller.signal,
    openLockStdio: async (command) => {
      entered()
      await gate
      const channel = await open(command)
      void channel.closed.then(lateClosed)
      return channel
    }
  })
  await started
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  try {
    await Promise.race([
      rejected,
      delay(1000).then(() => {
        throw new Error('Pending lock acquisition did not cancel')
      })
    ])
    assert.equal(fixture.session.uploads.length, 0)
  } finally {
    release()
  }
  await closed
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
})

test('unexpected lock EOF cancels an in-flight upload while exec still works and prevents atomic publication', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  let holder: RemoteStdioProcess | undefined
  const open = fixture.deploymentOptions.openLockStdio
  fixture.deploymentOptions.openLockStdio = async (command) => {
    holder = await open(command)
    return holder
  }
  let transferAborted = false
  fixture.host.transfer.uploadFile = async (_local, _remote, options) => {
    const cancelled = new Promise<never>((_, reject) => {
      options!.signal!.addEventListener(
        'abort',
        () => {
          transferAborted = true
          reject(options!.signal!.reason)
        },
        { once: true }
      )
    })
    void cancelled.catch(() => undefined)
    await holder!.close()
    await cancelled
  }
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /lock channel disconnected|lock output ended/
  )
  assert.equal(transferAborted, true)
  await assert.rejects(stat(join(fixture.runtimeRoot, 'extensions', fixture.bundle.contentHash)), {
    code: 'ENOENT'
  })
  assert.equal(
    (await fixture.host.exec.run(['printf', 'exec-still-working'], { cwd: fixture.runtimeRoot }))
      .stdout,
    'exec-still-working'
  )
})

test('unexpected lock stdout EOF prevents publication before a delayed closed notification resolves', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const open = fixture.deploymentOptions.openLockStdio
  let raw: RemoteStdioProcess | undefined
  let releaseClosed!: () => void
  const closedGate = new Promise<void>((resolve) => {
    releaseClosed = resolve
  })
  let closedResolved = false
  fixture.deploymentOptions.openLockStdio = async (command) => {
    raw = await open(command)
    return {
      ...raw,
      closed: raw.closed.then(async (result) => {
        await closedGate
        closedResolved = true
        return result
      })
    }
  }
  const upload = fixture.host.transfer.uploadFile
  fixture.host.transfer.uploadFile = async (...args) => {
    await raw!.close()
    await upload(...args)
  }
  try {
    await assert.rejects(
      ensurePhiExtensionDeployment(fixture.deploymentOptions),
      /lock output ended/
    )
    assert.equal(raw!.stdout.readableEnded, true)
    assert.equal(closedResolved, false)
    await assert.rejects(
      stat(join(fixture.runtimeRoot, 'extensions', fixture.bundle.contentHash)),
      { code: 'ENOENT' }
    )
    assert.equal(
      (await fixture.host.exec.run(['printf', 'exec-still-working'], { cwd: fixture.runtimeRoot }))
        .stdout,
      'exec-still-working'
    )
  } finally {
    releaseClosed()
  }
})
