import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  deploymentReadyMarkerPath,
  ensureRemoteOmpDeployment,
  REMOTE_OMP_MANIFEST,
  selectRemoteOmpAsset,
  type RemoteOmpDeploymentProgress
} from '../src/main/agent/engine/rpc/runtime-deployment'
import { SshHost } from '../src/main/agent/workspace-host/ssh-host'
import { localSourceIdentity } from '../src/main/agent/transfer/ssh-data-plane-local'
import { sameSourceIdentity } from '../src/main/agent/transfer/manifest'
import { TransferError } from '../src/main/agent/transfer/errors'
import { createLocalShellSession } from './helpers/localShellSession'
import { createRemoteOmpDeploymentFixture } from './helpers/remoteOmpDeploymentFixture'

test('official release is pinned to both validated 18.10.3 assets', () => {
  assert.equal(REMOTE_OMP_MANIFEST.version, '18.10.3')
  for (const [arch, key, sha256] of [
    ['x86_64', 'linux-x64', '366ffcda80db57b825921b6ff4b0e5e623bc62cf18478f2828cd8a322fc72ff9'],
    ['aarch64', 'linux-arm64', '7f580e1fe06ebffe16ae46cc6881051aca4980db7f654702feefed5651555862']
  ]) {
    const selected = selectRemoteOmpAsset(REMOTE_OMP_MANIFEST, '18.10.3', {
      os: 'Linux',
      arch,
      libc: { name: 'glibc' }
    })
    assert.equal(selected.key, key)
    assert.equal(selected.asset.sha256, sha256)
    assert.equal(
      selected.asset.url,
      `https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-${key}`
    )
  }
})

test('unsupported OS, architecture, libc and desktop versions fail before downloading', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  for (const platform of [
    { os: 'darwin', arch: 'x64', libc: { name: 'glibc' as const } },
    { os: 'linux', arch: 'riscv64', libc: { name: 'glibc' as const } },
    { os: 'linux', arch: '__proto__', libc: { name: 'glibc' as const } },
    { os: 'linux', arch: 'x64', libc: { name: 'musl' as const } },
    { os: 'linux', arch: 'x64', libc: { name: 'unknown' as const } },
    { os: 'linux', arch: 'arm64' }
  ])
    assert.throws(() => selectRemoteOmpAsset(REMOTE_OMP_MANIFEST, '18.10.3', platform), {
      code: 'UNSUPPORTED_PLATFORM'
    })
  await assert.rejects(
    ensureRemoteOmpDeployment({ ...fixture.options, desktopVersion: '18.1.10' }),
    { code: 'UNSUPPORTED_VERSION' }
  )
  assert.equal(fixture.downloads(), 0)
  assert.equal(fixture.session.commands.length, 0)
})

test('deploys under selected runtime root with streaming progress, isolated version check and transfer options', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const progress: RemoteOmpDeploymentProgress[] = []
  const result = await ensureRemoteOmpDeployment({
    ...fixture.options,
    onProgress: (event) => progress.push(event)
  })
  assert.equal(result.reused, false)
  assert.equal(result.executablePath, join(fixture.runtimeRoot, 'omp', '18.10.3', 'omp'))
  assert.equal(result.homePath, join(fixture.runtimeRoot, 'omp-home'))
  assert.equal(await readFile(result.executablePath, 'utf8'), fixture.payload)
  assert.equal((await stat(result.executablePath)).mode & 0o777, 0o700)
  assert.equal((await stat(result.agentDir)).mode & 0o777, 0o700)
  assert.deepEqual(
    [...new Set(progress.map((event) => event.phase))],
    ['checking', 'downloading', 'uploading', 'verifying', 'ready']
  )
  assert.ok(progress.filter((event) => event.phase === 'downloading').length > 2)
  const upload = fixture.session.uploads[0]
  assert.equal(upload.options?.expectedSha256, fixture.options.manifest?.assets['linux-x64'].sha256)
  assert.equal(upload.options?.reuseVerifiedDestination, true)
  assert.match(upload.options?.transferId ?? '', /^omp-[a-f0-9]{40}$/)
  assert.ok(progress.some((event) => event.transfer?.state === 'saved'))
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [
    '.phi-ready.json',
    'omp'
  ])
})

test('successful OMP activation publishes its deterministic private ready marker last', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)

  const deployed = await ensureRemoteOmpDeployment(fixture.options)
  const marker = join(dirname(deployed.executablePath), '.phi-ready.json')

  assert.equal(
    await readFile(marker, 'utf8'),
    JSON.stringify({
      schema: 1,
      kind: 'remote-omp',
      version: fixture.options.manifest!.version,
      sha256: fixture.options.manifest!.assets['linux-x64'].sha256
    })
  )
  assert.equal((await stat(marker)).mode & 0o777, 0o600)
})

