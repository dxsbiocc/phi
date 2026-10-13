import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  publishRemoteSessionManifest,
  readRemoteSessionManifest
} from '../src/main/agent/engine/rpc/session-storage/remote-manifest'
import { preflightRemoteJournal } from '../src/main/agent/engine/rpc/session-storage/remote-preflight'
import { deriveRemoteSessionPaths } from '../src/main/agent/engine/rpc/session-storage/paths'
import type { RemoteSessionStoragePreparation } from '../src/main/agent/engine/rpc/session-storage/types'
import {
  actualSdkTitleSlot,
  prepareRemoteSessionStorageFixture as prepared
} from './helpers/remoteSessionStorageFixture'

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === code

test('SDK fixed title slot followed by a session header is accepted; legacy header remains valid', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const bytes = await readFile(f.journalPath)
  assert.equal(bytes.indexOf(10), 255)
  assert.equal(JSON.parse(bytes.subarray(0, 255).toString()).type, 'title')
  assert.equal(
    (await preflightRemoteJournal(f.preparation, f.reference)).ompSessionId,
    f.reference.ompSessionId
  )
  await f.writeJournal({}, false)
  assert.equal(
    (await preflightRemoteJournal(f.preparation, f.reference)).ompSessionId,
    f.reference.ompSessionId
  )
})

test('concurrent different manifest identities cannot both publish through one writer preparation', async (t) => {
  const f = await prepared(t)
  const write = f.host.fs.writeAtomic
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let writes = 0
  f.host.fs.writeAtomic = async (...args) => {
    writes++
    if (writes === 1) {
      enter()
      await gate
    }
    return write(...args)
  }
  const first = publishRemoteSessionManifest(f.preparation, f.reference)
  await entered
  const other = { ...f.reference, ompSessionId: 'sdk-other', journalBasename: 'other.jsonl' }
  const second = assert.rejects(
    publishRemoteSessionManifest(f.preparation, other),
    hasCode('IDENTITY_MISMATCH')
  )
  void second.catch(() => undefined)
  await delay(150)
  release()
  await Promise.all([first, second])
  assert.equal(writes, 1)
  assert.equal(
    (await readRemoteSessionManifest(f.preparation))!.ompSessionId,
    f.reference.ompSessionId
  )
})

