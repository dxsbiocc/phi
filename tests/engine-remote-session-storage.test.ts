import assert from 'node:assert/strict'
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { shellQuote as q } from '../src/main/agent/wrappers/remote-ssh-session'
import { acquireOwnedRemoteLock } from '../src/main/agent/engine/rpc/extension-deployment/remote-lock'
import {
  deriveRemoteSessionPaths,
  remoteJournalPath
} from '../src/main/agent/engine/rpc/session-storage/paths'
import {
  publishRemoteSessionManifest,
  readRemoteSessionManifest,
  validateRemoteSessionManifest
} from '../src/main/agent/engine/rpc/session-storage/remote-manifest'
import { preflightRemoteJournal } from '../src/main/agent/engine/rpc/session-storage/remote-preflight'
import { prepareRemoteSessionStorage } from '../src/main/agent/engine/rpc/session-storage/writer-lease'
import {
  createRemoteSessionStorageFixture,
  prepareRemoteSessionStorageFixture as prepared
} from './helpers/remoteSessionStorageFixture'

async function noTemporaryFiles(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await readdir(directory)).some((name) => name.startsWith('.manifest-'))) return
    await delay(20)
  }
  assert.fail('Owned manifest staging cleanup did not finish')
}

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === code

test('durable paths are deterministic and each trusted identity dimension separates scope', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  assert.deepEqual(deriveRemoteSessionPaths({ ...f.scope }), f.paths)
  for (const [key, value] of Object.entries({
    hostProfileId: 'other-host',
    bindingHash: 'b'.repeat(64),
    projectId: 'other-project',
    projectRoot: '/other-project',
    runtimeRoot: '/other-runtime',
    phiSessionId: 'other-session'
  }))
    assert.notEqual(
      deriveRemoteSessionPaths({ ...f.scope, [key]: value }).directory,
      f.paths.directory
    )
  assert.ok(f.paths.directory.startsWith(`${f.runtimeRoot}/omp-sessions/`))
  assert.equal(f.paths.blobs, join(f.paths.directory, 'data', 'omp', 'blobs'))
  for (const scope of [
    { ...f.scope, phiSessionId: '../outside' },
    { ...f.scope, runtimeRoot: '/tmp/../bad' },
    { ...f.scope, runtimeRoot: '/tmp/' },
    { ...f.scope, projectRoot: '/tmp/' },
    { ...f.scope, bindingHash: 'not-a-host-binding' },
    { ...f.scope, projectId: undefined },
    { ...f.scope, proxyToken: 'forbidden' }
  ])
    assert.throws(() => deriveRemoteSessionPaths(scope as typeof f.scope), hasCode('INVALID_SCOPE'))
})

test('preparation creates private owned canonical durable paths and release preserves journals, blobs and artifacts', async (t) => {
  const f = await prepared(t)
  for (const path of [f.paths.directory, f.paths.journals, f.paths.data, f.paths.blobs]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700)
    assert.equal((await stat(path)).uid, process.getuid!())
    assert.equal((await lstat(path)).isSymbolicLink(), false)
  }
  await f.writeJournal()
  const artifact = join(f.paths.journals, '2026-10-13_sdk-session-1', 'artifact.txt')
  await mkdir(dirname(artifact), { mode: 0o700 })
  await writeFile(artifact, 'durable artifact', { mode: 0o600 })
  const blob = join(f.paths.blobs, 'a'.repeat(64))
  await writeFile(blob, Buffer.from([0, 1, 255]), { mode: 0o600 })
  await f.preparation.lease.release()
  assert.equal(await readFile(artifact, 'utf8'), 'durable artifact')
  assert.deepEqual(await readFile(blob), Buffer.from([0, 1, 255]))
  assert.ok((await readFile(f.journalPath, 'utf8')).includes('sdk-session-1'))
  assert.equal((await stat(f.paths.lock)).mode & 0o777, 0o600)
  assert.equal(f.lockSession.closed, false)
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('LEASE_LOST'))
})

