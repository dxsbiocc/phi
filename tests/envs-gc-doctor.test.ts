import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  addReferrer,
  ensureMambarc,
  writeMambarc,
  checkEnvironment,
  collectGarbage,
  computeEnvId,
  currentPlatform,
  ensureEnvironment,
  parseEnvironmentSpec,
  parseLockPackage,
  readEnvironmentIndex,
  removeReferrer,
  removeTree,
  repairEnvironment,
  trimPackageCache,
  updateEnvironmentEntry,
  type EnvStatus,
  type EnvironmentSpec,
  type GarbageCollectionResult
} from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'

const DIGEST = 'ab'.repeat(32)
const DAY_MS = 24 * 60 * 60 * 1000
const LOCK = [
  '@EXPLICIT',
  'https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026.7.22-hbd8a1cb_0.conda#0f51e2391ade309db462a55611263e9c',
  ''
].join('\n')

function integrationSkipReason(): string | false {
  if (process.env.PHI_OFFLINE === '1') return 'PHI_OFFLINE=1; integration tests skipped'
  try {
    getMicromambaPath()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bundled micromamba is unavailable'
    return `${message}; integration tests skipped`
  }
}

const integrationSkip = integrationSkipReason()

async function withTemp(name: string, body: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-gc-${name}-`))
  try {
    await body(root)
  } finally {
    removeTree(root)
  }
}

function seed(root: string, envId: string, status: EnvStatus, referrers: string[] = []): string {
  const prefix = join(root, 'envs', envId)
  mkdirSync(prefix, { recursive: true })
  writeFileSync(join(prefix, 'marker.txt'), envId)
  updateEnvironmentEntry(root, envId, {
    name: 'demo',
    kind: 'base',
    platform: currentPlatform(),
    prefix,
    status,
    lockSha256: DIGEST,
    referrers,
    updatedAt: '2026-01-01T00:00:00.000Z'
  })
  return prefix
}

function writeLock(root: string, envId: string, pid: number): void {
  const file = join(root, 'state', 'locks', `${envId}.lock`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ pid, startedAt: '2020-01-01T00:00:00.000Z' }))
}

function touch(file: string, now: Date, daysAgo: number): void {
  const when = new Date(now.getTime() - daysAgo * DAY_MS)
  utimesSync(file, when, when)
}

function skipKeys(result: GarbageCollectionResult): string[] {
  return result.skipped.map((item) => `${item.envId}:${item.reason}`).sort()
}

test('parseLockPackage splits conda and tar.bz2 names from the right', () => {
  assert.deepEqual(
    parseLockPackage(
      'https://conda.anaconda.org/conda-forge/osx-arm64/python_abi-3.12-5_cp312.conda#0123456789abcdef0123456789abcdef'
    ),
    {
      name: 'python_abi',
      version: '3.12',
      build: '5_cp312',
      channel: 'conda-forge',
      subdir: 'osx-arm64'
    }
  )
  assert.deepEqual(
    parseLockPackage(
      'https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026.7.22-hbd8a1cb_0.conda#0f51e2391ade309db462a55611263e9c'
    ),
    {
      name: 'ca-certificates',
      version: '2026.7.22',
      build: 'hbd8a1cb_0',
      channel: 'conda-forge',
      subdir: 'noarch'
    }
  )
  assert.deepEqual(
    parseLockPackage(
      'https://conda.anaconda.org/conda-forge/linux-64/ca-certificates-2026.7.22-hbd8a1cb_0.tar.bz2#0f51e2391ade309db462a55611263e9c'
    ),
    {
      name: 'ca-certificates',
      version: '2026.7.22',
      build: 'hbd8a1cb_0',
      channel: 'conda-forge',
      subdir: 'linux-64'
    }
  )
  assert.deepEqual(
    parseLockPackage(
      'https://conda.anaconda.org/conda-forge/osx-arm64/libzlib-1.3.2-h8088a28_3.conda#f39288f0ea63ae962e1a2e4f355a0d75'
    ),
    {
      name: 'libzlib',
      version: '1.3.2',
      build: 'h8088a28_3',
      channel: 'conda-forge',
      subdir: 'osx-arm64'
    }
  )
  assert.deepEqual(
    parseLockPackage(
      'https://conda.anaconda.org/conda-forge/linux-64/ld_impl_linux-64-2.40-hf3520f5_7.tar.bz2#b80f2f396ca2c28b8c14c437a4ed1e74'
    ),
    {
      name: 'ld_impl_linux-64',
      version: '2.40',
      build: 'hf3520f5_7',
      channel: 'conda-forge',
      subdir: 'linux-64'
    }
  )
})

test('addReferrer and removeReferrer are idempotent and atomic', async () => {
  await withTemp('referrers', (root) => {
    removeReferrer(root, 'missing-env', 'skill:scanpy')
    assert.equal(existsSync(join(root, 'state', 'environments.json')), false)
    assert.throws(
      () => addReferrer(root, 'missing-env', 'skill:scanpy'),
      /unknown environment 'missing-env'/
    )

    const envId = 'phi-demo-0123456789ab'
    seed(root, envId, 'ready')
    addReferrer(root, envId, 'plugin:visualization@1.0.0')
    const stamped = readEnvironmentIndex(root).environments[envId].updatedAt
    assert.notEqual(stamped, '2026-01-01T00:00:00.000Z')
    addReferrer(root, envId, 'plugin:visualization@1.0.0')
    assert.equal(readEnvironmentIndex(root).environments[envId].updatedAt, stamped)
    addReferrer(root, envId, 'skill:scanpy')
    addReferrer(root, envId, 'project:alpha')
    assert.deepEqual(readEnvironmentIndex(root).environments[envId].referrers, [
      'plugin:visualization@1.0.0',
      'skill:scanpy',
      'project:alpha'
    ])
    const afterDuplicate = readEnvironmentIndex(root).environments[envId].updatedAt
    addReferrer(root, envId, 'project:alpha')
    assert.equal(readEnvironmentIndex(root).environments[envId].updatedAt, afterDuplicate)

    removeReferrer(root, envId, 'skill:scanpy')
    removeReferrer(root, envId, 'skill:scanpy')
    removeReferrer(root, envId, 'not-listed')
    removeReferrer(root, 'missing-env', 'skill:scanpy')
    assert.deepEqual(readEnvironmentIndex(root).environments[envId].referrers, [
      'plugin:visualization@1.0.0',
      'project:alpha'
    ])
    assert.equal(readEnvironmentIndex(root).environments['missing-env'], undefined)
    assert.equal(
      readdirSync(join(root, 'state')).some((name) => name.endsWith('.tmp')),
      false
    )
  })
})

test('checkEnvironment marks a missing prefix drifted and keeps referrers', async () => {
  await withTemp('doctor-missing', async (root) => {
    const envId = 'phi-demo-0123456789ab'
    const prefix = seed(root, envId, 'ready', [
      'plugin:visualization@1.0.0',
      'skill:scanpy',
      'project:alpha'
    ])
    removeTree(prefix)
    const result = await checkEnvironment(root, envId, LOCK)
    assert.equal(result.ok, false)
    assert.equal(result.envId, envId)
    assert.ok(result.problems.includes('env.json is missing'))
    const entry = readEnvironmentIndex(root).environments[envId]
    assert.equal(entry.status, 'drifted')
    assert.equal(entry.prefix, prefix)
    assert.deepEqual(entry.referrers, [
      'plugin:visualization@1.0.0',
      'skill:scanpy',
      'project:alpha'
    ])
  })
})

test('collectGarbage removes unreferenced environments, orphans, and old logs', async () => {
  await withTemp('collect', (root) => {
    const free = seed(root, 'phi-free-aaaaaaaaaaaa', 'ready')
    const kept = seed(root, 'phi-kept-bbbbbbbbbbbb', 'ready', ['plugin:visualization@1.0.0'])
    const building = seed(root, 'phi-build-cccccccccccc', 'building')
    const failed = seed(root, 'phi-fail-dddddddddddd', 'failed')
    const drifted = seed(root, 'phi-drift-eeeeeeeeeeee', 'drifted')
    const locked = seed(root, 'phi-lock-ffffffffffff', 'ready')
    const absent = seed(root, 'phi-absent-222222222222', 'absent')
    const stale = seed(root, 'phi-stale-333333333333', 'ready')
    const referencedFailure = seed(root, 'phi-reffail-444444444444', 'failed', ['project:alpha'])
    chmodSync(join(free, 'marker.txt'), 0o444)
    chmodSync(free, 0o555)

    const orphanId = 'phi-orphan-111111111111'
    const orphan = join(root, 'envs', orphanId)
    mkdirSync(orphan)
    writeFileSync(join(orphan, 'marker.txt'), 'orphan')
    chmodSync(join(orphan, 'marker.txt'), 0o444)
    chmodSync(orphan, 0o555)

    const lockedOrphanId = 'orphan-locked'
    mkdirSync(join(root, 'envs', lockedOrphanId))
    writeFileSync(join(root, 'envs', lockedOrphanId, 'marker.txt'), 'locked-orphan')
    writeLock(root, 'phi-lock-ffffffffffff', process.pid)
    writeLock(root, lockedOrphanId, process.pid)
    writeLock(root, 'phi-stale-333333333333', 2147483647)

    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep')
    symlinkSync(outside, join(root, 'envs', 'link-out'))
    writeFileSync(join(root, 'envs', 'stray.txt'), 'stray')

    const now = new Date('2026-09-29T00:00:00.000Z')
    mkdirSync(join(root, 'logs'), { recursive: true })
    mkdirSync(join(root, 'state', 'tmp'), { recursive: true })
    const oldLog = join(root, 'logs', 'old.log')
    const recentLog = join(root, 'logs', 'recent.log')
    const oldTmp = join(root, 'state', 'tmp', 'old.txt')
    const freshTmp = join(root, 'state', 'tmp', 'fresh.txt')
    writeFileSync(oldLog, 'old')
    writeFileSync(recentLog, 'recent')
    writeFileSync(oldTmp, 'old')
    writeFileSync(freshTmp, 'fresh')
    touch(oldLog, now, 31)
    touch(recentLog, now, 29)
    touch(oldTmp, now, 2)
    touch(freshTmp, now, 0.5)

    const indexFile = join(root, 'state', 'environments.json')
    const before = readFileSync(indexFile, 'utf8')
    const dry = collectGarbage(root, { dryRun: true, now })
    assert.equal(readFileSync(indexFile, 'utf8'), before)
    assert.equal(existsSync(join(free, 'marker.txt')), true)
    assert.equal(existsSync(join(orphan, 'marker.txt')), true)
    assert.equal(existsSync(oldLog), true)
    assert.equal(existsSync(oldTmp), true)
    assert.equal(lstatSync(free).mode & 0o200, 0)
    assert.deepEqual(dry.removed, [
      'phi-drift-eeeeeeeeeeee',
      'phi-fail-dddddddddddd',
      'phi-free-aaaaaaaaaaaa',
      'phi-stale-333333333333'
    ])
    assert.deepEqual(dry.orphans, [orphanId])
    assert.equal(dry.logsRemoved, 2)
    assert.deepEqual(skipKeys(dry), [
      `${lockedOrphanId}:locked`,
      'phi-build-cccccccccccc:building',
      'phi-lock-ffffffffffff:locked'
    ])

    const live = collectGarbage(root, { now })
    assert.deepEqual(live.removed, dry.removed)
    assert.deepEqual(live.orphans, dry.orphans)
    assert.equal(live.logsRemoved, dry.logsRemoved)
    assert.deepEqual(skipKeys(live), skipKeys(dry))

    assert.equal(existsSync(free), false)
    assert.equal(existsSync(failed), false)
    assert.equal(existsSync(drifted), false)
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(orphan), false)
    assert.equal(existsSync(join(kept, 'marker.txt')), true)
    assert.equal(existsSync(join(building, 'marker.txt')), true)
    assert.equal(existsSync(join(locked, 'marker.txt')), true)
    assert.equal(existsSync(join(absent, 'marker.txt')), true)
    assert.equal(existsSync(join(referencedFailure, 'marker.txt')), true)
    assert.equal(existsSync(join(root, 'envs', lockedOrphanId, 'marker.txt')), true)
    assert.equal(readFileSync(outside, 'utf8'), 'keep')
    assert.equal(lstatSync(join(root, 'envs', 'link-out')).isSymbolicLink(), true)
    assert.equal(readFileSync(join(root, 'envs', 'stray.txt'), 'utf8'), 'stray')
    assert.equal(existsSync(oldLog), false)
    assert.equal(readFileSync(recentLog, 'utf8'), 'recent')
    assert.equal(existsSync(oldTmp), false)
    assert.equal(readFileSync(freshTmp, 'utf8'), 'fresh')

    const index = readEnvironmentIndex(root)
    for (const envId of live.removed) assert.equal(index.environments[envId], undefined)
    assert.deepEqual(index.environments['phi-kept-bbbbbbbbbbbb'].referrers, [
      'plugin:visualization@1.0.0'
    ])
    assert.equal(index.environments['phi-build-cccccccccccc'].status, 'building')
    assert.equal(index.environments['phi-lock-ffffffffffff'].status, 'ready')
    assert.equal(index.environments['phi-absent-222222222222'].status, 'absent')
    assert.deepEqual(index.environments['phi-reffail-444444444444'].referrers, ['project:alpha'])
    const held = JSON.parse(
      readFileSync(join(root, 'state', 'locks', 'phi-lock-ffffffffffff.lock'), 'utf8')
    ) as { pid: number }
    assert.equal(held.pid, process.pid)
    assert.equal(existsSync(join(root, 'state', 'locks', 'phi-stale-333333333333.lock')), false)
  })
})

function loadMinimal(): { spec: EnvironmentSpec; lockText: string } {
  const platform = currentPlatform()
  const parsed = parseEnvironmentSpec(
    readFileSync(join(process.cwd(), 'tests/fixtures/envs/minimal/environment.yml'), 'utf8')
  )
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return {
    spec: parsed.spec,
    lockText: readFileSync(
      join(process.cwd(), 'tests/fixtures/envs/minimal/locks', `${platform}.txt`),
      'utf8'
    )
  }
}

describe(
  'gc and doctor integration',
  {
    ...(integrationSkip ? { skip: integrationSkip } : {}),
    concurrency: 1,
    timeout: 600_000
  },
  () => {
    let root = ''
    let ownsRoot = false
    let spec: EnvironmentSpec
    let lockText = ''
    let envId = ''
    let prefix = ''

    before(async () => {
      const fixture = loadMinimal()
      spec = fixture.spec
      lockText = fixture.lockText
      envId = computeEnvId({
        scope: 'phi',
        name: spec.name,
        platform: currentPlatform(),
        lockText,
        sourcePackages: spec.sourcePackages
      })
      const persistent = process.env.PHI_TEST_RUNTIME_ROOT
      if (persistent) {
        root = persistent
        ownsRoot = false
        mkdirSync(root, { recursive: true })
      } else {
        root = mkdtempSync(join(tmpdir(), 'phi-gc-runtime-'))
        ownsRoot = true
      }
      removeTree(join(realpathSync(root), 'envs', envId))
      const result = await ensureEnvironment({
        root,
        scope: 'phi',
        kind: 'base',
        spec,
        lockText
      })
      prefix = result.prefix
      envId = result.envId
      assert.equal(result.created, true)
    })

    after(() => {
      if (ownsRoot && root) removeTree(root)
    })

    test('checkEnvironment accepts the minimal fixture', async () => {
      const check = await checkEnvironment(root, envId, lockText)
      assert.equal(check.ok, true, check.problems.join('\n'))
      assert.deepEqual(check.problems, [])
      assert.equal(readEnvironmentIndex(root).environments[envId].status, 'ready')
      await trimPackageCache(root)
      const again = await checkEnvironment(root, envId, lockText)
      assert.equal(again.ok, true, again.problems.join('\n'))
    })

    test('a removed conda-meta record drifts and repair rebuilds it', async () => {
      const metaDir = join(prefix, 'conda-meta')
      const metaStat = lstatSync(metaDir)
      chmodSync(metaDir, (metaStat.mode & 0o777) | 0o200)
      const jsonName = readdirSync(metaDir)
        .filter((name) => name.startsWith('ca-certificates-') && name.endsWith('.json'))
        .sort()[0]
      assert.ok(jsonName, 'ca-certificates conda-meta record')
      const parsed = parseLockPackage(
        `https://conda.anaconda.org/conda-forge/noarch/${jsonName.replace(/\.json$/, '.conda')}`
      )
      unlinkSync(join(metaDir, jsonName))

      const drifted = await checkEnvironment(root, envId, lockText)
      assert.equal(drifted.ok, false)
      assert.deepEqual(
        drifted.problems.filter((problem) => problem.startsWith('missing package')),
        [`missing package ${parsed.name} ${parsed.version} ${parsed.build}`]
      )
      assert.equal(
        drifted.problems.some((problem) => problem.startsWith('extra package')),
        false
      )
      assert.equal(
        drifted.problems.some((problem) => problem.startsWith('writable file')),
        false
      )
      const entry = readEnvironmentIndex(root).environments[envId]
      assert.equal(entry.status, 'drifted')
      assert.deepEqual(entry.referrers, [])

      const repaired = await repairEnvironment({
        root,
        scope: 'phi',
        kind: 'base',
        spec,
        lockText
      })
      prefix = repaired.prefix
      assert.equal(repaired.created, true)
      assert.equal(repaired.metadata.status, 'ready')
      const healthy = await checkEnvironment(root, envId, lockText)
      assert.equal(healthy.ok, true, healthy.problems.join('\n'))
      assert.equal(readEnvironmentIndex(root).environments[envId].status, 'ready')
    })

    test('garbage collection keeps a referrer and then removes the environment', () => {
      addReferrer(root, envId, 'plugin:visualization@1.0.0')
      const kept = collectGarbage(root)
      assert.equal(kept.removed.includes(envId), false)
      assert.equal(existsSync(prefix), true)
      assert.deepEqual(readEnvironmentIndex(root).environments[envId].referrers, [
        'plugin:visualization@1.0.0'
      ])
      removeReferrer(root, envId, 'plugin:visualization@1.0.0')
      const collected = collectGarbage(root)
      assert.equal(collected.removed.includes(envId), true)
      assert.equal(existsSync(prefix), false)
      assert.equal(readEnvironmentIndex(root).environments[envId], undefined)
    })
  }
)