test('fully verified installed version is reused without download or upload', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  await ensureRemoteOmpDeployment(fixture.options)
  await rm(fixture.options.cacheDir, { recursive: true })
  const reused = await ensureRemoteOmpDeployment({
    ...fixture.options,
    fetchImpl: async () => {
      throw new Error('must not fetch')
    }
  })
  assert.equal(reused.reused, true)
  assert.equal(fixture.session.uploads.length, 1)
})

test('an OMP directory without its ready marker is repaired instead of reused', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const first = await ensureRemoteOmpDeployment(fixture.options)
  const marker = deploymentReadyMarkerPath(dirname(first.executablePath))
  await rm(marker)

  const repaired = await ensureRemoteOmpDeployment(fixture.options)

  assert.equal(repaired.reused, false)
  assert.equal(fixture.session.uploads.length, 2)
  assert.equal((await stat(marker)).mode & 0o777, 0o600)
})

for (const scenario of [
  {
    name: 'wrong hash',
    mutate: (marker: string) => writeFile(marker, '{"wrong":true}', { mode: 0o600 })
  },
  {
    name: 'wrong mode',
    mutate: (marker: string) => chmod(marker, 0o644)
  },
  {
    name: 'symlink',
    mutate: async (marker: string) => {
      const target = `${marker}.target`
      await writeFile(target, await readFile(marker), { mode: 0o600 })
      await rm(marker)
      await symlink(target, marker)
    }
  }
] as const) {
  test(`OMP ${scenario.name} ready marker is repaired instead of used`, async (t) => {
    const fixture = await createRemoteOmpDeploymentFixture()
    t.after(fixture.cleanup)
    const first = await ensureRemoteOmpDeployment(fixture.options)
    const marker = deploymentReadyMarkerPath(dirname(first.executablePath))
    await scenario.mutate(marker)
    assert.equal((await ensureRemoteOmpDeployment(fixture.options)).reused, false)
    assert.equal(fixture.session.uploads.length, 2)
  })
}

test('corrupt or outdated installation is replaced while verified desktop cache is reused', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const first = await ensureRemoteOmpDeployment(fixture.options)
  await writeFile(first.executablePath, '#!/bin/sh\nprintf "18.1.10\\n"\n')
  await rm(deploymentReadyMarkerPath(dirname(first.executablePath)))
  const next = await ensureRemoteOmpDeployment(fixture.options)
  assert.equal(next.reused, false)
  assert.equal(fixture.downloads(), 1)
  assert.equal(fixture.session.uploads.length, 2)
  assert.equal(await readFile(first.executablePath, 'utf8'), fixture.payload)
  assert.equal(
    fixture.session.uploads[0].options?.transferId,
    fixture.session.uploads[1].options?.transferId
  )
})

test('matching hash with wrong installed --version forces redeployment', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture(
    '#!/bin/sh\nif [ -f "$HOME/wrong-version" ]; then printf "18.1.10\\n"; else printf "18.10.3\\n"; fi\n'
  )
  t.after(fixture.cleanup)
  const first = await ensureRemoteOmpDeployment(fixture.options)
  const marker = join(first.homePath, 'wrong-version')
  await writeFile(marker, '')
  await rm(deploymentReadyMarkerPath(dirname(first.executablePath)))
  const upload = fixture.host.transfer.uploadFile
  fixture.host.transfer.uploadFile = async (...args) => {
    // The existing binary's bytes still match; its real --version output is outdated.
    // Clear the fixture condition only after the deployer has decided to upload again.
    await upload(...args)
    await rm(marker)
  }
  const result = await ensureRemoteOmpDeployment(fixture.options)
  assert.equal(result.reused, false)
  assert.equal(fixture.session.uploads.length, 2)
})

test('bad downloaded hash never reaches the server and leaves no published cache or partial', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  await assert.rejects(
    ensureRemoteOmpDeployment({
      ...fixture.options,
      fetchImpl: async () => new Response('corrupt')
    }),
    { code: 'HASH_MISMATCH' }
  )
  assert.equal(fixture.session.uploads.length, 0)
  assert.deepEqual(await readdir(join(fixture.options.cacheDir, 'omp', '18.10.3', 'linux-x64')), [])
})

