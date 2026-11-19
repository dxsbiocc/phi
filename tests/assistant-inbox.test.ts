import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  type PromptImageInput
} from '../src/shared/promptImageTypes'
import { createAssistantInbox } from '../src/main/session-runtime/assistant-inbox'

const scope = { conversationId: 'chat', projectId: 'project-a' }
const peer = { conversationId: 'chat', projectId: 'project-b' }
const gif = (suffix: string): PromptImageInput => ({
  mimeType: 'image/gif',
  data: Buffer.from(`GIF89a${suffix}`).toString('base64')
})

async function fixture(t: TestContext): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'phi-assistant-inbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'assistant-inbox.json') }
}

test('independent task claims and cancellation remain separate after reopening one chat', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const independent = { independent: true, kernelSessionId: 'kernel-session' }
  const a = await inbox.submit(scope, 'a', 'Independent A', independent)
  const b = await inbox.submit(scope, 'b', 'Independent B', independent)
  const foreground = await inbox.submit(scope, 'ordinary', 'Ordinary')
  const aAttempt = randomUUID()
  const bAttempt = randomUUID()
  const foregroundAttempt = randomUUID()
  assert.equal((await inbox.claim(scope, foregroundAttempt))?.id, foreground.id)
  assert.equal((await inbox.claimIndependent(scope, aAttempt, a.id))?.id, a.id)
  assert.equal((await inbox.claimIndependent(scope, bAttempt, b.id))?.id, b.id)
  assert.equal(await inbox.bindChild(scope, a.id, bAttempt, 'run_2'), false)
  assert.equal(await inbox.bindChild(scope, a.id, aAttempt, 'run_1'), true)
  assert.equal(await inbox.bindChild(scope, b.id, bAttempt, 'run_2'), true)
  assert.equal(await inbox.requestCancel(scope, a.id, aAttempt), true)
  assert.equal(await inbox.settle(scope, a.id, aAttempt, 'defer'), false)

  const recovered = createAssistantInbox(directory)
  await recovered.recover(() => 'interrupted')
  assert.deepEqual(
    (await recovered.list(scope)).map(({ id, status, childRunId, cancelRequested }) => ({
      id,
      status,
      childRunId,
      cancelRequested
    })),
    [
      { id: a.id, status: 'running', childRunId: 'run_1', cancelRequested: true },
      { id: b.id, status: 'running', childRunId: 'run_2', cancelRequested: undefined },
      {
        id: foreground.id,
        status: 'interrupted',
        childRunId: undefined,
        cancelRequested: undefined
      }
    ]
  )
  assert.equal(await recovered.settle(scope, b.id, aAttempt, 'succeeded', 'wrong'), false)
  const result = '结果'.repeat(1_000)
  assert.equal(await recovered.settle(scope, b.id, bAttempt, 'succeeded', result), true)
  const completed = (await recovered.list(scope)).find(({ id }) => id === b.id)
  assert.equal(completed?.status, 'succeeded')
  assert.ok(completed.result && Buffer.byteLength(completed.result) <= 4096)
  assert.ok(result.startsWith(completed.result))
  assert.equal((await recovered.list(scope)).find(({ id }) => id === a.id)?.status, 'running')
})

function restoreFsMocks(t: TestContext): void {
  t.mock.restoreAll()
  syncBuiltinESMExports()
}

