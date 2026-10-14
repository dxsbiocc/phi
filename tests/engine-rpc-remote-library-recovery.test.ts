import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteLibraryStorage } from '../src/main/agent/engine/rpc/remote-library-storage'
import { savePaperInIndex } from '../src/main/agent/library/library-store'
import type { SavedPaper } from '../src/main/agent/library/library-types'
import { rpcRemoteLibraryFixture } from './helpers/rpcRemoteLibraryFixture'

function details(value: { details?: unknown }): Record<string, unknown> {
  assert.ok(value.details && typeof value.details === 'object')
  return value.details as Record<string, unknown>
}

test(
  'projection failure after atomic index commit reopens from authoritative index without replay or extra revision',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    let fail = true
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (fail && path.endsWith('/meta.json'))
        throw new Error('injected projection transport failure')
      return original(path, content, options)
    }
    const attempted = await f.call('lib.save', {
      title: 'Committed exactly once',
      notes: 'durable notes'
    })
    assert.equal(attempted.isError, true)
    const base = join(f.server.projectRoot, '.phi/library')
    const index = JSON.parse(readFileSync(join(base, 'index.json'), 'utf8')) as {
      papers: SavedPaper[]
    }
    assert.equal(index.papers[0].revision, 1)
    assert.equal(existsSync(join(base, '.projection-pending.json')), true)
    fail = false
    const listed = await f.call('lib.list')
    assert.equal(listed.isError, undefined, JSON.stringify(listed))
    assert.deepEqual(details(listed).papers, index.papers)
    assert.equal(existsSync(join(base, '.projection-pending.json')), false)
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(base, 'papers', index.papers[0].storageKey, 'meta.json'), 'utf8')
      ),
      index.papers[0]
    )
    assert.equal((await new RemoteLibraryStorage(f.target).read()).papers[0].revision, 1)
  }
)

test(
  'failed index publication recovers its projection marker against the unchanged committed index',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    let fail = true
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (fail && path.endsWith('/index.json')) throw new Error('injected index transport failure')
      return original(path, content, options)
    }
    assert.equal(
      (await f.call('lib.save', { title: 'Must not become a phantom committed paper' })).isError,
      true
    )
    assert.equal(existsSync(join(f.server.projectRoot, '.phi/library/index.json')), false)
    fail = false
    assert.deepEqual((await new RemoteLibraryStorage(f.target).read()).papers, [])
    const saved = await f.call('lib.save', { title: 'New real commit' })
    assert.equal(saved.isError, undefined, JSON.stringify(saved))
    assert.equal((details(saved).paper as SavedPaper).revision, 1)
  }
)

test(
  'concurrent independent clients serialize unique saves and exact duplicates with no lost index updates',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        f.call('lib.save', { title: `Parallel paper ${index}`, notes: `note ${index}` })
      )
    )
    assert.ok(
      results.every((result) => result.isError !== true),
      JSON.stringify(results)
    )
    const snapshot = await new RemoteLibraryStorage(f.target).read()
    assert.equal(snapshot.papers.length, 4)
    const merged = await Promise.all(
      Array.from({ length: 3 }, () => f.call('lib.save', { title: 'Parallel paper 0' }))
    )
    assert.ok(
      merged.every((result) => result.isError !== true),
      JSON.stringify(merged)
    )
    const reopened = await new RemoteLibraryStorage(f.target).read()
    assert.equal(reopened.papers.length, 4)
    assert.equal(reopened.papers.find((paper) => paper.title === 'Parallel paper 0')?.revision, 4)
  }
)

test(
  'abort while queued has no index effect and cannot let a later writer bypass the active predecessor',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (!held && path.endsWith('/index.json')) {
        held = true
        entered()
        await gate
      }
      return original(path, content, options)
    }
    const first = f.call('lib.save', { title: 'First held writer' })
    await blocked
    const abort = new AbortController()
    const second = f.call('lib.save', { title: 'Cancelled queued writer' }, abort.signal)
    const rejected = assert.rejects(second, /cancel queued/)
    await new Promise((resolve) => setTimeout(resolve, 40))
    abort.abort(new Error('cancel queued'))
    await rejected
    let completed = false
    const third = f.call('lib.save', { title: 'Third legitimate writer' }).then((value) => {
      completed = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(completed, false)
    release()
    assert.equal((await first).isError, undefined)
    assert.equal((await third).isError, undefined)
    assert.deepEqual(
      (await new RemoteLibraryStorage(f.target).read()).papers.map((paper) => paper.title).sort(),
      ['First held writer', 'Third legitimate writer']
    )
  }
)

