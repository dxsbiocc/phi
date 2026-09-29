import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import Ajv from 'ajv'

import {
  ENVIRONMENT_CONTRACT_VERSION,
  acquireEnvironmentLock,
  computeEnvId,
  currentPlatform,
  diffActivation,
  ensureEnvironment,
  ensureRuntimeLayout,
  envMetadataSchema,
  parseEnvironmentSpec,
  probeHostRequirements,
  readEnvironmentIndex,
  removeTree,
  runMicromamba,
  updateEnvironmentEntry,
  type EnsureEnvironmentInput,
  type EnsureEnvironmentResult,
  type EnsureProgressEvent,
  type EnvironmentSpec,
  type PhiPlatform
} from '../src/main/agent/envs'
import { getMicromambaPath } from '../src/main/agent/envs/paths'

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const DIGEST = 'ab'.repeat(32)

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
  const root = mkdtempSync(join(tmpdir(), `phi-ensure-${name}-`))
  try {
    await body(root)
  } finally {
    removeTree(root)
  }
}

function entryPatch(
  root: string,
  envId: string,
  patch: Parameters<typeof updateEnvironmentEntry>[2]
): ReturnType<typeof updateEnvironmentEntry> {
  return updateEnvironmentEntry(root, envId, {
    name: 'demo',
    kind: 'base',
    platform: currentPlatform(),
    prefix: join(root, 'envs', envId),
    status: 'building',
    lockSha256: DIGEST,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  })
}

test('diffActivation keeps activation changes and drops shell noise', () => {
  const before = {
    PATH: MINIMAL_PATH,
    HOME: '/Users/me',
    LANG: 'C',
    MAMBA_ROOT_PREFIX: '/runtime',
    MAMBA_NO_BANNER: '1'
  }
  const after = {
    PATH: `/opt/env/bin:/opt/env/condabin:${MINIMAL_PATH}:/opt/extra`,
    HOME: '/Users/me',
    LANG: 'en_US.UTF-8',
    MAMBA_ROOT_PREFIX: '/other',
    MAMBA_EXE: '/micromamba',
    MAMBA_NO_BANNER: '1',
    CONDA_PREFIX: '/opt/env',
    CONDA_SHLVL: '1',
    CONDA_PROMPT_MODIFIER: '(env) ',
    CONDA_EXE: '/micromamba',
    SHLVL: '2',
    PWD: '/opt/env',
    OLDPWD: '/',
    _: '/usr/bin/env',
    PS1: '(env) ',
    JAVA_HOME: '/opt/env/lib/jvm',
    GDAL_DATA: '/opt/env/share/gdal'
  }

  const diff = diffActivation(before, after)

  assert.deepEqual(diff.pathPrepend, ['/opt/env/bin', '/opt/env/condabin'])
  assert.equal(diff.set.CONDA_PREFIX, '/opt/env')
  assert.equal(diff.set.JAVA_HOME, '/opt/env/lib/jvm')
  assert.equal(diff.set.GDAL_DATA, '/opt/env/share/gdal')
  assert.equal(diff.set.LANG, 'en_US.UTF-8')
  assert.equal(diff.set.PATH, undefined)
  assert.equal(diff.set.HOME, undefined)
  assert.equal(diff.set.SHLVL, undefined)
  assert.equal(diff.set.PWD, undefined)
  assert.equal(diff.set.OLDPWD, undefined)
  assert.equal(diff.set._, undefined)
  assert.equal(diff.set.CONDA_SHLVL, undefined)
  assert.equal(diff.set.CONDA_PROMPT_MODIFIER, undefined)
  assert.equal(diff.set.CONDA_EXE, undefined)
  assert.equal(diff.set.PS1, undefined)
  assert.equal(diff.set.MAMBA_EXE, undefined)
  assert.equal(diff.set.MAMBA_ROOT_PREFIX, undefined)
  assert.equal(diff.set.MAMBA_NO_BANNER, undefined)

  const unchanged = diffActivation(before, { ...before })
  assert.deepEqual(unchanged.pathPrepend, [])
  assert.deepEqual(unchanged.set, {})
})

test('readEnvironmentIndex returns an empty index when the file is missing', async () => {
  await withTemp('index-missing', (root) => {
    const index = readEnvironmentIndex(root)
    assert.deepEqual(index, { version: 1, environments: {} })
    assert.equal(existsSync(join(root, 'state', 'environments.json')), false)
  })
})

