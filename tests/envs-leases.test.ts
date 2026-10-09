import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ENVIRONMENT_CONTRACT_VERSION } from '../src/main/agent/envs/contract'
import { createManagedEnvironmentActions } from '../src/main/agent/environment/actions'
import { collectGarbage } from '../src/main/agent/envs/gc'
import {
  deleteEnvironmentEntry,
  readEnvironmentIndex,
  updateEnvironmentEntry
} from '../src/main/agent/envs/index-store'
import { acquireEnvironmentLease, hasLiveEnvironmentLeases } from '../src/main/agent/envs/leases'
import { tryAcquireEnvironmentLock } from '../src/main/agent/envs/lock'
import { currentPlatform } from '../src/main/agent/envs/platform'

const ENV_ID = 'phi-lease-fixture-0123456789ab'
const DIGEST = 'a'.repeat(64)

function fixture(t: TestContext): {
  root: string
  prefix: string
  cache: string
  metadata: Record<string, unknown>
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-environment-lease-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prefix = join(root, 'envs', ENV_ID)
  const cache = join(root, 'cache', ENV_ID, 'applications', 'npm')
  mkdirSync(join(prefix, '.phi'), { recursive: true })
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(prefix, 'fixture'), 'managed application')
  writeFileSync(join(cache, 'fixture'), 'owned cache')
  const metadata: Record<string, unknown> = {
    envId: ENV_ID,
    name: 'lease-fixture',
    kind: 'base',
    platform: currentPlatform(),
    lockSha256: DIGEST,
    createdAt: new Date().toISOString(),
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [join(prefix, 'bin')] },
    host: {},
    sourcePackages: [],
    status: 'ready',
    contractVersion: ENVIRONMENT_CONTRACT_VERSION
  }
  writeFileSync(join(prefix, '.phi', 'env.json'), JSON.stringify(metadata))
  updateEnvironmentEntry(root, ENV_ID, {
    name: 'lease-fixture',
    kind: 'base',
    platform: currentPlatform(),
    prefix,
    status: 'ready',
    lockSha256: DIGEST,
    referrers: []
  })
  return { root, prefix, cache, metadata }
}

test('a durable live lease protects a ready environment and all its owned cache until release', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  const record = JSON.parse(readFileSync(lease.path, 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'envId', 'pid', 'token', 'version'])
  assert.equal(record.pid, process.pid)
  assert.equal(record.envId, ENV_ID)
  assert.equal(record.token, lease.token)
  assert.equal(hasLiveEnvironmentLeases(fx.root, ENV_ID), true)
  for (const dryRun of [true, false]) {
    const result = collectGarbage(fx.root, { dryRun })
    assert.deepEqual(result.skipped, [{ envId: ENV_ID, reason: 'in-use' }])
    assert.deepEqual(result.removed, [])
    assert.equal(existsSync(fx.prefix), true)
    assert.equal(existsSync(fx.cache), true)
  }
  lease.release()
  lease.release()
  assert.equal(hasLiveEnvironmentLeases(fx.root, ENV_ID), false)
  assert.equal(existsSync(lease.path), false)
  assert.deepEqual(collectGarbage(fx.root).removed, [ENV_ID])
  assert.equal(existsSync(fx.prefix), false)
  assert.equal(existsSync(fx.cache), false)
})

test('independent consumers keep their own tokens and the last release permits collection', async (t) => {
  const fx = fixture(t)
  const first = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  const second = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  assert.notEqual(first.token, second.token)
  first.release()
  assert.deepEqual(collectGarbage(fx.root).skipped, [{ envId: ENV_ID, reason: 'in-use' }])
  second.release()
  assert.deepEqual(collectGarbage(fx.root).removed, [ENV_ID])
})

test('manual removal rejects an active lease under the environment lock', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  const actions = createManagedEnvironmentActions({
    root: fx.root,
    catalog: async () => [],
    builds: {
      start: async () => {
        throw new Error('unexpected build')
      },
      list: () => [],
      cancel: () => undefined
    }
  })
  await assert.rejects(actions.remove(ENV_ID), /会话/)
  assert.equal(existsSync(fx.prefix), true)
  assert.equal(existsSync(fx.cache), true)
  lease.release()
  assert.equal((await actions.remove(ENV_ID)).removed, true)
  assert.equal(existsSync(fx.prefix), false)
  assert.equal(existsSync(fx.cache), false)
})

test('dead-PID leases are ignored in dry runs and reclaimed under the GC lock', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID, pid: 2147483647 })
  const seen: number[] = []
  const processAlive = (pid: number): boolean => {
    seen.push(pid)
    return false
  }
  assert.deepEqual(collectGarbage(fx.root, { dryRun: true, processAlive }).removed, [ENV_ID])
  assert.equal(existsSync(lease.path), true)
  assert.deepEqual(collectGarbage(fx.root, { processAlive }).removed, [ENV_ID])
  assert.equal(existsSync(lease.path), false)
  assert.ok(seen.every((pid) => pid === 2147483647))
  lease.release()
})

test('orphan collection also preserves prefixes with active consumers', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  deleteEnvironmentEntry(fx.root, ENV_ID)
  assert.deepEqual(collectGarbage(fx.root).skipped, [{ envId: ENV_ID, reason: 'in-use' }])
  lease.release()
  assert.deepEqual(collectGarbage(fx.root).orphans, [ENV_ID])
  assert.equal(existsSync(fx.cache), false)
})