test('reopened inbox preserves image-only prompts, ordering, mode and request identity', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const images = [gif('first'), gif('next'), gif('first')]
  const accepted = await inbox.submit(scope, 'multimodal', '', { images, mode: 'plan' })
  assert.equal(accepted.mode, 'plan')
  assert.equal((await readdir(join(directory, 'attachments'))).length, 2)
  assert.equal((await readFile(path, 'utf8')).includes(images[0].data), false)
  await assert.rejects(inbox.submit(scope, 'multimodal', '', { images }), /request conflict/)
  await assert.rejects(
    inbox.submit(scope, 'multimodal', '', { images: images.slice(1), mode: 'plan' }),
    /request conflict/
  )
  await assert.rejects(
    inbox.submit(scope, 'invalid', '', { images: [{ ...images[0], data: 'AAAA' }] })
  )
  await assert.rejects(inbox.submit(scope, 'sparse', '', { images: new Array(1) }))
  const recovered = createAssistantInbox(directory)
  await recovered.recover()
  assert.deepEqual(
    await recovered.submit(scope, 'multimodal', '', { images, mode: 'plan' }),
    accepted
  )
  const attemptId = randomUUID()
  assert.equal((await recovered.claim(scope, attemptId))?.id, accepted.id)
  await assert.rejects(recovered.loadImages(peer, accepted.id, attemptId), /no longer active/)
  await assert.rejects(recovered.loadImages(scope, accepted.id, randomUUID()), /no longer active/)
  assert.deepEqual(await recovered.loadImages(scope, accepted.id, attemptId), images)
  await recovered.settle(scope, accepted.id, attemptId, 'succeeded')
  await assert.rejects(recovered.loadImages(scope, accepted.id, attemptId), /no longer active/)
})

test('attachment integrity fails closed on replacement, missing files and links', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const image = gif('first')
  const entry = await inbox.submit(scope, 'image', 'inspect', { images: [image] })
  const attemptId = randomUUID()
  await inbox.claim(scope, attemptId)
  const path = join(directory, 'attachments', `${entry.attachments?.[0].digest}.image`)
  await writeFile(path, Buffer.from('GIF89aother'))
  await assert.rejects(inbox.loadImages(scope, entry.id, attemptId), /integrity/)
  await unlink(path)
  await assert.rejects(inbox.loadImages(scope, entry.id, attemptId), /ENOENT/)
  if (process.platform === 'win32') return
  const original = join(directory, 'unrelated')
  await writeFile(original, Buffer.from(image.data, 'base64'), { mode: 0o600 })
  await symlink(original, path, 'file')
  await assert.rejects(inbox.loadImages(scope, entry.id, attemptId), /Invalid/)
  await unlink(path)
  await link(original, path)
  await assert.rejects(inbox.loadImages(scope, entry.id, attemptId), /Invalid/)
  assert.deepEqual(await readFile(original), Buffer.from(image.data, 'base64'))
})

test('the inbox captures attachment identity before a caller can change its draft', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const original = gif('original')
  const image = { ...original }
  const images = [image]
  const submitted = inbox.submit(scope, 'mutable-draft', '', { images })
  image.data = gif('changed').data
  images.push(gif('added'))
  const entry = await submitted
  const attemptId = randomUUID()
  await inbox.claim(scope, attemptId)
  assert.deepEqual(await inbox.loadImages(scope, entry.id, attemptId), [original])
})

test('cancel and success release unused blobs without invalidating duplicate receipts', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const attachments = join(directory, 'attachments')
  const images = [gif('shared')]
  const first = await inbox.submit(scope, 'one', '', { images })
  const second = await inbox.submit(peer, 'two', '', { images })
  const uncertain = await inbox.submit(scope, 'three', '', { images: [gif('pending evidence')] })
  assert.equal((await readdir(attachments)).length, 2)
  assert.equal(await inbox.cancel(scope, first.id), true)
  assert.equal((await readdir(attachments)).length, 2)
  const attemptId = randomUUID()
  assert.equal((await inbox.claim(peer, attemptId))?.id, second.id)
  assert.equal(await inbox.settle(peer, second.id, attemptId, 'succeeded'), true)
  assert.equal(await inbox.settle(peer, second.id, attemptId, 'succeeded'), true)
  assert.equal(await inbox.settle(peer, second.id, attemptId, 'failed'), false)
  assert.equal((await inbox.submit(peer, 'two', '', { images })).status, 'succeeded')
  assert.equal((await inbox.submit(scope, 'one', '', { images })).status, 'cancelled')
  await assert.rejects(inbox.submit(peer, 'two', '', { images: [gif('different')] }), /conflict/)
  assert.deepEqual(await readdir(attachments), [`${uncertain.attachments?.[0].digest}.image`])
})