test('readEnvironmentIndex renames a corrupt index and returns empty', async () => {
  await withTemp('index-corrupt', (root) => {
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    const file = join(state, 'environments.json')
    writeFileSync(file, '{broken')

    const index = readEnvironmentIndex(root)

    assert.deepEqual(index, { version: 1, environments: {} })
    assert.equal(existsSync(file), false)
    const renamed = readdirSync(state).filter((name) =>
      name.startsWith('environments.json.corrupt-')
    )
    assert.equal(renamed.length, 1)
    assert.match(renamed[0], /^environments\.json\.corrupt-\d+$/)
    assert.equal(readFileSync(join(state, renamed[0]), 'utf8'), '{broken')

    writeFileSync(file, JSON.stringify({ version: 2, environments: {} }))
    assert.deepEqual(readEnvironmentIndex(root), { version: 1, environments: {} })
    const quarantined = readdirSync(state).filter((name) =>
      name.startsWith('environments.json.corrupt-')
    )
    assert.equal(quarantined.length, 2)
  })
})

test('updateEnvironmentEntry writes atomically and preserves referrers', async () => {
  await withTemp('index-update', (root) => {
    const envId = 'phi-demo-0123456789ab'
    const otherId = 'phi-other-abcdefabcdef'
    entryPatch(root, envId, {
      referrers: ['plugin:viz'],
      error: 'old failure'
    })
    entryPatch(root, otherId, { referrers: ['project:alpha'], name: 'other' })

    updateEnvironmentEntry(root, envId, {
      status: 'ready',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    const file = join(root, 'state', 'environments.json')
    const names = readdirSync(join(root, 'state'))
    assert.equal(
      names.some((name) => name.endsWith('.tmp')),
      false
    )
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      environments: Record<
        string,
        { referrers: string[]; status: string; error?: string; name: string }
      >
    }
    assert.equal(parsed.version, 1)
    assert.deepEqual(parsed.environments[envId].referrers, ['plugin:viz'])
    assert.equal(parsed.environments[envId].status, 'ready')
    assert.equal(parsed.environments[envId].error, undefined)
    assert.equal(parsed.environments[envId].name, 'demo')
    assert.deepEqual(parsed.environments[otherId].referrers, ['project:alpha'])
    assert.equal(parsed.environments[otherId].name, 'other')

    updateEnvironmentEntry(root, envId, { referrers: ['project:alpha'] })
    assert.deepEqual(readEnvironmentIndex(root).environments[envId].referrers, ['project:alpha'])
  })
})

test('probeHostRequirements checks candidates, platforms, and misses', async () => {
  await withTemp('host', (root) => {
    const executable = join(root, 'soffice')
    const inert = join(root, 'inert')
    writeFileSync(inert, 'nope', { mode: 0o644 })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    chmodSync(executable, 0o755)
    const platform = currentPlatform()
    const other: PhiPlatform = platform === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
    const result = probeHostRequirements(
      [
        { name: 'soffice', candidates: [inert, executable] },
        { name: 'ignored-tool', platforms: [other] },
        { name: 'missing-phi-tool' }
      ],
      platform
    )
    assert.equal(result.found.soffice, executable)
    assert.equal(result.found['ignored-tool'], undefined)
    assert.deepEqual(result.missing, ['missing-phi-tool'])
  })
})

test('acquireEnvironmentLock takes over a stale lock', async () => {
  await withTemp('lock-stale', async (root) => {
    const envId = 'phi-stale-0123456789ab'
    const lockPath = join(root, 'state', 'locks', `${envId}.lock`)
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: '2020-01-01T00:00:00.000Z' }))

    const started = Date.now()
    const lock = await acquireEnvironmentLock({ root, envId })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 400, `stale takeover waited ${elapsed}ms`)
    const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }
    assert.equal(held.pid, process.pid)
    lock.release()
    assert.equal(existsSync(lockPath), false)
  })
})