test('server manifest is strict, private, secret-free and cannot silently retarget an existing session', async (t) => {
  const f = await prepared(t)
  assert.equal(await readRemoteSessionManifest(f.preparation), undefined)
  const manifest = await publishRemoteSessionManifest(f.preparation, f.reference)
  assert.deepEqual(await readRemoteSessionManifest(f.preparation), manifest)
  assert.equal((await stat(f.paths.manifest)).mode & 0o777, 0o600)
  assert.equal((await stat(f.paths.manifest)).nlink, 1)
  assert.ok(
    !/token|proxy|generation|password|headers/i.test(await readFile(f.paths.manifest, 'utf8'))
  )
  for (const extra of [
    { token: 'secret' },
    { proxyUrl: 'http://localhost:123' },
    { generation: 2 }
  ])
    assert.throws(
      () => validateRemoteSessionManifest(f.preparation, { ...manifest, ...extra }),
      hasCode('FILE_INVALID')
    )
  await assert.rejects(
    publishRemoteSessionManifest(f.preparation, {
      ...f.reference,
      ompSessionId: 'sdk-other',
      journalBasename: 'other.jsonl'
    }),
    hasCode('IDENTITY_MISMATCH')
  )
  assert.deepEqual(await readRemoteSessionManifest(f.preparation), manifest)
  await noTemporaryFiles(f.paths.directory)
})

test('manifest reader rejects malformed, oversized, wrong identity/version and unsafe files', async (t) => {
  const f = await prepared(t)
  const manifest = await publishRemoteSessionManifest(f.preparation, f.reference)
  for (const [content, code] of [
    ['{', 'FILE_INVALID'],
    ['x'.repeat(16385), 'FILE_INVALID'],
    [JSON.stringify({ ...manifest, projectRoot: '/wrong-project' }), 'IDENTITY_MISMATCH'],
    [JSON.stringify({ ...manifest, ompVersion: '18.10.30' }), 'IDENTITY_MISMATCH'],
    [JSON.stringify({ ...manifest, schemaVersion: 2 }), 'FILE_INVALID']
  ]) {
    await writeFile(f.paths.manifest, content)
    await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode(code))
  }
  await writeFile(f.paths.manifest, JSON.stringify(manifest))
  await chmod(f.paths.manifest, 0o644)
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('PERMISSION_DENIED'))
  await chmod(f.paths.manifest, 0o600)
  const alias = join(f.paths.directory, 'manifest-alias')
  await link(f.paths.manifest, alias)
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('FILE_INVALID'))
  await rm(f.paths.manifest)
  await symlink(alias, f.paths.manifest)
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('PATH_INVALID'))
})

test('strict journal header preflight accepts SDK identity without claiming session adoption', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const verified = await preflightRemoteJournal(f.preparation, f.reference)
  assert.match(verified.fileIdentity, /^[a-f0-9]{64}$/)
  assert.match(verified.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(verified, {
    journalPath: f.journalPath,
    ompSessionId: 'sdk-session-1',
    cwd: f.scope.projectRoot,
    headerVersion: 3,
    fileIdentity: verified.fileIdentity,
    fingerprint: verified.fingerprint,
    verification: 'bounded-header'
  })
  assert.equal(remoteJournalPath(f.scope, f.reference), f.journalPath)
  for (const journalBasename of [
    '../outside.jsonl',
    '/tmp/outside.jsonl',
    'a/../../x.jsonl',
    '..jsonl',
    'x.txt'
  ])
    assert.throws(
      () => remoteJournalPath(f.scope, { ...f.reference, journalBasename }),
      hasCode('IDENTITY_MISMATCH')
    )
})