test(
  'attachment directory sync failure prevents acknowledging or publishing a snapshot',
  {
    skip: process.platform === 'win32' && 'directory sync is unavailable'
  },
  async (t) => {
    const { directory, path } = await fixture(t)
    const attachments = join(directory, 'attachments')
    const inbox = createAssistantInbox(directory)
    const originalOpen = fs.open
    let syncRequested = false
    t.after(() => restoreFsMocks(t))
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === attachments) {
        syncRequested = true
        throw new Error('attachment sync failed')
      }
      return originalOpen(...args)
    })
    syncBuiltinESMExports()
    await assert.rejects(
      inbox.submit(scope, 'image', '', { images: [gif('first')] }),
      /sync failed/
    )
    assert.equal(syncRequested, true)
    await assert.rejects(readFile(path), /ENOENT/)
    restoreFsMocks(t)
    await inbox.recover()
    assert.deepEqual(await readdir(attachments), [])
  }
)

test('snapshot publication failure cleans only unpublished attachments', async (t) => {
  const { directory, path } = await fixture(t)
  const originalRename = fs.rename
  const attachments = join(directory, 'attachments')
  const inbox = createAssistantInbox(directory)
  const kept = await inbox.submit(scope, 'kept', '', { images: [gif('first')] })
  const file = `${kept.attachments?.[0].digest}.image`
  let failed = false
  t.after(() => restoreFsMocks(t))
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === path) {
      failed = true
      throw new Error('snapshot publish failed')
    }
    return originalRename(...args)
  })
  syncBuiltinESMExports()
  await assert.rejects(
    inbox.submit(scope, 'new', '', { images: [gif('second')] }),
    /Could not persist/
  )
  assert.equal(failed, true)
  restoreFsMocks(t)
  assert.deepEqual(await readdir(attachments), [file])
  assert.deepEqual(await inbox.list(scope), [kept])
})

test('recovery preserves attachments after uncertain snapshot publication and removes known orphans', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const attachments = join(directory, 'attachments')
  const images = [gif('verify')]
  const originalRename = fs.rename
  let published = false
  t.after(() => restoreFsMocks(t))
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args)
    if (args[1] === path) {
      published = true
      throw new Error('snapshot publish unconfirmed')
    }
  })
  syncBuiltinESMExports()
  await assert.rejects(inbox.submit(scope, 'uncertain', '', { images }), /Could not persist/)
  assert.equal(published, true)
  restoreFsMocks(t)
  const attachmentOrphan = `${'0'.repeat(64)}.image`
  const attachmentTemp = `.tmp.${randomUUID()}`
  const snapshotTemp = `assistant-inbox.json.tmp.${process.pid}.${randomUUID()}`
  for (const [dir, name] of [
    [attachments, attachmentOrphan],
    [attachments, attachmentTemp],
    [directory, snapshotTemp]
  ]) {
    await writeFile(join(dir, name), 'orphan bytes', { mode: 0o600 })
  }
  await writeFile(join(attachments, 'keep-this-file'), 'unrelated', { mode: 0o600 })
  const recovered = createAssistantInbox(directory)
  await recovered.recover()
  const [entry] = await recovered.list(scope)
  const attemptId = randomUUID()
  assert.equal((await recovered.claim(scope, attemptId))?.id, entry.id)
  assert.deepEqual(await recovered.loadImages(scope, entry.id, attemptId), images)
  assert.deepEqual((await readdir(attachments)).sort(), [
    `${entry.attachments?.[0].digest}.image`,
    'keep-this-file'
  ])
  await assert.rejects(readFile(join(directory, snapshotTemp)), /ENOENT/)
  assert.deepEqual(
    await recovered.submit(scope, 'uncertain', '', { images }),
    await recovered.claim(scope, attemptId)
  )
})