test(
  'acquireEnvironmentLock waits while the holder pid is alive',
  { timeout: 10_000 },
  async () => {
    await withTemp('lock-live', async (root) => {
      const envId = 'phi-live-0123456789ab'
      const lockPath = join(root, 'state', 'locks', `${envId}.lock`)
      mkdirSync(dirname(lockPath), { recursive: true })
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' })
      )
      const controller = new AbortController()
      let acquired = false
      const pending = acquireEnvironmentLock({
        root,
        envId,
        signal: controller.signal
      }).then((lock) => {
        acquired = true
        return lock
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.equal(acquired, false)
        unlinkSync(lockPath)
        const lock = await pending
        const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }
        assert.equal(held.pid, process.pid)
        lock.release()
      } finally {
        controller.abort()
        await pending.catch(() => undefined)
      }
    })
  }
)

test('removeTree deletes a read-only tree without following symlinks', async () => {
  await withTemp('rm', (root) => {
    const tree = join(root, 'tree')
    const nested = join(tree, 'nested')
    mkdirSync(nested, { recursive: true })
    const file = join(nested, 'file.txt')
    writeFileSync(file, 'x')
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep')
    chmodSync(outside, 0o444)
    const outsideMode = statSync(outside).mode
    symlinkSync(outside, join(tree, 'outside-link'))
    chmodSync(file, 0o444)
    chmodSync(nested, 0o555)
    chmodSync(tree, 0o555)

    removeTree(tree)

    assert.equal(existsSync(tree), false)
    assert.equal(readFileSync(outside, 'utf8'), 'keep')
    assert.equal(statSync(outside).mode, outsideMode)
  })
})