test(
  'abort after commit intent waits for in-flight storage and leaves one consistent committed revision',
  { timeout: 60000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let once = false
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (!once && path.endsWith('/index.json')) {
        once = true
        entered()
        await gate
      }
      return original(path, content, options)
    }
    const controller = new AbortController()
    const storage = new RemoteLibraryStorage(f.target)
    const operation = storage.mutate((index) => {
      const change = savePaperInIndex(index, { title: 'Intent may commit after cancellation' })
      return { ...change, key: change.result.paper.storageKey }
    }, controller.signal)
    const rejected = assert.rejects(operation, /cancel after intent/)
    await started
    controller.abort(new Error('cancel after intent'))
    release()
    await rejected
    const snapshot = await storage.read()
    assert.equal(snapshot.papers.length, 1)
    assert.equal(snapshot.papers[0].revision, 1)
    const meta = join(
      f.server.projectRoot,
      '.phi/library/papers',
      snapshot.papers[0].storageKey,
      'meta.json'
    )
    assert.deepEqual(JSON.parse(readFileSync(meta, 'utf8')), snapshot.papers[0])
    assert.equal(
      existsSync(join(f.server.projectRoot, '.phi/library/.projection-pending.json')),
      false
    )
  }
)

test(
  'failed storage keeps its primary commit error when owned-channel cleanup also fails',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (path.endsWith('/index.json')) throw new Error('primary write failure')
      return original(path, content, options)
    }
    const storage = new RemoteLibraryStorage({
      ...f.target,
      openLockStdio: async (command) => {
        const channel = await f.target.openLockStdio(command)
        return {
          ...channel,
          close: async () => {
            await channel.close()
            throw new Error('secondary cleanup failure')
          }
        }
      }
    })
    await assert.rejects(
      storage.mutate((index) => {
        const change = savePaperInIndex(index, { title: 'Primary failure precedence' })
        return { ...change, key: change.result.paper.storageKey }
      }),
      (error: Error & { code?: string; cause?: unknown }) => {
        assert.equal(error.code, 'COMMIT_UNCONFIRMED')
        assert.ok(error.cause instanceof Error)
        assert.equal(error.cause.message, 'primary write failure')
        return true
      }
    )
  }
)

test(
  'service closes its operation-owned workspace on success and preserves primary failure across cleanup errors',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const { RemoteLibraryService } =
      await import('../src/main/agent/engine/rpc/remote-library-service')
    let closes = 0
    const service = new RemoteLibraryService(() => ({
      ...f.target,
      workspace: {
        ...f.target.workspace,
        close: async () => {
          closes++
        }
      }
    }))
    const request = {
      ...f.identity,
      requestId: 'owned-lease-read',
      toolCallId: 'owned-call',
      action: 'list',
      input: {}
    }
    const context = { originSessionId: f.identity.runtimeSessionId, toolCallId: 'owned-call' }
    assert.deepEqual(await service.execute(request, context), [])
    assert.equal(closes, 1)
    const broken = new RemoteLibraryService(() => ({
      ...f.target,
      workspace: {
        ...f.target.workspace,
        close: async () => {
          closes++
          throw new Error('secondary workspace cleanup')
        }
      }
    }))
    await assert.rejects(
      broken.execute(
        { ...request, requestId: 'owned-lease-update', action: 'update', input: { id: 'missing' } },
        context
      ),
      /Paper not found: missing/
    )
    assert.equal(closes, 2)
    await assert.rejects(
      broken.execute({ ...request, requestId: 'owned-lease-success' }, context),
      /workspace cleanup failed/
    )
    assert.equal(closes, 3)
  }
)

test(
  'abort during pending-marker upload never starts authoritative index publication',
  { timeout: 30000 },
  async (t) => {
    const f = rpcRemoteLibraryFixture()
    t.after(() => f.close())
    const original = f.server.workspace.projectHost.fs.writeAtomic.bind(
      f.server.workspace.projectHost.fs
    )
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let publications = 0
    f.server.workspace.projectHost.fs.writeAtomic = async (path, content, options) => {
      if (path.endsWith('/.projection-pending.json')) {
        entered()
        await gate
      }
      if (path.endsWith('/index.json')) publications++
      return original(path, content, options)
    }
    const controller = new AbortController()
    const operation = new RemoteLibraryStorage(f.target).mutate((index) => {
      const change = savePaperInIndex(index, {
        title: 'Must not commit before publication admission'
      })
      return { ...change, key: change.result.paper.storageKey }
    }, controller.signal)
    const rejected = assert.rejects(operation, /cancel during marker/)
    await started
    controller.abort(new Error('cancel during marker'))
    release()
    await rejected
    assert.equal(publications, 0)
    assert.equal(existsSync(join(f.server.projectRoot, '.phi/library/index.json')), false)
    assert.equal(
      existsSync(join(f.server.projectRoot, '.phi/library/.projection-pending.json')),
      false
    )
  }
)