test('corrupt desktop cache is downloaded again', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const first = await ensureRemoteOmpDeployment(fixture.options)
  await rm(first.executablePath)
  await rm(deploymentReadyMarkerPath(dirname(first.executablePath)))
  await writeFile(fixture.session.uploads[0].localPath, 'corrupt local cache')
  await ensureRemoteOmpDeployment(fixture.options)
  assert.equal(fixture.downloads(), 2)
})

test('server hash mismatch preserves prior executable and removes unverified staging', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const executable = join(fixture.runtimeRoot, 'omp', '18.10.3', 'omp')
  await mkdir(join(fixture.runtimeRoot, 'omp', '18.10.3'), { recursive: true })
  await writeFile(executable, 'previous executable')
  const upload = fixture.host.transfer.uploadFile
  fixture.host.transfer.uploadFile = async (...args) => {
    await upload(...args)
    await writeFile(args[1], 'tampered on server')
  }
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'HASH_MISMATCH' })
  assert.equal(await readFile(executable, 'utf8'), 'previous executable')
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), ['omp'])
})

test('wrong downloaded binary version is rejected before atomic activation', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture('#!/bin/sh\nprintf "18.1.10\\n"\n')
  t.after(fixture.cleanup)
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'VERSION_MISMATCH' })
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [])
})

test('new CLI slash version format requires the exact desktop version', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture('#!/bin/sh\nprintf "omp/18.10.30\\n"\n')
  t.after(fixture.cleanup)
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'VERSION_MISMATCH' })
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [])
})

test('version check cannot inherit desktop/server provider environment', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const saved = process.env.OMP_TEST_SECRET
  process.env.OMP_TEST_SECRET = 'private-must-not-reach-version-process'
  t.after(() => {
    if (saved === undefined) delete process.env.OMP_TEST_SECRET
    else process.env.OMP_TEST_SECRET = saved
  })
  await ensureRemoteOmpDeployment(fixture.options)
})

test('cancel before work has no server or cache side effects', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    ensureRemoteOmpDeployment({ ...fixture.options, signal: controller.signal }),
    { name: 'AbortError' }
  )
  assert.equal(fixture.session.commands.length, 0)
  assert.equal(fixture.downloads(), 0)
})

test('cancel during streaming download cleans cache partial without uploading', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const controller = new AbortController()
  await assert.rejects(
    ensureRemoteOmpDeployment({
      ...fixture.options,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'downloading' && (event.bytesTransferred ?? 0) > 0) controller.abort()
      }
    }),
    { name: 'AbortError' }
  )
  assert.equal(fixture.session.uploads.length, 0)
  assert.deepEqual(await readdir(join(fixture.options.cacheDir, 'omp', '18.10.3', 'linux-x64')), [])
})

test('cancel after upload removes published staging and never activates it', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const controller = new AbortController()
  await assert.rejects(
    ensureRemoteOmpDeployment({
      ...fixture.options,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.transfer?.state === 'saved') controller.abort()
      }
    }),
    { name: 'AbortError' }
  )
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [])
  assert.equal(fixture.session.uploads[0].options?.signal, controller.signal)
})

test('concurrent callers serialize deployment and reuse the first atomic activation', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const results = await Promise.all([
    ensureRemoteOmpDeployment(fixture.options),
    ensureRemoteOmpDeployment(fixture.options)
  ])
  assert.deepEqual(
    results.map((result) => result.reused),
    [false, true]
  )
  assert.equal(fixture.session.uploads.length, 1)
})

test('low disk space and unwritable roots produce setting-specific errors without upload or HOME fallback', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const original = fixture.host.exec.run
  const shimDir = join(fixture.root, 'disk-shim')
  await mkdir(shimDir)
  const df = join(shimDir, 'df')
  await writeFile(
    df,
    '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100 100 0 100%% /runtime\\n"\n'
  )
  await chmod(df, 0o700)
  fixture.host.exec.run = (command, options) =>
    original(command, {
      ...options,
      env: { ...options.env, PATH: `${shimDir}:${process.env.PATH}` }
    })
  await assert.rejects(
    ensureRemoteOmpDeployment(fixture.options),
    (error: Error & { code: string }) => {
      assert.equal(error.code, 'INSUFFICIENT_SPACE')
      assert.ok(error.message.includes(fixture.runtimeRoot))
      return true
    }
  )
  fixture.host.exec.run = original
  await chmod(join(fixture.runtimeRoot, 'omp', '18.10.3'), 0o500)
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'PERMISSION_DENIED' })
  await chmod(join(fixture.runtimeRoot, 'omp', '18.10.3'), 0o700)
  assert.equal(fixture.session.uploads.length, 0)
})

