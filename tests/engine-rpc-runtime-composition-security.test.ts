import assert from 'node:assert/strict'
import test from 'node:test'
import { access, chmod, link, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runtimeCompositionFixture } from './helpers/rpcRuntimeCompositionFixture'
import { deferred } from './helpers/rpc-initialization-wire'

test(
  'missing, corrupt, nonprivate or rebound launch configuration never adopts, starts a provider or survives cleanup',
  { timeout: 180_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const mutations: Array<[string, (path: string) => Promise<void>]> = [
      ['missing', (path) => rm(path)],
      [
        'extra key',
        async (path) => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.extra = true
          await writeFile(path, JSON.stringify(value))
        }
      ],
      [
        'same capabilities',
        async (path) => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.result.capability = value.execution.capability
          await writeFile(path, JSON.stringify(value))
        }
      ],
      [
        'wrong generation',
        async (path) => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.generation++
          await writeFile(path, JSON.stringify(value))
        }
      ],
      [
        'wrong native endpoint',
        async (path) => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.native.endpoint = 'http://127.0.0.1:1/v1/pi/stream'
          await writeFile(path, JSON.stringify(value))
        }
      ],
      ['malformed UTF8', (path) => writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]))],
      ['public mode', (path) => chmod(path, 0o644)],
      ['hardlink', (path) => link(path, join(f.f.root, 'outside-runtime-hardlink.json'))],
      [
        'symlink',
        async (path) => {
          const target = join(f.f.root, 'outside-runtime-symlink-target.json')
          await writeFile(target, await readFile(path), { mode: 0o600 })
          await rm(path)
          await symlink(target, path)
        }
      ]
    ]
    for (const [name, mutate] of mutations) {
      f.beforeLaunch((bootstrapPath) => mutate(join(dirname(bootstrapPath), 'runtime.json')))
      await assert.rejects(f.create(), name)
      assert.equal((await f.sdk.snapshot()).providerRequests.length, 0, name)
      assert.equal(f.adopted.length, 0, name)
      assert.deepEqual(await readdir(join(f.f.runtimeRoot, 'rpc-sessions')), [], name)
      assert.equal(f.f.session.closed, false, name)
    }
    await access(join(f.f.root, 'outside-runtime-hardlink.json'))
    await access(join(f.f.root, 'outside-runtime-symlink-target.json'))
  }
)

test(
  'failed desktop adoption keeps durable journal but closes only its private channel, writer, model lease and forward',
  { timeout: 45_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    let journal = ''
    let reference:
      | import('../src/main/agent/engine/rpc/session-storage/types').RemoteSessionReference
      | undefined
    await assert.rejects(
      f.create({
        adopt: async (snapshot) => {
          journal = snapshot.checkpoint.journalPath
          reference = snapshot.reference
          throw new Error('Synthetic desktop adoption failed')
        }
      })
    )
    assert.ok(journal)
    await access(journal)
    assert.deepEqual(await readdir(join(f.f.runtimeRoot, 'rpc-sessions')), [])
    assert.equal((await f.sdk.snapshot()).gateway.leases, 0)
    assert.equal((await f.sdk.snapshot()).providerRequests.length, 0)
    assert.equal(f.f.session.closed, false)
    const later = await f.create({
      action: { type: 'resume', reference: reference!, savedModel: f.ref }
    })
    assert.equal(later.isReady, true)
  }
)

test(
  'cancelled initialization does not wait for a late desktop adopter or make its attachment ready',
  { timeout: 30_000 },
  async (t) => {
    const f = await runtimeCompositionFixture()
    t.after(() => f.close())
    const entered = deferred<void>(),
      late = deferred<void>()
    const controller = new AbortController()
    let journal = ''
    const creating = f.create({
      signal: controller.signal,
      adopt: async (snapshot) => {
        journal = snapshot.checkpoint.journalPath
        entered.resolve()
        await late.promise
      }
    })
    void creating.catch(() => undefined)
    await entered.promise
    controller.abort(new Error('Synthetic cancelled adoption'))
    await assert.rejects(creating)
    assert.ok(journal)
    await access(journal)
    assert.deepEqual(await readdir(join(f.f.runtimeRoot, 'rpc-sessions')), [])
    late.resolve()
    assert.equal((await f.sdk.snapshot()).providerRequests.length, 0)
    assert.equal((await f.sdk.snapshot()).gateway.leases, 0)
  }
)