test('recovery leaves attachment data untouched if the snapshot cannot be verified', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const entry = await inbox.submit(scope, 'accepted', '', { images: [gif('retain')] })
  const stored = join(directory, 'attachments', `${entry.attachments?.[0].digest}.image`)
  await writeFile(path, '{truncated')
  await assert.rejects(inbox.recover(), /Invalid or inaccessible/)
  assert.equal(await readFile(stored, 'utf8'), 'GIF89aretain')
})

test('the attachment budget blocks new blobs and allows existing submissions to be cancelled', async (t) => {
  const { directory, path } = await fixture(t)
  // A metadata-only fixture reaches 256 MiB without creating large image files.
  const entries = Array.from({ length: 8 }, (_, order) => ({
    id: randomUUID(),
    requestId: String(order),
    scope,
    text: '',
    order,
    status: 'queued',
    attachments: Array.from({ length: MAX_PROMPT_IMAGES }, (_, i) => ({
      digest: (order * MAX_PROMPT_IMAGES + i).toString(16).padStart(64, '0'),
      mimeType: 'image/png',
      bytes: MAX_PROMPT_IMAGE_BYTES
    }))
  }))
  await writeFile(path, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
  const inbox = createAssistantInbox(directory)
  await assert.rejects(
    inbox.submit(scope, 'overflow', '', { images: [gif('one')] }),
    /storage is full/
  )
  assert.deepEqual(await inbox.list(scope), entries)
  assert.equal(await inbox.cancel(scope, entries[0].id), true)
  assert.equal(
    (await inbox.submit(scope, 'overflow', '', { images: [gif('one')] })).status,
    'queued'
  )
})

function injectDirectorySyncFailure(t: TestContext, directory: string): () => void {
  const originalOpen = fs.open
  let directoryOpens = 0
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === directory && ++directoryOpens > 1) {
      throw new Error('injected directory sync failure')
    }
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  return () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
}

test('concurrent submissions deduplicate by scope and retain their exact text and order', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const [first, duplicate, second, separate] = await Promise.all([
    inbox.submit(scope, 'request-1', '  first  '),
    inbox.submit(scope, 'request-1', '  first  '),
    inbox.submit(scope, 'request-2', 'second'),
    inbox.submit(peer, 'request-1', 'different scope')
  ])
  assert.deepEqual(duplicate, first)
  assert.equal(first.text, '  first  ')
  assert.notEqual(separate.id, first.id)
  assert.ok(second.order > first.order)
  await assert.rejects(inbox.submit(scope, 'request-1', 'first'))
  await assert.rejects(inbox.submit(scope, 'blank', '  '))
  const reopened = createAssistantInbox(directory)
  assert.deepEqual(await reopened.list(scope), [first, second])
  assert.deepEqual(await reopened.list(peer), [separate])
})

test('claims in order, fences each attempt and cancels only the specified queued entry', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const first = await inbox.submit(scope, '1', 'first')
  const second = await inbox.submit(scope, '2', 'second')
  const third = await inbox.submit(scope, '3', 'third')
  const separate = await inbox.submit(peer, '1', 'peer')
  const [claim, overlap, other] = await Promise.all([
    inbox.claim(scope, randomUUID()),
    inbox.claim(scope, randomUUID()),
    inbox.claim(peer, randomUUID())
  ])
  assert.ok(claim)
  assert.equal(claim.id, first.id)
  assert.equal(claim.status, 'running')
  assert.ok(claim.attemptId)
  assert.equal(overlap, null)
  assert.equal(other?.id, separate.id)
  assert.equal(await inbox.cancel(scope, first.id), false)
  assert.equal(await inbox.cancel(peer, second.id), false)
  assert.equal(await inbox.cancel(scope, second.id), true)
  assert.equal(await inbox.cancel(scope, second.id), false)
  assert.equal(await inbox.settle(peer, first.id, claim.attemptId, 'succeeded'), false)
  assert.equal(await inbox.settle(scope, first.id, randomUUID(), 'succeeded'), false)
  assert.equal(await inbox.settle(scope, first.id, claim.attemptId, 'succeeded'), true)
  assert.equal(await inbox.settle(scope, first.id, claim.attemptId, 'failed'), false)
  assert.equal(await inbox.claim(scope, claim.attemptId), null)
  const later = await inbox.claim(scope, randomUUID())
  assert.ok(later)
  assert.equal(later.id, third.id)
  assert.ok(later.attemptId)
  assert.equal(await inbox.settle(scope, third.id, later.attemptId, 'failed'), true)
  assert.deepEqual(
    (await inbox.list(scope)).map((entry) => entry.status),
    ['succeeded', 'cancelled', 'failed']
  )
  const duplicate = await inbox.submit(scope, '1', 'first')
  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.status, 'succeeded')
  assert.equal((await inbox.list(peer))[0]?.status, 'running')
})

