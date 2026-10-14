import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import {
  createPhiExtensionBundle,
  ensurePhiExtensionDeployment
} from '../src/main/agent/engine/rpc/extension-deployment'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { createLocalShellSession } from './helpers/localShellSession'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'
import { localSourceIdentity } from '../src/main/agent/transfer/ssh-data-plane-local'
import { sameSourceIdentity } from '../src/main/agent/transfer/manifest'

test('first deployment verifies every file and manifest, reuses exact content and restores private permissions', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const progress: string[] = []
  const result = await ensurePhiExtensionDeployment({
    ...fixture.deploymentOptions,
    onProgress: (event) => progress.push(event.phase)
  })
  assert.equal(result.reused, false)
  assert.equal(result.entryPath, join(result.directory, 'rpc-entry.ts'))
  assert.equal(result.contentHash, fixture.bundle.contentHash)
  assert.deepEqual([...new Set(progress)], ['checking', 'uploading', 'verifying', 'ready'])
  const count = fixture.session.uploads.length
  assert.equal(count, fixture.bundle.files.length + 1)
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.contentHash, result.contentHash)
  for (const file of fixture.bundle.files)
    assert.deepEqual(await readFile(join(result.directory, file.path)), file.bytes)
  for (const path of [
    join(fixture.runtimeRoot, 'extensions'),
    result.directory,
    join(result.directory, 'lib')
  ])
    await chmod(path, 0o755)
  await chmod(result.entryPath, 0o666)
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, true)
  assert.equal(fixture.session.uploads.length, count)
  for (const path of [
    join(fixture.runtimeRoot, 'extensions'),
    result.directory,
    join(result.directory, 'lib')
  ])
    assert.equal((await stat(path)).mode & 0o777, 0o700)
  assert.equal((await stat(result.entryPath)).mode & 0o777, 0o600)
})

test('missing, corrupt and unexpected bundle files each require complete verified repair', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const first = await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  for (const corrupt of [
    () => rm(first.entryPath),
    () => writeFile(first.entryPath, 'corrupted'),
    () => writeFile(join(first.directory, 'manifest.json'), '{}'),
    () => writeFile(join(first.directory, 'unexpected'), 'unlisted'),
    () => mkdir(join(first.directory, 'unexpected-directory'))
  ]) {
    await corrupt()
    assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
    assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, true)
  }
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'extensions')), [
    fixture.bundle.contentHash
  ])
})

test('managed symlink roots and destinations fail without changing outside targets; file symlinks repair safely', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside')
  await mkdir(outside)
  const base = join(fixture.runtimeRoot, 'extensions')
  await symlink(outside, base)
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /Symbolic managed directory/
  )
  await rm(base)
  await mkdir(base)
  const destination = join(base, fixture.bundle.contentHash)
  await symlink(outside, destination)
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /Symbolic extension destination/
  )
  await rm(destination)
  const deployed = await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  const sentinel = join(outside, 'sentinel')
  await writeFile(sentinel, 'unchanged', { mode: 0o644 })
  await rm(deployed.entryPath)
  await symlink(sentinel, deployed.entryPath)
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
  await rm(deployed.entryPath)
  await link(sentinel, deployed.entryPath)
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
  assert.equal((await stat(sentinel)).mode & 0o777, 0o644)
  assert.deepEqual(await readdir(outside), ['sentinel'])
})

test('same-content concurrent transactions upload once, including separate host identities sharing the remote root', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  // Production runs R1 first, so WorkspaceHost's detached execution directory
  // already exists before independent extension transactions share this root.
  await fixture.host.exec.run(['true'], { cwd: fixture.runtimeRoot })
  const results = await Promise.all([
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    ensurePhiExtensionDeployment({
      ...fixture.deploymentOptions,
      uploadOptions: {
        ...fixture.deploymentOptions.uploadOptions,
        hostKey: 'another-connected-session'
      }
    }),
    ensurePhiExtensionDeployment(fixture.deploymentOptions)
  ])
  assert.equal(results.filter((result) => !result.reused).length, 1)
  assert.equal(fixture.session.uploads.length, fixture.bundle.files.length + 1)
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'extensions')), [
    fixture.bundle.contentHash
  ])
})