test('title-prefix validation rejects corrupt schemas, extra prefixes, truncation and invalid UTF-8', async (t) => {
  const f = await prepared(t)
  await f.writeJournal()
  const header = (await readFile(f.journalPath)).subarray(256)
  const valid = actualSdkTitleSlot({ title: '普通会话', source: 'user' })
  const invalidSlot = (overrides: Record<string, unknown>): string => {
    const slot = { ...JSON.parse(valid), ...overrides, pad: '' }
    const missing = 256 - Buffer.byteLength(`${JSON.stringify(slot)}\n`)
    slot.pad = ' '.repeat(missing)
    return `${JSON.stringify(slot)}\n`
  }
  for (const prefix of [
    invalidSlot({ v: 2 }),
    invalidSlot({ title: 7 }),
    invalidSlot({ updatedAt: 'bad' }),
    invalidSlot({ source: 'external' }),
    invalidSlot({ unexpected: true }),
    valid.replace(/ +"}/, (padding) => `x${padding.slice(1)}`),
    `${valid}${valid}`,
    '{"type":"message"}\n',
    `${'x'.repeat(16385)}\n`,
    Buffer.concat([Buffer.from([0xff]), Buffer.from(valid).subarray(1)])
  ]) {
    await writeFile(f.journalPath, Buffer.concat([Buffer.from(prefix), header]))
    await assert.rejects(
      preflightRemoteJournal(f.preparation, f.reference),
      hasCode('FILE_INVALID')
    )
  }
  await writeFile(
    f.journalPath,
    Buffer.concat([Buffer.from(valid), header.subarray(0, header.length - 1)])
  )
  await assert.rejects(preflightRemoteJournal(f.preparation, f.reference), hasCode('FILE_INVALID'))
  await writeFile(f.journalPath, Buffer.concat([Buffer.from(valid), header]))
  const first = await preflightRemoteJournal(f.preparation, f.reference)
  await writeFile(
    f.journalPath,
    Buffer.concat([Buffer.from(actualSdkTitleSlot({ title: '新的标题', source: 'user' })), header])
  )
  const renamed = await preflightRemoteJournal(f.preparation, f.reference)
  assert.equal(renamed.fileIdentity, first.fileIdentity)
  assert.notEqual(renamed.fingerprint, first.fingerprint)
})

test('a cancelled middle publication cannot let its successor pass the active predecessor', async (t) => {
  const f = await prepared(t)
  const write = f.host.fs.writeAtomic
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let writes = 0
  f.host.fs.writeAtomic = async (...args) => {
    writes++
    if (writes === 1) {
      enter()
      await gate
    }
    return write(...args)
  }
  const first = publishRemoteSessionManifest(f.preparation, f.reference)
  await entered
  const controller = new AbortController()
  const middle = assert.rejects(
    publishRemoteSessionManifest(f.preparation, f.reference, controller.signal),
    { name: 'AbortError' }
  )
  controller.abort()
  await Promise.race([
    middle,
    delay(1000).then(() => assert.fail('Queued cancellation did not settle'))
  ])
  const third = publishRemoteSessionManifest(f.preparation, f.reference)
  try {
    await delay(150)
    assert.equal(writes, 1)
  } finally {
    release()
  }
  await Promise.all([first, third])
  assert.equal(writes, 2)
  f.preparation.lease.assertActive()
  assert.equal(
    (await readRemoteSessionManifest(f.preparation))!.ompSessionId,
    f.reference.ompSessionId
  )
})

test('a cancelled active publication retains its queue tail until a late commit settles', async (t) => {
  const f = await prepared(t)
  const run = f.host.exec.run
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let gated = false
  f.host.exec.run = async (command, options) => {
    if (!gated && command[2]?.includes('mv -f --')) {
      gated = true
      // The server already committed; only its transport acknowledgement is held.
      const committed = await run(command, { ...options, signal: undefined })
      enter()
      await gate
      return committed
    }
    return run(command, options)
  }
  const controller = new AbortController()
  const first = publishRemoteSessionManifest(f.preparation, f.reference, controller.signal)
  await entered
  const rejected = assert.rejects(first, { name: 'AbortError' })
  controller.abort()
  await Promise.race([
    rejected,
    delay(1000).then(() => assert.fail('Active cancellation did not settle'))
  ])
  let readAfterCancel = false
  const normalRun = f.host.exec.run
  f.host.exec.run = async (...args) => {
    if (args[0][2]?.includes('PHI_STORAGE_MANIFEST_MISSING')) readAfterCancel = true
    return normalRun(...args)
  }
  const successor = publishRemoteSessionManifest(f.preparation, f.reference)
  try {
    await delay(150)
    assert.equal(readAfterCancel, false)
  } finally {
    release()
  }
  await successor
  f.preparation.lease.assertActive()
  assert.equal(
    (await readRemoteSessionManifest(f.preparation))!.ompSessionId,
    f.reference.ompSessionId
  )
})

test('manifest byte budget rejects oversized serialized identities before staging', async (t) => {
  const f = await prepared(t)
  const scope = {
    ...f.scope,
    projectRoot: `/${'\\'.repeat(4094)}`,
    runtimeRoot: `/${'\\'.repeat(4094)}`
  }
  const paths = deriveRemoteSessionPaths(scope)
  const preparation: RemoteSessionStoragePreparation = { scope, paths, lease: f.preparation.lease }
  await assert.rejects(
    publishRemoteSessionManifest(preparation, {
      ...f.reference,
      ...scope,
      durableSessionKey: paths.durableSessionKey
    }),
    hasCode('FILE_INVALID')
  )
  assert.deepEqual(
    (await readdir(f.paths.directory)).filter((name) => name.startsWith('.manifest-')),
    []
  )
  await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
})

test('operation cancellation during pending staging preserves lease and orders a different successor identity', async (t) => {
  const f = await prepared(t)
  const write = f.host.fs.writeAtomic
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let writes = 0
  f.host.fs.writeAtomic = async (...args) => {
    writes++
    if (writes === 1) {
      enter()
      await gate
    }
    return write(...args)
  }
  const controller = new AbortController()
  const first = publishRemoteSessionManifest(f.preparation, f.reference, controller.signal)
  await entered
  const rejected = assert.rejects(first, { name: 'AbortError' })
  controller.abort()
  await Promise.race([
    rejected,
    delay(1000).then(() => assert.fail('Active staging cancellation did not settle'))
  ])
  f.preparation.lease.assertActive()
  const other = {
    ...f.reference,
    ompSessionId: 'sdk-successor',
    journalBasename: 'successor.jsonl'
  }
  const successor = publishRemoteSessionManifest(f.preparation, other)
  try {
    await delay(150)
    assert.equal(writes, 1)
    await assert.rejects(stat(f.paths.manifest), { code: 'ENOENT' })
  } finally {
    release()
  }
  await successor
  f.preparation.lease.assertActive()
  assert.equal((await readRemoteSessionManifest(f.preparation))!.ompSessionId, other.ompSessionId)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await readdir(f.paths.directory)).some((name) => name.startsWith('.manifest-'))) return
    await delay(20)
  }
  assert.fail('Cancelled predecessor left its staging file behind')
})