test('ensureEnvironment rejects an invalid lock before creating a prefix', async () => {
  await withTemp('bad-lock', async (root) => {
    await assert.rejects(
      () =>
        ensureEnvironment({
          root,
          scope: 'phi',
          kind: 'base',
          spec: { name: 'minimal', channels: ['conda-forge'], dependencies: ['python=3.12'] },
          lockText: 'not a lock\n'
        }),
      /invalid explicit lock/
    )
    assert.equal(readdirSync(join(root, 'envs')).length, 0)
    assert.equal(existsSync(join(root, 'state', 'environments.json')), false)
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

function envIdFor(environment: EnvironmentSpec, lockText: string): string {
  return computeEnvId({
    scope: 'phi',
    name: environment.name,
    platform: currentPlatform(),
    lockText,
    sourcePackages: environment.sourcePackages
  })
}

function alterPackageMd5(lockText: string): string {
  return lockText.replace(/#([0-9a-f]{32})/, (_match, md5: string) => {
    const flipped = md5[0] === '0' ? '1' : '0'
    return `#${flipped}${md5.slice(1)}`
  })
}

describe(
  'ensureEnvironment integration',
  {
    ...(integrationSkip ? { skip: integrationSkip } : {}),
    concurrency: 1
  },
  () => {
    let root = ''
    let ownsRoot = false
    let spec: EnvironmentSpec
    let lockText = ''
    let built: EnsureEnvironmentResult | undefined

    before(() => {
      const fixture = loadMinimal()
      spec = fixture.spec
      lockText = fixture.lockText
      const persistent = process.env.PHI_TEST_RUNTIME_ROOT
      if (persistent) {
        root = persistent
        ownsRoot = false
        mkdirSync(root, { recursive: true })
      } else {
        root = mkdtempSync(join(tmpdir(), 'phi-ensure-runtime-'))
        ownsRoot = true
      }
    })

    after(() => {
      if (ownsRoot && root) removeTree(root)
    })

    function baseInput(text = lockText): EnsureEnvironmentInput {
      return { root, scope: 'phi', kind: 'base', spec, lockText: text }
    }

    test('builds the minimal fixture from its explicit lock', { timeout: 600_000 }, async () => {
      const envId = envIdFor(spec, lockText)
      ensureRuntimeLayout(root)
      removeTree(join(realpathSync(root), 'envs', envId))
      const phases: string[] = []
      const result = await ensureEnvironment({
        ...baseInput(),
        onProgress: (event) => phases.push(event.phase)
      })
      built = result

      assert.equal(result.created, true)
      assert.equal(result.envId, envId)
      assert.equal(result.metadata.status, 'ready')
      assert.equal(result.metadata.contractVersion, ENVIRONMENT_CONTRACT_VERSION)
      assert.equal(existsSync(join(result.prefix, 'bin', 'python')), true)
      assert.ok(phases.includes('create'))
      assert.ok(phases.includes('activation'))
      assert.ok(phases.includes('done'))
      assert.equal(phases.includes('failed'), false)

      const metadataPath = join(result.prefix, '.phi', 'env.json')
      const onDisk = JSON.parse(readFileSync(metadataPath, 'utf8')) as unknown
      const validate = new Ajv({ allErrors: true, strict: false }).compile(envMetadataSchema)
      assert.equal(validate(onDisk), true, JSON.stringify(validate.errors))

      const python = await runMicromamba(
        ['run', '-p', result.prefix, 'python', '-c', 'import sys; print(sys.version)'],
        { root: dirname(dirname(result.prefix)) }
      )
      assert.equal(python.code, 0, python.stderr)
      assert.match(python.stdout, /3\.12/)
      assert.equal(result.metadata.activation.set.CONDA_PREFIX, result.prefix)
      assert.equal(result.metadata.activation.pathPrepend[0], join(result.prefix, 'bin'))

      // Bytecode is compiled before the prefix becomes read-only, and the temp lock copy is gone.
      const libDir = join(result.prefix, 'lib')
      const pythonLib = readdirSync(libDir).find((name) => /^python3\.\d+$/.test(name))
      assert.ok(pythonLib, 'python lib directory')
      const pipCache = join(libDir, pythonLib, 'site-packages', 'pip', '__pycache__')
      assert.ok(
        existsSync(pipCache) && readdirSync(pipCache).some((name) => name.endsWith('.pyc')),
        'pip has precompiled .pyc files'
      )
      assert.equal(
        existsSync(join(dirname(dirname(result.prefix)), 'state', 'tmp', `${envId}.lock.txt`)),
        false
      )

      const index = readEnvironmentIndex(dirname(dirname(result.prefix)))
      assert.equal(index.environments[envId].status, 'ready')
      assert.equal(index.environments[envId].error, undefined)
      assert.deepEqual(index.environments[envId].referrers, [])
      assert.equal(index.environments[envId].prefix, result.prefix)
    })

    test('a ready prefix rejects new files', () => {
      assert.ok(built)
      const prefix = built.prefix
      assert.throws(
        () => writeFileSync(join(prefix, 'phi-write-probe.txt'), 'nope'),
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code
          return code === 'EACCES' || code === 'EPERM'
        }
      )
    })

    test('a second ensureEnvironment hits the fast path', { timeout: 30_000 }, async () => {
      assert.ok(built)
      const started = Date.now()
      const again = await ensureEnvironment(baseInput())
      const elapsed = Date.now() - started
      assert.equal(again.created, false)
      assert.equal(again.envId, built.envId)
      assert.ok(elapsed < 1000, `fast path took ${elapsed}ms`)
    })

    test('concurrent ensureEnvironment calls build once', { timeout: 600_000 }, async () => {
      assert.ok(built)
      const envId = built.envId
      const runtimeRoot = dirname(dirname(built.prefix))
      const logsDir = join(runtimeRoot, 'logs')
      const beforeLogs = readdirSync(logsDir).filter((name) => name.startsWith(`${envId}-`))
      removeTree(built.prefix)
      let creates = 0
      const onProgress = (event: EnsureProgressEvent): void => {
        if (event.phase === 'create' && event.message === 'micromamba create') creates += 1
      }
      const [first, second] = await Promise.all([
        ensureEnvironment({ ...baseInput(), onProgress }),
        ensureEnvironment({ ...baseInput(), onProgress })
      ])
      assert.equal(first.envId, second.envId)
      assert.equal(first.envId, envId)
      assert.equal(creates, 1)
      const afterLogs = readdirSync(logsDir).filter((name) => name.startsWith(`${envId}-`))
      assert.equal(afterLogs.length, beforeLogs.length + 1)
      built = first
    })

    test(
      'a lock with an altered package md5 fails and leaves no prefix',
      { timeout: 600_000 },
      async () => {
        const broken = alterPackageMd5(lockText)
        const envId = envIdFor(spec, broken)
        ensureRuntimeLayout(root)
        const prefix = join(realpathSync(root), 'envs', envId)
        removeTree(prefix)
        await assert.rejects(() => ensureEnvironment(baseInput(broken)))
        assert.equal(existsSync(prefix), false)
        const entry = readEnvironmentIndex(realpathSync(root)).environments[envId]
        assert.equal(entry.status, 'failed')
        assert.equal(typeof entry.error, 'string')
        assert.ok(entry.error)
      }
    )
  }
)