test('unsafe roots and symlinked managed directories are rejected', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  for (const runtimeRoot of [
    '',
    '~/.omp',
    '/',
    `${fixture.runtimeRoot}/../other`,
    `${fixture.runtimeRoot}\nunsafe`
  ]) {
    await assert.rejects(ensureRemoteOmpDeployment({ ...fixture.options, runtimeRoot }), {
      code: 'INVALID_ARGUMENT'
    })
  }
  const outside = join(fixture.root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(fixture.runtimeRoot, 'omp'))
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'PERMISSION_DENIED' })
  assert.deepEqual(await readdir(outside), [])
})

test('HTTP failures and unexecutable binaries give explicit failures', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture('not an executable\n')
  t.after(fixture.cleanup)
  await assert.rejects(
    ensureRemoteOmpDeployment({
      ...fixture.options,
      fetchImpl: async () => new Response(null, { status: 503 })
    }),
    { code: 'DOWNLOAD_FAILED' }
  )
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), {
    code: 'REMOTE_COMMAND_FAILED'
  })
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [])
})

test('real WorkspaceHost streaming transfer integrates without a new upload stack', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
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
  const progress: RemoteOmpDeploymentProgress[] = []
  const result = await ensureRemoteOmpDeployment({
    ...fixture.options,
    runtimeHost: host,
    onProgress: (event) => progress.push(event)
  })
  assert.equal(await readFile(result.executablePath, 'utf8'), fixture.payload)
  assert.ok(progress.some((event) => event.transfer?.state === 'transferring'))
  assert.ok(progress.some((event) => event.transfer?.state === 'saved'))
  await chmod(result.executablePath, 0o600)
  await rm(deploymentReadyMarkerPath(dirname(result.executablePath)))
  assert.equal(
    (await ensureRemoteOmpDeployment({ ...fixture.options, runtimeHost: host })).reused,
    false
  )
})

test('cancelled queue wait returns promptly without letting another caller overtake deployment', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const fetchImpl = fixture.options.fetchImpl!
  let allowDownload!: () => void
  let downloadStarted!: () => void
  const held = new Promise<void>((resolve) => {
    allowDownload = resolve
  })
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve
  })
  const first = ensureRemoteOmpDeployment({
    ...fixture.options,
    fetchImpl: async (input, init) => {
      downloadStarted()
      await held
      return fetchImpl(input, init)
    }
  })
  await started
  const controller = new AbortController()
  const queued = ensureRemoteOmpDeployment({ ...fixture.options, signal: controller.signal })
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  controller.abort()
  await rejected
  const next = ensureRemoteOmpDeployment(fixture.options)
  assert.equal(fixture.downloads(), 0)
  allowDownload()
  assert.equal((await first).reused, false)
  assert.equal((await next).reused, true)
  assert.equal(fixture.session.uploads.length, 1)
})

test('transport-owned resumable partials survive a failed upload and retry keeps its identity', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const upload = fixture.host.transfer.uploadFile
  let interruptedId: string | undefined
  const partial = join(fixture.runtimeRoot, 'omp', '18.10.3', 'transport-owned.partial')
  fixture.host.transfer.uploadFile = async (_local, remote, options) => {
    interruptedId = options?.transferId
    await writeFile(partial, 'transport checkpoint')
    await writeFile(remote, 'unverified published staging')
    throw new Error('connection interrupted')
  }
  await assert.rejects(ensureRemoteOmpDeployment(fixture.options), /connection interrupted/)
  assert.deepEqual(await readdir(join(fixture.runtimeRoot, 'omp', '18.10.3')), [
    'transport-owned.partial'
  ])
  fixture.host.transfer.uploadFile = upload
  await ensureRemoteOmpDeployment(fixture.options)
  assert.equal(fixture.session.uploads[0].options?.transferId, interruptedId)
  assert.equal(await readFile(partial, 'utf8'), 'transport checkpoint')
})

test('late upload quota failure retains runtime root diagnostics', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  fixture.host.transfer.uploadFile = async () => {
    throw new Error('No space left on device')
  }
  await assert.rejects(
    ensureRemoteOmpDeployment(fixture.options),
    (error: Error & { code: string }) => {
      assert.equal(error.code, 'INSUFFICIENT_SPACE')
      assert.ok(error.message.includes(fixture.runtimeRoot))
      return true
    }
  )
})

