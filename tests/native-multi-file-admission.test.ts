import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createFileWriteAdmission } from '../src/main/agent/engine/in-process/native-file-write-resources'

type AdmissionEvent = 'entered' | 'waiting' | 'settled'

interface HeldOperation {
  firstEvent: Promise<AdmissionEvent>
  entryEvent: Promise<'entered' | 'settled'>
  commonClaim: Promise<boolean | undefined>
  result: Promise<void>
  release(): void
}

interface Fixture {
  root: string
  hold(
    paths: Parameters<ReturnType<typeof createFileWriteAdmission>>[0],
    signal?: AbortSignal
  ): HeldOperation
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-multi-file-admission-')))
  const admit = createFileWriteAdmission()
  const cleanup = new AbortController()
  const operations: HeldOperation[] = []

  t.after(async () => {
    cleanup.abort()
    for (const operation of operations) operation.release()
    await Promise.allSettled(operations.map((operation) => operation.result))
    await rm(root, { recursive: true, force: true })
  })

  function hold(
    paths: Parameters<ReturnType<typeof createFileWriteAdmission>>[0],
    signal?: AbortSignal
  ): HeldOperation {
    const firstEvent = Promise.withResolvers<AdmissionEvent>()
    const entryEvent = Promise.withResolvers<'entered' | 'settled'>()
    const commonClaim = Promise.withResolvers<boolean | undefined>()
    const finish = Promise.withResolvers<void>()
    const result = admit(
      paths,
      signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal,
      (common) => {
        commonClaim.resolve(common)
        firstEvent.resolve('entered')
        entryEvent.resolve('entered')
        return finish.promise
      },
      (waiting) => {
        if (waiting) firstEvent.resolve('waiting')
      }
    )
    const settle = (): void => {
      commonClaim.resolve(undefined)
      firstEvent.resolve('settled')
      entryEvent.resolve('settled')
    }
    void result.then(settle, settle)
    const operation = {
      firstEvent: firstEvent.promise,
      entryEvent: entryEvent.promise,
      commonClaim: commonClaim.promise,
      result,
      release: finish.resolve
    }
    operations.push(operation)
    return operation
  }

  return { root, hold }
}

async function assertEntered(...operations: HeldOperation[]): Promise<void> {
  await Promise.all(
    operations.map(async ({ entryEvent }) => assert.equal(await entryEvent, 'entered'))
  )
}

const options = { timeout: 5000 }

test(
  'overlapping batches in reverse order acquire both write targets without deadlock',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    const first = hold([a, b])
    const second = hold([b, a])

    const events = await Promise.all([first.firstEvent, second.firstEvent])
    assert.deepEqual([...events].sort(), ['entered', 'waiting'])
    const [active, queued] = events[0] === 'entered' ? [first, second] : [second, first]
    active.release()
    await assertEntered(queued)
    queued.release()
    await Promise.all([first.result, second.result])
  }
)

test(
  'a batch blocks direct writers to either member and permits a disjoint batch',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    const alias = join(root, 'alias.txt')
    await writeFile(b, 'original')
    await symlink(b, alias, 'file')

    const batch = hold([a, alias])
    assert.equal(await batch.firstEvent, 'entered')
    const directA = hold(a)
    const directB = hold(b)
    const disjoint = hold([join(root, 'c.txt'), join(root, 'd.txt')])
    assert.deepEqual(
      await Promise.all([directA.firstEvent, directB.firstEvent, disjoint.firstEvent]),
      ['waiting', 'waiting', 'entered']
    )

    disjoint.release()
    await disjoint.result
    batch.release()
    await assertEntered(directA, directB)
  }
)

test(
  'an empty target set waits for active writes and excludes later writes',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const batch = hold([join(root, 'a.txt'), join(root, 'b.txt')])
    assert.equal(await batch.firstEvent, 'entered')
    const unknown = hold([])
    assert.equal(await unknown.firstEvent, 'waiting')

    batch.release()
    await assertEntered(unknown)
    const follower = hold(join(root, 'c.txt'))
    assert.equal(await follower.firstEvent, 'waiting')
    unknown.release()
    await assertEntered(follower)
  }
)