test('lease publication waits for the GC/build lock and rejects a prefix deleted while waiting', async (t) => {
  const fx = fixture(t)
  const lock = tryAcquireEnvironmentLock(fx.root, ENV_ID)!
  const pending = acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  assert.equal(hasLiveEnvironmentLeases(fx.root, ENV_ID), false)
  rmSync(fx.prefix, { recursive: true })
  deleteEnvironmentEntry(fx.root, ENV_ID)
  lock.release()
  await assert.rejects(pending, /not ready/)
})

test('GC checks again under the environment lock when a lease becomes visible after its first snapshot', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  let checks = 0
  const result = collectGarbage(fx.root, { processAlive: () => ++checks > 1 })
  assert.equal(checks, 2)
  assert.deepEqual(result.skipped, [{ envId: ENV_ID, reason: 'in-use' }])
  assert.equal(existsSync(fx.prefix), true)
  lease.release()
})

test('leases reject traversal, nonabsolute roots, symlinked prefixes and mismatched indexed state', async (t) => {
  const fx = fixture(t)
  for (const envId of ['../escape', '/outside', 'phi-fixture-0123456789ab/../../outside']) {
    await assert.rejects(acquireEnvironmentLease({ root: fx.root, envId }), /invalid.*envId/)
  }
  await assert.rejects(
    acquireEnvironmentLease({ root: './relative', envId: ENV_ID }),
    /absolute runtime root/
  )
  for (const pid of [0, -1, 1.5, 2147483648])
    await assert.rejects(
      acquireEnvironmentLease({ root: fx.root, envId: ENV_ID, pid }),
      /owner PID/
    )
  updateEnvironmentEntry(fx.root, ENV_ID, { status: 'building' })
  await assert.rejects(acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }), /ready state/)
  updateEnvironmentEntry(fx.root, ENV_ID, { status: 'ready', prefix: join(fx.root, 'outside') })
  await assert.rejects(
    acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }),
    /inside.*runtime root/
  )
  updateEnvironmentEntry(fx.root, ENV_ID, { prefix: fx.prefix })
  const outside = join(fx.root, 'outside')
  mkdirSync(outside)
  rmSync(fx.prefix, { recursive: true })
  symlinkSync(outside, fx.prefix)
  await assert.rejects(
    acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }),
    /without symlinks/
  )
})

test('leases reject unfinished or symlinked metadata and symlinked lease state directories', async (t) => {
  const fx = fixture(t)
  const metadata = join(fx.prefix, '.phi', 'env.json')
  writeFileSync(metadata, JSON.stringify({ ...fx.metadata, status: 'failed' }))
  await assert.rejects(acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }), /not ready/)
  const outside = join(fx.root, 'outside-metadata.json')
  writeFileSync(outside, JSON.stringify(fx.metadata))
  rmSync(metadata)
  symlinkSync(outside, metadata)
  await assert.rejects(
    acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }),
    /regular managed metadata/
  )
  rmSync(metadata)
  writeFileSync(metadata, JSON.stringify(fx.metadata))
  const external = join(fx.root, 'outside-state')
  mkdirSync(external)
  symlinkSync(external, join(fx.root, 'state', 'leases'))
  await assert.rejects(
    acquireEnvironmentLease({ root: fx.root, envId: ENV_ID }),
    /without symlinks/
  )
  assert.deepEqual(readEnvironmentIndex(fx.root).environments[ENV_ID].status, 'ready')
})

test('invalid and oversized records are pruned without following symlinks or checking invalid PIDs', async (t) => {
  const fx = fixture(t)
  const lease = await acquireEnvironmentLease({ root: fx.root, envId: ENV_ID })
  lease.release()
  const directory = dirname(lease.path)
  const oversized = join(directory, `${randomUUID()}.json`)
  const invalid = join(directory, `${randomUUID()}.json`)
  const symlink = join(directory, `${randomUUID()}.json`)
  const outside = join(fx.root, 'must-remain.json')
  writeFileSync(oversized, 'a'.repeat(1025))
  writeFileSync(invalid, JSON.stringify({ envId: '../escape', pid: -1 }))
  writeFileSync(outside, 'owned elsewhere')
  symlinkSync(outside, symlink)
  assert.equal(
    hasLiveEnvironmentLeases(fx.root, ENV_ID, {
      processAlive: () => {
        throw new Error('invalid records must not check PIDs')
      }
    }),
    false
  )
  assert.equal(existsSync(oversized), false)
  assert.equal(existsSync(invalid), false)
  assert.equal(existsSync(symlink), false)
  assert.equal(readFileSync(outside, 'utf8'), 'owned elsewhere')
})

test('aborted lease acquisition publishes no consumer record and releases the environment lock', async (t) => {
  const fx = fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    acquireEnvironmentLease({ root: fx.root, envId: ENV_ID, signal: controller.signal }),
    /abort/i
  )
  const lock = tryAcquireEnvironmentLock(fx.root, ENV_ID)
  assert.ok(lock)
  lock.release()
  assert.equal(hasLiveEnvironmentLeases(fx.root, ENV_ID), false)
})