test('selected cache root and every managed child reject symlinks without writing outside', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside-cache')
  await mkdir(outside, { mode: 0o755 })
  for (const suffix of [[], ['omp'], ['omp', '18.10.3'], ['omp', '18.10.3', 'linux-x64']]) {
    await rm(fixture.options.cacheDir, { recursive: true, force: true })
    const target = join(fixture.options.cacheDir, ...suffix)
    await mkdir(dirname(target), { recursive: true })
    await symlink(outside, target)
    await assert.rejects(ensureRemoteOmpDeployment(fixture.options), { code: 'PERMISSION_DENIED' })
    assert.deepEqual(await readdir(outside), [])
  }
})

test('existing managed cache directories and valid binary have private permissions on reuse', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const segments = [
    fixture.options.cacheDir,
    join(fixture.options.cacheDir, 'omp'),
    join(fixture.options.cacheDir, 'omp', '18.10.3'),
    join(fixture.options.cacheDir, 'omp', '18.10.3', 'linux-x64')
  ]
  for (const directory of segments) {
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o755)
  }
  const binary = join(segments[3], 'omp')
  await writeFile(binary, fixture.payload)
  await chmod(binary, 0o666)
  await ensureRemoteOmpDeployment(fixture.options)
  assert.equal(fixture.downloads(), 0)
  for (const directory of segments) assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(binary)).mode & 0o777, 0o600)
})

test('system-style ancestor symlinks are allowed outside the selected managed cache root', async (t) => {
  const fixture = await createRemoteOmpDeploymentFixture()
  t.after(fixture.cleanup)
  const alias = join(fixture.root, 'ancestor-alias')
  await symlink(fixture.root, alias)
  const result = await ensureRemoteOmpDeployment({
    ...fixture.options,
    cacheDir: join(alias, 'cache')
  })
  assert.equal(result.reused, false)
  assert.equal((await stat(fixture.options.cacheDir)).mode & 0o777, 0o700)
})

test('different hosts sharing a cache download once and preserve an active upload source identity', async (t) => {
  const first = await createRemoteOmpDeploymentFixture()
  const second = await createRemoteOmpDeploymentFixture()
  t.after(first.cleanup)
  t.after(second.cleanup)
  const sharedAncestor = join(second.root, 'shared-cache-ancestor')
  await symlink(first.root, sharedAncestor)
  let allowFirstDownload!: () => void
  let allowSecondDownload!: () => void
  let allowFirstUpload!: () => void
  let firstFetchStarted!: () => void
  let secondCacheEntered!: () => void
  let firstUploadStarted!: () => void
  const firstDownload = new Promise<void>((resolve) => {
    allowFirstDownload = resolve
  })
  const secondDownload = new Promise<void>((resolve) => {
    allowSecondDownload = resolve
  })
  const firstUpload = new Promise<void>((resolve) => {
    allowFirstUpload = resolve
  })
  const fetching = new Promise<void>((resolve) => {
    firstFetchStarted = resolve
  })
  const entering = new Promise<void>((resolve) => {
    secondCacheEntered = resolve
  })
  const uploading = new Promise<void>((resolve) => {
    firstUploadStarted = resolve
  })
  t.after(() => {
    allowFirstDownload()
    allowSecondDownload()
    allowFirstUpload()
  })
  const upload = first.host.transfer.uploadFile
  first.host.transfer.uploadFile = async (local, remote, options) => {
    const identity = await localSourceIdentity(local)
    firstUploadStarted()
    await firstUpload
    if (!sameSourceIdentity(identity, await localSourceIdentity(local))) {
      throw new TransferError(
        'SOURCE_CHANGED',
        'Shared cache inode changed during an active upload'
      )
    }
    await upload(local, remote, options)
  }
  const firstFetch = first.options.fetchImpl!
  const firstDeployment = ensureRemoteOmpDeployment({
    ...first.options,
    fetchImpl: async (input, init) => {
      firstFetchStarted()
      await firstDownload
      return firstFetch(input, init)
    }
  }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )
  await fetching
  const secondFetch = second.options.fetchImpl!
  const secondDeployment = ensureRemoteOmpDeployment({
    ...second.options,
    cacheDir: join(sharedAncestor, 'cache'),
    onProgress: (event) => {
      if (event.phase === 'downloading') secondCacheEntered()
    },
    fetchImpl: async (input, init) => {
      await secondDownload
      return secondFetch(input, init)
    }
  })
  await entering
  allowFirstDownload()
  await uploading
  allowSecondDownload()
  const secondResult = await secondDeployment
  allowFirstUpload()
  const firstResult = await firstDeployment
  if (firstResult.error) throw firstResult.error
  assert.equal(firstResult.value?.reused, false)
  assert.equal(secondResult.reused, false)
  assert.equal(first.downloads() + second.downloads(), 1)
})