test('cancellation retains resumable private staging and preserves an active earlier bundle', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const active = await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  await writeFile(join(fixture.sourceRoot, 'lib/guard.ts'), 'export const guard = () => 42\n')
  const next = await createPhiExtensionBundle(fixture.sourceRoot)
  const controller = new AbortController()
  await assert.rejects(
    ensurePhiExtensionDeployment({
      ...fixture.deploymentOptions,
      bundle: next,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.transfer?.state === 'saved') controller.abort()
      }
    }),
    { name: 'AbortError' }
  )
  assert.deepEqual(
    (await readdir(join(fixture.runtimeRoot, 'extensions'))).sort(),
    [`.staging-${next.contentHash}`, fixture.bundle.contentHash].sort()
  )
  assert.deepEqual(
    await readFile(active.entryPath),
    fixture.bundle.files.find((file) => file.path === 'rpc-entry.ts')!.bytes
  )
  assert.equal(
    (await ensurePhiExtensionDeployment({ ...fixture.deploymentOptions, bundle: next })).reused,
    false
  )
  assert.deepEqual(
    (await readdir(join(fixture.runtimeRoot, 'extensions'))).sort(),
    [next.contentHash, fixture.bundle.contentHash].sort()
  )
})

test('queued cancellation is prompt and a third caller cannot overtake the active transaction', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const upload = fixture.host.transfer.uploadFile
  fixture.host.transfer.uploadFile = async (...args) => {
    entered()
    await held
    await upload(...args)
  }
  t.after(() => release())
  const first = ensurePhiExtensionDeployment(fixture.deploymentOptions)
  await started
  const controller = new AbortController()
  const queued = ensurePhiExtensionDeployment({
    ...fixture.deploymentOptions,
    signal: controller.signal
  })
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  controller.abort()
  await rejected
  const third = ensurePhiExtensionDeployment(fixture.deploymentOptions)
  release()
  assert.equal((await first).reused, false)
  assert.equal((await third).reused, true)
})

test('transfer corruption is rejected before publication and a changed source identity is rejected before remote commands', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const upload = fixture.host.transfer.uploadFile
  fixture.host.transfer.uploadFile = async (...args) => {
    await upload(...args)
    await writeFile(args[1], 'corrupt')
  }
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /complete-file verification/
  )
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'extensions')), [
    `.staging-${fixture.bundle.contentHash}`
  ])
  const before = fixture.session.commands.length
  await assert.rejects(
    ensurePhiExtensionDeployment({
      ...fixture.deploymentOptions,
      bundle: { ...fixture.bundle, contentHash: '0'.repeat(64) }
    }),
    /changed Phi extension bundle/
  )
  assert.equal(fixture.session.commands.length, before)
})

test('existing WorkspaceHost streaming transfer deploys the bundle without another upload stack', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const sessions: ReturnType<typeof createLocalShellSession>[] = []
  const host = new SshHost({
    remoteRoot: fixture.runtimeRoot,
    canonicalRoot: fixture.runtimeRoot,
    transferHostKey: fixture.root,
    capabilityProfile: fixture.host.capabilities(),
    connect: async () => {
      const session = createLocalShellSession(fixture.runtimeRoot)
      sessions.push(session)
      return session
    }
  })
  t.after(async () => {
    await host.close()
    await Promise.all(sessions.map((session) => session.close()))
  })
  const progress: string[] = []
  const deployed = await ensurePhiExtensionDeployment({
    ...fixture.deploymentOptions,
    runtimeHost: host,
    onProgress: (event) => {
      if (event.transfer) progress.push(event.transfer.state)
    }
  })
  assert.deepEqual(
    await readFile(deployed.entryPath),
    fixture.bundle.files.find((file) => file.path === 'rpc-entry.ts')!.bytes
  )
  assert.ok(progress.includes('transferring'))
  assert.ok(progress.includes('saved'))
})