test('deleting a conversation frees its receipts and preserves shared blobs for another chat', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const other = { conversationId: 'other', projectId: scope.projectId }
  const shared = gif('shared')
  await inbox.submit(scope, 'deleted', 'discard', { images: [shared, gif('unshared')] })
  const preserved = await inbox.submit(other, 'preserved', '', { images: [shared] })
  const directoryEntries = (): Promise<string[]> => readdir(join(directory, 'attachments'))
  assert.equal((await directoryEntries()).length, 2)
  await inbox.removeConversation(scope.conversationId)
  assert.deepEqual(await inbox.list(scope), [])
  assert.equal((await directoryEntries()).length, 1)
  const attemptId = randomUUID()
  await inbox.claim(other, attemptId)
  assert.deepEqual(await inbox.loadImages(other, preserved.id, attemptId), [shared])
})

test('receipt retention keeps recent tombstones and expires failed attachment payloads', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  const time = t.mock.method(Date, 'now', () => old)
  const images = [gif('expired failure')]
  const entry = await inbox.submit(scope, 'expired', 'old', { images })
  const attemptId = randomUUID()
  await inbox.claim(scope, attemptId)
  assert.equal(await inbox.settle(scope, entry.id, attemptId, 'failed'), true)
  time.mock.restore()
  const pending = await inbox.submit(scope, 'pending', 'newer')
  assert.deepEqual(await inbox.list(scope), [pending])
  assert.deepEqual(await readdir(join(directory, 'attachments')), [])
  const receipt = await inbox.submit(peer, 'recent', 'known text')
  await inbox.cancel(peer, receipt.id)
  const duplicate = await inbox.submit(peer, 'recent', 'known text')
  assert.equal(duplicate.id, receipt.id)
  assert.equal(duplicate.text, '')
  await assert.rejects(inbox.submit(peer, 'recent', 'different text'), /request conflict/)
})

test('after reopening, only an explicit recovery interrupts claims and preserves pending input', async (t) => {
  const { directory } = await fixture(t)
  const original = createAssistantInbox(directory)
  const first = await original.submit(scope, 'old', 'might have external effects')
  const next = await original.submit(scope, 'next', 'never executed')
  const claimed = await original.claim(scope, randomUUID())
  assert.ok(claimed?.attemptId)

  const reopened = createAssistantInbox(directory)
  assert.equal(await reopened.claim(scope, randomUUID()), null)
  await reopened.recover()
  await reopened.recover()
  assert.equal(await reopened.settle(scope, first.id, claimed.attemptId, 'succeeded'), false)
  assert.equal(await reopened.claim(scope, claimed.attemptId), null)
  assert.equal((await reopened.claim(scope, randomUUID()))?.id, next.id)
  assert.deepEqual(
    (await reopened.list(scope)).map((entry) => entry.status),
    ['interrupted', 'running']
  )
})