test('collectGarbage removes stale temp directories left by interrupted installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gc-tmpdir-'))
  try {
    const now = new Date('2026-09-29T00:00:00.000Z')
    const staleDir = join(root, 'state', 'tmp', 'praise-abc123')
    const freshDir = join(root, 'state', 'tmp', 'praise-def456')
    mkdirSync(join(staleDir, 'praise'), { recursive: true })
    mkdirSync(freshDir, { recursive: true })
    writeFileSync(join(staleDir, 'praise', 'DESCRIPTION'), 'Package: praise\n')
    chmodSync(join(staleDir, 'praise'), 0o555)
    touch(staleDir, now, 2)
    touch(freshDir, now, 0.5)

    const dry = collectGarbage(root, { dryRun: true, now })
    assert.equal(dry.logsRemoved, 1)
    assert.equal(existsSync(staleDir), true)

    const result = collectGarbage(root, { now })
    assert.equal(result.logsRemoved, 1)
    assert.equal(existsSync(staleDir), false)
    assert.equal(existsSync(freshDir), true)
  } finally {
    removeTree(root)
  }
})

test('ensureMambarc keeps an existing mambarc with mirrors', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-mambarc-'))
  try {
    const mirror = 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge'
    writeMambarc(root, { channelMirrors: { 'conda-forge': mirror } })
    ensureMambarc(root)
    assert.match(readFileSync(join(root, 'mambarc'), 'utf8'), /mirrors\.tuna/)

    const fresh = mkdtempSync(join(tmpdir(), 'phi-mambarc-fresh-'))
    try {
      ensureMambarc(fresh)
      assert.match(readFileSync(join(fresh, 'mambarc'), 'utf8'), /conda-forge/)
    } finally {
      removeTree(fresh)
    }
  } finally {
    removeTree(root)
  }
})