test('missing, empty, truncated, corrupt and oversized journal headers fail explicitly', async (t) => {
  const f = await prepared(t)
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('FILE_MISSING'))
  for (const bytes of [
    '',
    '{\n',
    '{"type":"session"}',
    `${'x'.repeat(16385)}\n`,
    Buffer.from([0xff, 0x0a]),
    Buffer.from([0, 0x0a])
  ]) {
    await writeFile(f.journalPath, bytes, { mode: 0o600 })
    await assert.rejects(
      preflightRemoteJournal(f.preparation, f.reference),
      hasCode('FILE_INVALID')
    )
  }
  for (const override of [{ type: 'message' }, { version: 2 }, { timestamp: 'bad' }]) {
    await f.writeJournal(override)
    await assert.rejects(
      preflightRemoteJournal(f.preparation, f.reference),
      hasCode('FILE_INVALID')
    )
  }
  for (const override of [{ id: 'wrong-sdk-session' }, { cwd: '/wrong-project' }]) {
    await f.writeJournal(override)
    await assert.rejects(
      preflightRemoteJournal(f.preparation, f.reference),
      hasCode('IDENTITY_MISMATCH')
    )
  }
})

test('journal private mode, hardlinks, symlinks and unsafe parent directories are rejected', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  await chmod(f.journalPath, 0o640)
  await assert.rejects(
    preflightRemoteJournal(f.preparation, f.reference),
    hasCode('PERMISSION_DENIED')
  )
  await chmod(f.journalPath, 0o600)
  const alias = join(f.paths.journals, 'alias.jsonl')
  await link(f.journalPath, alias)
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('FILE_INVALID'))
  await rm(f.journalPath)
  await symlink(alias, f.journalPath)
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('PATH_INVALID'))
  await rm(f.journalPath)
  await f.writeJournal()
  await chmod(f.paths.journals, 0o755)
  await assert.rejects(
    preflightRemoteJournal(f.preparation, f.reference),
    hasCode('PERMISSION_DENIED')
  )
  await chmod(f.paths.journals, 0o700)
  await rm(f.paths.journals, { recursive: true })
  const outside = join(f.root, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await symlink(outside, f.paths.journals)
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('PATH_INVALID'))
})

test('storage preparation rejects symlinked managed ancestors and noncanonical project roots', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const outside = join(f.root, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await symlink(outside, join(f.runtimeRoot, 'omp-sessions'))
  await assert.rejects(prepareRemoteSessionStorage(f.options), hasCode('PATH_INVALID'))
  await rm(join(f.runtimeRoot, 'omp-sessions'))
  const alias = join(f.root, 'project-alias')
  await symlink(f.scope.projectRoot, alias)
  await assert.rejects(
    prepareRemoteSessionStorage({
      ...f.options,
      scope: { ...f.scope, projectRoot: alias }
    }),
    hasCode('IDENTITY_MISMATCH')
  )
  assert.equal(f.channels.length, 0)
})

test('wrong owner is classified from real shell metadata validation before reading data', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const run = f.host.exec.run
  f.host.exec.run = (command, options) =>
    run(
      [
        'sh',
        '-c',
        `stat() { if [ "$1" = -c ] && [ "$2" = %u ] && [ "$4" = ${q(f.journalPath)} ]; then printf '99999\\n'; else command stat "$@"; fi; }\n${command[2]}`
      ],
      options
    )
  await assert.rejects(
    preflightRemoteJournal(f.preparation, f.reference),
    hasCode('PERMISSION_DENIED')
  )
})

test('atomic publication failure preserves the previous manifest and cleans only its owned temporary file', async (t) => {
  const f = await prepared(t)
  const original = await publishRemoteSessionManifest(f.preparation, f.reference)
  const bytes = await readFile(f.paths.manifest)
  const run = f.host.exec.run
  f.host.exec.run = (command, options) =>
    run(['sh', '-c', `mv() { return 1; }\n${command[2]}`], options)
  await assert.rejects(
    publishRemoteSessionManifest(f.preparation, f.reference),
    hasCode('PERSISTENCE_FAILED')
  )
  assert.deepEqual(await readFile(f.paths.manifest), bytes)
  f.host.exec.run = run
  assert.deepEqual(await readRemoteSessionManifest(f.preparation), original)
  await noTemporaryFiles(f.paths.directory)
})