test('interrupted retry keeps the transfer source inode, destination, ID and transport-owned partial', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const upload = fixture.host.transfer.uploadFile
  let first:
    | {
        local: string
        remote: string
        id?: string
        source: Awaited<ReturnType<typeof localSourceIdentity>>
      }
    | undefined
  let partial = ''
  fixture.host.transfer.uploadFile = async (local, remote, options) => {
    first = { local, remote, id: options?.transferId, source: await localSourceIdentity(local) }
    partial = `${remote}.transport-owned.partial`
    await writeFile(partial, 'checkpoint')
    throw new Error('connection interrupted')
  }
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /connection interrupted/
  )
  assert.equal(await readFile(partial, 'utf8'), 'checkpoint')
  let resumed = false
  fixture.host.transfer.uploadFile = async (local, remote, options) => {
    if (remote === first!.remote) {
      assert.equal(local, first!.local)
      assert.equal(options?.transferId, first!.id)
      assert.equal(options?.reuseVerifiedDestination, true)
      assert.ok(sameSourceIdentity(first!.source, await localSourceIdentity(local)))
      assert.equal(await readFile(partial, 'utf8'), 'checkpoint')
      await rm(partial)
      resumed = true
    }
    await upload(local, remote, options)
  }
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
  assert.equal(resumed, true)
})

test('stable snapshots reject managed cache symlinks and tighten reused cache permissions', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside-cache')
  await mkdir(outside)
  await symlink(outside, fixture.deploymentOptions.cacheDir)
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /Unsafe Phi extension cache entry/
  )
  assert.deepEqual(await readdir(outside), [])
  await rm(fixture.deploymentOptions.cacheDir)
  const first = await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  const cache = join(fixture.deploymentOptions.cacheDir, 'phi-extension-snapshots')
  const snapshot = join(cache, fixture.bundle.files[0].sha256)
  await chmod(cache, 0o755)
  await chmod(snapshot, 0o666)
  await rm(first.directory, { recursive: true })
  await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  assert.equal((await stat(cache)).mode & 0o777, 0o700)
  assert.equal((await stat(snapshot)).mode & 0o777, 0o600)
  await rm(first.directory, { recursive: true })
  await rm(snapshot)
  await symlink(join(outside, 'missing'), snapshot)
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /Unsafe Phi extension cache entry/
  )
  assert.deepEqual(await readdir(outside), [])
})

test('a group or world writable runtime root cannot replace managed directories during deployment', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  await chmod(fixture.runtimeRoot, 0o777)
  await assert.rejects(
    ensurePhiExtensionDeployment(fixture.deploymentOptions),
    /writable by another user or group/
  )
  await chmod(fixture.runtimeRoot, 0o755)
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
})

test('failed permission changes cannot count as reuse or publish a broadly readable bundle', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const first = await ensurePhiExtensionDeployment(fixture.deploymentOptions)
  await chmod(first.directory, 0o755)
  await chmod(first.entryPath, 0o666)
  const directory = join(fixture.root, 'chmod-shim')
  await mkdir(directory)
  const binary = execFileSync('sh', ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim()
  const shim = join(directory, 'chmod')
  await writeFile(
    shim,
    `#!/bin/sh\nfor last do :; done\ncase "$last" in ${shellQuote(first.directory)}|${shellQuote(first.directory)}/*) exit 1;; esac\nexec ${shellQuote(binary)} "$@"\n`
  )
  await chmod(shim, 0o700)
  const previous = process.env.PATH
  process.env.PATH = `${directory}:${previous}`
  try {
    assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, false)
    assert.equal((await stat(first.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(first.entryPath)).mode & 0o777, 0o600)
  } finally {
    process.env.PATH = previous
  }
  assert.equal((await ensurePhiExtensionDeployment(fixture.deploymentOptions)).reused, true)
})