test('an invalid snapshot is never replaced and recovery of storage unblocks the same instance', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const corrupted = '{"version":2,"entries":["private prompt marker"]}'
  await writeFile(path, corrupted, { mode: 0o600 })
  await assert.rejects(inbox.submit(scope, 'request', 'new'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /private prompt marker/)
    return true
  })
  await assert.rejects(inbox.recover())
  assert.equal(await readFile(path, 'utf8'), corrupted)
  await writeFile(path, JSON.stringify({ version: 1, entries: [] }))
  assert.equal((await inbox.submit(scope, 'request', 'new')).status, 'queued')
})

test('duplicate receipts in a syntactically valid snapshot fail closed', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const entry = await inbox.submit(scope, 'same', 'first')
  const duplicate = { ...entry, id: randomUUID(), order: entry.order + 1 }
  const corrupted = JSON.stringify({ version: 1, entries: [entry, duplicate] })
  await writeFile(path, corrupted)
  await assert.rejects(inbox.list(scope))
  await assert.rejects(inbox.claim(scope, randomUUID()))
  assert.equal(await readFile(path, 'utf8'), corrupted)
})

test('capacity blocks new admissions while existing tasks can be claimed and settled', async (t) => {
  const { directory, path } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const first = await inbox.submit(scope, 'first', 'first')
  const entries = [
    first,
    ...Array.from({ length: 255 }, (_, index) => ({
      ...first,
      id: randomUUID(),
      requestId: `request-${index}`,
      order: index + 1
    }))
  ]
  await writeFile(path, JSON.stringify({ version: 1, entries }))
  await assert.rejects(inbox.submit(scope, 'overflow', 'one too many'), /full/)
  assert.equal((await inbox.submit(scope, 'first', 'first')).id, first.id)
  const claimed = await inbox.claim(scope, randomUUID())
  assert.ok(claimed)
  assert.equal(claimed.id, first.id)
  assert.equal(await inbox.settle(scope, first.id, claimed.attemptId, 'succeeded'), true)
  assert.equal(await inbox.cancel(scope, entries[1].id), true)
  assert.equal((await inbox.list(scope)).length, entries.length)
})

test('oversized submissions fail without retaining their text or consuming a request ID', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const text = 'private prompt marker'.repeat(256 * 1024)
  await assert.rejects(inbox.submit(scope, 'request', text), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /private prompt marker/)
    return true
  })
  assert.deepEqual(await inbox.list(scope), [])
  assert.equal((await inbox.submit(scope, 'request', 'new attempt')).text, 'new attempt')
})

test('a rejected write creates no receipt and does not poison the writer', async (t) => {
  const { directory } = await fixture(t)
  const missingDirectory = join(directory, 'missing')
  const inbox = createAssistantInbox(missingDirectory)
  await assert.rejects(inbox.submit(scope, 'request', 'prior attempt'))
  await mkdir(missingDirectory, { mode: 0o700 })
  assert.deepEqual(await inbox.list(scope), [])
  assert.equal((await inbox.submit(scope, 'request', 'new attempt')).text, 'new attempt')
})

test(
  'a failure after rename rejects the receipt until directory sync confirms the original entry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory, path } = await fixture(t)
    const inbox = createAssistantInbox(directory)
    const restore = injectDirectorySyncFailure(t, directory)
    let originalId: string
    try {
      await assert.rejects(inbox.submit(scope, 'request', 'original text'), /persist/)
      const stored = JSON.parse(await readFile(path, 'utf8')) as { entries: { id: string }[] }
      assert.ok(stored.entries[0])
      originalId = stored.entries[0].id
      await assert.rejects(inbox.submit(scope, 'request', 'original text'), /snapshot/)
    } finally {
      restore()
    }
    assert.equal((await inbox.submit(scope, 'request', 'original text')).id, originalId)
    assert.equal((await inbox.list(scope)).length, 1)
  }
)