test(
  'cancelling a queued batch removes its claim to every target before execution',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    const active = hold(a)
    assert.equal(await active.firstEvent, 'entered')
    const stop = new AbortController()
    const cancelled = hold([b, a], stop.signal)
    assert.equal(await cancelled.firstEvent, 'waiting')
    const follower = hold(b)
    assert.equal(await follower.firstEvent, 'waiting')

    stop.abort()
    await assert.rejects(cancelled.result, { name: 'AbortError' })
    assert.equal(await cancelled.entryEvent, 'settled')
    await assertEntered(follower)
  }
)

test(
  'a cancelled running batch holds all targets until the operation settles',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    const stop = new AbortController()
    const active = hold([a, b], stop.signal)
    assert.equal(await active.firstEvent, 'entered')
    stop.abort()

    const directA = hold(a)
    const directB = hold(b)
    assert.deepEqual(await Promise.all([directA.firstEvent, directB.firstEvent]), [
      'waiting',
      'waiting'
    ])
    active.release()
    await assertEntered(directA, directB)
  }
)

test(
  'a queued batch reobserves both changed symlinks and releases both stale claims before retry',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const originalA = join(root, 'original-a.txt')
    const originalB = join(root, 'original-b.txt')
    const currentA = join(root, 'current-a.txt')
    const currentB = join(root, 'current-b.txt')
    const aliasA = join(root, 'alias-a.txt')
    const aliasB = join(root, 'alias-b.txt')
    await Promise.all(
      [originalA, originalB, currentA, currentB].map((path) => writeFile(path, 'original'))
    )
    await Promise.all([symlink(originalA, aliasA, 'file'), symlink(originalB, aliasB, 'file')])

    const originalHolder = hold(originalB)
    const currentHolder = hold([currentA, currentB])
    await assertEntered(originalHolder, currentHolder)
    const batch = hold([aliasA, aliasB])
    assert.equal(await batch.firstEvent, 'waiting')

    await Promise.all([rm(aliasA), rm(aliasB)])
    await Promise.all([symlink(currentA, aliasA, 'file'), symlink(currentB, aliasB, 'file')])
    const originalFollower = hold([originalA, originalB])
    assert.equal(await originalFollower.firstEvent, 'waiting')
    originalHolder.release()
    await assertEntered(originalFollower)

    // The retry must be able to enter while the original targets are still held.
    currentHolder.release()
    await assertEntered(batch)
    const directA = hold(currentA)
    const directB = hold(currentB)
    assert.deepEqual(await Promise.all([directA.firstEvent, directB.firstEvent]), [
      'waiting',
      'waiting'
    ])
    batch.release()
    await assertEntered(directA, directB)
  }
)

test(
  'unlinking a leaf symlink retains its own pathname until the batch settles',
  options,
  async (t) => {
    const { root, hold } = await fixture(t)
    const target = join(root, 'target.txt')
    const alias = join(root, 'alias.txt')
    await writeFile(target, 'target')
    await symlink(target, alias, 'file')
    const deleting = hold([{ path: alias, mustExist: true }])
    await assertEntered(deleting)
    await unlink(alias)
    const replacing = hold(alias)
    assert.equal(await replacing.firstEvent, 'waiting')
    deleting.release()
    await assertEntered(replacing)
  }
)

test('a deleted edit source is rechecked and waits for the common claim', options, async (t) => {
  const { root, hold } = await fixture(t)
  const disappearing = join(root, 'old.txt')
  const elsewhere = join(root, 'different.txt')
  await writeFile(disappearing, 'old')
  const deleting = hold(disappearing)
  const independent = hold(elsewhere)
  await assertEntered(deleting, independent)
  const waitingEdit = hold([{ path: disappearing, mustExist: true }])
  assert.equal(await waitingEdit.firstEvent, 'waiting')
  await unlink(disappearing)
  deleting.release()
  await deleting.result
  independent.release()
  await assertEntered(waitingEdit)
  assert.equal(await waitingEdit.commonClaim, true)
  waitingEdit.release()
})