test('writer conflict remains busy for an old live lock and EOF permits a fresh writer with the same inode', async (t) => {
  const f = await prepared(t)
  const inode = (await stat(f.paths.lock)).ino
  await utimes(f.paths.lock, new Date(0), new Date(0))
  await assert.rejects(
    prepareRemoteSessionStorage({ ...f.options, lockWaitMs: 0 }),
    hasCode('SESSION_BUSY')
  )
  f.preparation.lease.assertActive()
  await f.channels[0].close()
  await assert.rejects(f.preparation.lease.lost, hasCode('LEASE_LOST'))
  const replacement = await prepareRemoteSessionStorage({ ...f.options, lockWaitMs: 1000 })
  t.after(() => replacement.lease.release())
  assert.equal((await stat(f.paths.lock)).ino, inode)
  assert.equal(f.lockSession.closed, false)
})

test('transport loss during a staged manifest write prevents publication and retires authority', async (t) => {
  const f = await prepared(t)
  const write = f.host.fs.writeAtomic
  f.host.fs.writeAtomic = async (...args) => {
    const result = await write(...args)
    await f.channels[0].close()
    await assert.rejects(f.preparation.lease.lost, hasCode('LEASE_LOST'))
    return result
  }
  await assert.rejects(
    publishRemoteSessionManifest(f.preparation, f.reference),
    hasCode('LEASE_LOST')
  )
  await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
  await noTemporaryFiles(f.paths.directory)
})

test('caller cancellation before late staging completes never publishes or deletes durable data', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const controller = new AbortController()
  const preparation = await prepareRemoteSessionStorage({ ...f.options, signal: controller.signal })
  t.after(() => preparation.lease.release())
  await f.writeJournal()
  const write = f.host.fs.writeAtomic
  f.host.fs.writeAtomic = async (...args) => {
    const result = await write(...args)
    controller.abort()
    return result
  }
  await assert.rejects(publishRemoteSessionManifest(preparation, f.reference), {
    name: 'AbortError'
  })
  await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
  assert.ok((await readFile(f.journalPath, 'utf8')).includes('sdk-session-1'))
  await noTemporaryFiles(f.paths.directory)
})

test('generic lock validates containment, basename and bounded wait before opening any channel', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const base = {
    root: f.runtimeRoot,
    directory: join(f.runtimeRoot, 'locks'),
    basename: 'lease.lock',
    signal: new AbortController().signal,
    openStdio: f.options.openLockStdio
  }
  for (const override of [
    { directory: `${f.runtimeRoot}-other/locks` },
    { directory: `${f.runtimeRoot}/../locks` },
    { directory: f.runtimeRoot },
    { directory: `${f.runtimeRoot}/locks/` },
    { basename: '../escape' },
    { basename: '.' },
    { waitMs: -1 },
    { waitMs: 30001 },
    { waitMs: NaN },
    { waitMs: 1.5 }
  ])
    await assert.rejects(
      acquireOwnedRemoteLock({ ...base, ...override }),
      /Invalid owned remote lock/
    )
  assert.equal(f.channels.length, 0)
})

test('different stable Phi sessions hold independent writer leases', async (t) => {
  const f = await prepared(t)
  const second = await prepareRemoteSessionStorage({
    ...f.options,
    scope: { ...f.scope, phiSessionId: 'phi-session-2' },
    lockWaitMs: 0
  })
  t.after(() => second.lease.release())
  assert.notEqual(second.paths.lock, f.paths.lock)
  f.preparation.lease.assertActive()
  second.lease.assertActive()
  await second.lease.release()
  f.preparation.lease.assertActive()
})