test(
  'a claim can retry its original attempt after rename without interrupting a running peer',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory } = await fixture(t)
    const inbox = createAssistantInbox(directory)
    const queued = await inbox.submit(scope, 'request', 'first')
    await inbox.submit(scope, 'next', 'next')
    const peerEntry = await inbox.submit(peer, 'other', 'peer')
    const peerAttempt = await inbox.claim(peer, randomUUID())
    const attemptId = randomUUID()
    const restore = injectDirectorySyncFailure(t, directory)
    try {
      await assert.rejects(inbox.claim(scope, attemptId), /persist/)
      await assert.rejects(inbox.claim(scope, attemptId), /snapshot/)
    } finally {
      restore()
    }
    assert.equal(await inbox.claim(scope, randomUUID()), null)
    assert.equal(await inbox.claim(peer, attemptId), null)
    const received = await inbox.claim(scope, attemptId)
    assert.equal(received?.id, queued.id)
    assert.equal(received?.attemptId, attemptId)
    assert.equal(await inbox.settle(scope, queued.id, attemptId, 'succeeded'), true)
    assert.deepEqual(await inbox.list(peer), [peerAttempt])
    assert.equal(peerAttempt?.id, peerEntry.id)
    assert.equal((await inbox.claim(scope, randomUUID()))?.requestId, 'next')
  }
)

test(
  'the snapshot rejects linked files and group-readable permissions',
  {
    skip: process.platform === 'win32'
  },
  async (t) => {
    const { directory, path } = await fixture(t)
    const alternate = join(directory, 'alternate.json')
    const empty = JSON.stringify({ version: 1, entries: [] })
    await writeFile(alternate, empty, { mode: 0o600 })
    await symlink(alternate, path)
    const inbox = createAssistantInbox(directory)
    await assert.rejects(inbox.submit(scope, 'request', 'hidden'))
    assert.equal(await readFile(alternate, 'utf8'), empty)
    await rm(path)
    await link(alternate, path)
    await assert.rejects(inbox.list(scope))
    await rm(path)
    await writeFile(path, empty, { mode: 0o600 })
    await chmod(path, 0o640)
    await assert.rejects(inbox.list(scope))
    assert.equal(await readFile(path, 'utf8'), empty)
  }
)

test('a concurrent supplement retry is atomically bound to only one conversation and parent', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const left = await inbox.submit(scope, 'source-left', 'left')
  const right = await inbox.submit(peer, 'source-right', 'right')
  const request = randomUUID()
  const results = await Promise.allSettled([
    inbox.submit(scope, request, 'supplement', { supplementTo: left.id }),
    inbox.submit(peer, request, 'supplement', { supplementTo: right.id })
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  const only = (await inbox.snapshot()).entries.filter((entry) => entry.requestId === request)
  assert.equal(only.length, 1)
  assert.equal(only[0].supplementTo, left.id)
  assert.deepEqual(
    await inbox.submit(scope, request, 'supplement', { supplementTo: left.id }),
    only[0]
  )
  await assert.rejects(
    inbox.submit(peer, randomUUID(), 'supplement', { supplementTo: left.id }),
    /no longer receive/
  )
})

test('recovery preserves an expired successful parent while a dependent supplement is queued', async (t) => {
  const { directory } = await fixture(t)
  const inbox = createAssistantInbox(directory)
  const source = await inbox.submit(scope, 'source', 'original')
  const attempt = randomUUID()
  await inbox.claim(scope, attempt, source.id)
  await inbox.settle(scope, source.id, attempt, 'succeeded')
  const supplement = await inbox.submit(scope, 'follow-up', 'more details', {
    supplementTo: source.id
  })
  t.mock.method(Date, 'now', () => 4_000_000_000_000)
  const recovered = createAssistantInbox(directory)
  await recovered.recover()
  assert.equal((await recovered.list(scope))[0].id, source.id)
  const nextAttempt = randomUUID()
  assert.equal((await recovered.claim(scope, nextAttempt))?.id, supplement.id)
  await recovered.settle(scope, supplement.id, nextAttempt, 'succeeded')
  await recovered.submit(scope, 'new', 'elsewhere')
  assert.ok(!(await recovered.list(scope)).some((entry) => entry.id === source.id))
})