test('cancelling a pending staging transport settles immediately and cleans its late result without publication', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const controller = new AbortController()
  const preparation = await prepareRemoteSessionStorage({ ...f.options, signal: controller.signal })
  t.after(() => preparation.lease.release())
  let enter!: () => void
  let finish!: () => void
  let late!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const completed = new Promise<void>((resolve) => {
    late = resolve
  })
  const write = f.host.fs.writeAtomic
  f.host.fs.writeAtomic = async (...args) => {
    enter()
    await gate
    const result = await write(...args)
    late()
    return result
  }
  const publishing = publishRemoteSessionManifest(preparation, f.reference)
  await entered
  const rejected = assert.rejects(publishing, { name: 'AbortError' })
  controller.abort()
  try {
    await Promise.race([
      rejected,
      delay(1000).then(() => {
        assert.fail('Cancelled staging did not retire promptly')
      })
    ])
    await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
  } finally {
    finish()
  }
  await completed
  await noTemporaryFiles(f.paths.directory)
  await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
})

test('cancellation after atomic rename reports failure while leaving a complete manifest for explicit reconciliation', async (t) => {
  const f = await createRemoteSessionStorageFixture()
  t.after(f.cleanup)
  const controller = new AbortController()
  const preparation = await prepareRemoteSessionStorage({ ...f.options, signal: controller.signal })
  t.after(() => preparation.lease.release())
  const run = f.host.exec.run
  f.host.exec.run = async (command, options) => {
    const result = await run(command, options)
    if (command[2]?.includes('mv -f --')) controller.abort()
    return result
  }
  await assert.rejects(publishRemoteSessionManifest(preparation, f.reference), {
    name: 'AbortError'
  })
  assert.equal(
    JSON.parse(await readFile(f.paths.manifest, 'utf8')).ompSessionId,
    f.reference.ompSessionId
  )
  assert.equal((await stat(f.paths.manifest)).mode & 0o777, 0o600)
  await noTemporaryFiles(f.paths.directory)
})

test('journal snapshots distinguish a valid append from replacement by another inode with the same header', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const first = await preflightRemoteJournal(f.preparation, f.reference)
  const initialBytes = await readFile(f.journalPath)
  await writeFile(
    f.journalPath,
    Buffer.concat([initialBytes, Buffer.from('{"type":"model_change"}\n')])
  )
  const appended = await preflightRemoteJournal(f.preparation, f.reference)
  assert.equal(appended.fileIdentity, first.fileIdentity)
  assert.notEqual(appended.fingerprint, first.fingerprint)
  const replacement = join(f.paths.journals, 'replacement.jsonl')
  await writeFile(replacement, await readFile(f.journalPath), { mode: 0o600 })
  await rename(replacement, f.journalPath)
  const replaced = await preflightRemoteJournal(f.preparation, f.reference)
  assert.notEqual(replaced.fileIdentity, appended.fileIdentity)
  assert.notEqual(replaced.fingerprint, appended.fingerprint)
})

test('a journal that changes while its bounded header is read is rejected as an unstable preflight', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const run = f.host.exec.run
  f.host.exec.run = (command, options) =>
    run(
      [
        'sh',
        '-c',
        `head() { command head "$@"; printf 'changed' >> ${q(f.journalPath)}; }\n${command[2]}`
      ],
      options
    )
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('FILE_INVALID'))
})

test('runtime root permission failures and transport errors are explicitly classified', async (t) => {
  const f = await prepared(t)
  await chmod(f.runtimeRoot, 0o777)
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('PERMISSION_DENIED'))
  await chmod(f.runtimeRoot, 0o700)
  f.host.exec.run = async () => {
    throw new Error('fixture transport unavailable')
  }
  await assert.rejects(readRemoteSessionManifest(f.preparation), hasCode('PERSISTENCE_FAILED'))
})
