import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import {
  buildEnvironment,
  describeEnvironment,
  readyEnvironment,
  type EnvironmentDescriptor
} from '../src/main/agent/content/environment-refs'
import {
  computeEnvId,
  currentPlatform,
  ensureEnvironment,
  lockSha256,
  loadEnvironment,
  readEnvironmentIndex,
  removeTree,
  runInEnvironment,
  type EnvMetadata,
  type EnsureProgressEvent
} from '../src/main/agent/envs'
import { repairEnvironment } from '../src/main/agent/envs/doctor'
import { acquireEnvironmentLease } from '../src/main/agent/envs/leases'
import { updateEnvironmentEntry } from '../src/main/agent/envs/index-store'
import { installationSpecSha256 } from '../src/main/agent/envs/applications/artifacts'
import {
  installApplication,
  validateApplicationInstallationSource
} from '../src/main/agent/envs/applications'
import type {
  ApplicationInstallation,
  ApplicationInstallationProvider,
  JavaScriptBunInstallation
} from '../src/main/agent/envs/applications/types'

const platform = currentPlatform()
const binary = readFileSync('/usr/bin/true')
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const native: ApplicationInstallation = {
  backend: 'native',
  executable: 'native-fixture',
  artifacts: {
    [platform]: {
      url: 'https://fixtures.invalid/native-v1',
      sha256: digest(binary),
      size: binary.length,
      format: 'file'
    }
  }
}

function fixture(): {
  root: string
  source: string
  descriptor: EnvironmentDescriptor
  write: (installation: ApplicationInstallation) => void
} {
  const root = mkdtempSync(join(tmpdir(), 'phi-app-environment-'))
  const source = join(root, 'package')
  const write = (installation: ApplicationInstallation): void => {
    mkdirSync(join(source, 'locks'), { recursive: true })
    writeFileSync(
      join(source, 'environment.yml'),
      stringify({
        name: 'application',
        channels: installation.backend === 'native' ? [] : ['conda-forge'],
        dependencies: installation.backend === 'native' ? [] : ['python=3.12'],
        installation
      })
    )
    writeFileSync(join(source, 'locks', `${platform}.txt`), '@EXPLICIT\n')
  }
  write(native)
  const descriptor = describeEnvironment('./environment.yml', {
    mcpPackage: { id: 'test-connector', dir: source },
    platform
  })
  return { root, source, descriptor, write }
}

function idFor(descriptor: EnvironmentDescriptor): string {
  return computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages,
    installation: descriptor.spec.installation
  })
}

function input(
  root: string,
  descriptor: EnvironmentDescriptor
): Parameters<typeof ensureEnvironment>[0] {
  return {
    root: join(root, 'runtime'),
    scope: descriptor.scope,
    owner: descriptor.owner,
    kind: descriptor.kind,
    spec: descriptor.spec,
    lockText: descriptor.lockText,
    platform: descriptor.platform,
    sourceDir: descriptor.sourceDir
  }
}

test('descriptor captures its private source and application changes produce different environment identities', () => {
  const f = fixture()
  try {
    assert.equal(realpathSync(f.descriptor.sourceDir!), realpathSync(f.source))
    const first = idFor(f.descriptor)
    f.write({ ...native, executable: 'second-fixture' })
    const second = describeEnvironment('./environment.yml', {
      mcpPackage: { id: 'test-connector', dir: f.source },
      platform
    })
    assert.notEqual(idFor(second), first)
  } finally {
    removeTree(f.root)
  }
})

test('descriptor rejects applications on shared phi bases and native unsupported platforms before installation', () => {
  const f = fixture()
  try {
    const environmentsDir = join(f.root, 'shared')
    const base = join(environmentsDir, 'phi-python')
    mkdirSync(join(base, 'locks'), { recursive: true })
    writeFileSync(join(base, 'environment.yml'), readFileSync(join(f.source, 'environment.yml')))
    writeFileSync(join(base, 'locks', `${platform}.txt`), '@EXPLICIT\n')
    assert.throws(
      () => describeEnvironment('phi:python@1', { environmentsDir, platform }),
      /shared|private|base/i
    )
    const unsupported = platform === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
    f.write({
      backend: 'native',
      executable: 'native-fixture',
      artifacts: {
        [unsupported]: {
          url: 'https://fixtures.invalid/native-v1',
          sha256: digest(binary),
          size: binary.length,
          format: 'file'
        }
      }
    })
    assert.throws(
      () =>
        describeEnvironment('./environment.yml', {
          mcpPackage: { id: 'test-connector', dir: f.source },
          platform
        }),
      /platform|artifact/i
    )
  } finally {
    removeTree(f.root)
  }
})

test('native installation provisions and executes a real private binary without micromamba, then rebuilds offline from its owned cache', async () => {
  const f = fixture()
  const progress: EnsureProgressEvent[] = []
  let fetches = 0
  const fetcher: typeof fetch = async () => {
    fetches++
    return new Response(new Uint8Array(binary))
  }
  try {
    const handle = await buildEnvironment(join(f.root, 'runtime'), f.descriptor, {
      fetch: fetcher,
      onProgress: (event) => progress.push(event)
    })
    assert.equal(handle.envId, idFor(f.descriptor))
    assert.equal(handle.metadata.runtimeEngine, 'native')
    assert.equal(handle.metadata.micromambaVersion, undefined)
    assert.deepEqual(handle.metadata.activation, {
      set: {},
      pathPrepend: [join(handle.prefix, 'bin')]
    })
    assert.equal(
      handle.metadata.installation?.executable,
      join(handle.prefix, 'bin', 'native-fixture')
    )
    assert.equal((await runInEnvironment(handle, ['native-fixture'], { cwd: f.root })).exitCode, 0)
    assert.equal(statSync(handle.prefix).mode & 0o222, 0)
    assert.equal(
      progress.some((event) => event.phase === 'create' && event.message.includes('micromamba')),
      false
    )
    assert.equal(existsSync(join(f.root, 'runtime', 'mambarc')), false)
    const cacheRoot = join(f.root, 'runtime', 'cache', handle.envId, 'applications')
    assert.equal(existsSync(join(cacheRoot, handle.metadata.installation!.artifacts[0].key)), true)
    assert.equal(existsSync(join(f.root, 'runtime', 'artifacts')), false)
    removeTree(handle.prefix)
    const rebuilt = await buildEnvironment(join(f.root, 'runtime'), f.descriptor, {
      fetch: async () => {
        throw new Error('must reuse owned cache offline')
      }
    })
    assert.equal(rebuilt.envId, handle.envId)
    assert.equal((await runInEnvironment(rebuilt, ['native-fixture'], { cwd: f.root })).exitCode, 0)
    assert.equal(fetches, 1)
    assert.equal(
      readEnvironmentIndex(join(f.root, 'runtime')).environments[handle.envId].status,
      'ready'
    )
  } finally {
    removeTree(f.root)
  }
})

test('application provider failure removes a partial prefix, records failure, and releases the build lock for retry', async () => {
  const f = fixture()
  try {
    const install: ApplicationInstallationProvider = async (request) => {
      mkdirSync(join(request.prefix, 'bin'), { recursive: true })
      writeFileSync(join(request.prefix, 'bin', 'partial'), 'incomplete')
      throw new Error('fixture provider failed')
    }
    await assert.rejects(
      ensureEnvironment({ ...input(f.root, f.descriptor), applicationInstaller: install }),
      /fixture provider failed/
    )
    const envId = idFor(f.descriptor)
    const prefix = join(f.root, 'runtime', 'envs', envId)
    assert.equal(existsSync(prefix), false)
    assert.equal(readEnvironmentIndex(join(f.root, 'runtime')).environments[envId].status, 'failed')
    assert.throws(() => readyEnvironment(join(f.root, 'runtime'), f.descriptor), /not ready/)
    const retried = await ensureEnvironment({
      ...input(f.root, f.descriptor),
      fetch: async () => new Response(new Uint8Array(binary))
    })
    assert.equal(retried.metadata.status, 'ready')
  } finally {
    removeTree(f.root)
  }
})

function cachedPython(f: ReturnType<typeof fixture>): EnvironmentDescriptor {
  const requirements = 'fixture==1.0.0 --hash=sha256:' + 'a'.repeat(64) + '\n'
  writeFileSync(join(f.source, 'requirements.lock'), requirements)
  f.write({
    backend: 'python-uv',
    requirements: './requirements.lock',
    requirementsSha256: digest(requirements),
    executable: 'python-fixture'
  })
  const descriptor = describeEnvironment('./environment.yml', {
    mcpPackage: { id: 'test-connector', dir: f.source },
    platform
  })
  const envId = idFor(descriptor)
  const prefix = join(f.root, 'runtime', 'envs', envId)
  mkdirSync(join(prefix, '.phi'), { recursive: true })
  mkdirSync(join(prefix, 'bin'))
  const executable = join(prefix, 'bin', 'python-fixture')
  writeFileSync(executable, binary, { mode: 0o755 })
  const metadata: EnvMetadata = {
    envId,
    name: descriptor.spec.name,
    kind: 'package',
    platform,
    lockSha256: lockSha256(descriptor.lockText),
    createdAt: '2026-10-09T00:00:00.000Z',
    micromambaVersion: '2.9.0',
    activation: { set: {}, pathPrepend: [] },
    host: {},
    sourcePackages: [],
    status: 'ready',
    contractVersion: '1.4.0',
    installation: {
      backend: 'python-uv',
      executable,
      specSha256: installationSpecSha256(descriptor.spec.installation),
      artifacts: []
    }
  }
  writeFileSync(join(prefix, '.phi', 'env.json'), JSON.stringify(metadata))
  return descriptor
}

test('source asset validation precedes cached readiness and rejects tampering without reinstalling', async () => {
  const f = fixture()
  try {
    const descriptor = cachedPython(f)
    const cached = await ensureEnvironment(input(f.root, descriptor))
    assert.equal(cached.created, false)
    writeFileSync(join(f.source, 'requirements.lock'), 'tampered requirements')
    await assert.rejects(ensureEnvironment(input(f.root, descriptor)), /sha256|hash|digest/i)
    assert.throws(
      () => readyEnvironment(join(f.root, 'runtime'), descriptor),
      /sha256|hash|digest/i
    )
    assert.throws(
      () =>
        describeEnvironment('./environment.yml', {
          mcpPackage: { id: 'test-connector', dir: f.source },
          platform
        }),
      /sha256|hash|digest/i
    )
  } finally {
    removeTree(f.root)
  }
})

test('source assets cannot escape via a symlink even when their bytes match the pin', async () => {
  const f = fixture()
  try {
    const descriptor = cachedPython(f)
    const outside = join(f.root, 'outside.lock')
    writeFileSync(outside, readFileSync(join(f.source, 'requirements.lock')))
    unlinkSync(join(f.source, 'requirements.lock'))
    symlinkSync(outside, join(f.source, 'requirements.lock'))
    await assert.rejects(ensureEnvironment(input(f.root, descriptor)), /symlink|regular file/i)
  } finally {
    removeTree(f.root)
  }
})

test('ready application metadata cannot launch an outside-prefix executable or a symlink escape', async () => {
  const f = fixture()
  try {
    const descriptor = cachedPython(f)
    const prefix = join(f.root, 'runtime', 'envs', idFor(descriptor))
    const metadataPath = join(prefix, '.phi', 'env.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as EnvMetadata
    metadata.installation!.executable = '/usr/bin/true'
    writeFileSync(metadataPath, JSON.stringify(metadata))
    assert.throws(() => readyEnvironment(join(f.root, 'runtime'), descriptor), /prefix|executable/i)
    assert.throws(
      () => loadEnvironment(join(f.root, 'runtime'), idFor(descriptor)),
      /prefix|executable/i
    )
    metadata.installation!.executable = join(prefix, 'bin', 'python-fixture')
    writeFileSync(metadataPath, JSON.stringify(metadata))
    unlinkSync(metadata.installation!.executable)
    symlinkSync('/usr/bin/true', metadata.installation!.executable)
    assert.throws(() => readyEnvironment(join(f.root, 'runtime'), descriptor), /prefix|executable/i)
    assert.throws(
      () => loadEnvironment(join(f.root, 'runtime'), idFor(descriptor)),
      /prefix|executable/i
    )
  } finally {
    removeTree(f.root)
  }
})

test('application caches cannot escape the owned environment root through a symlink', async () => {
  const f = fixture()
  let fetches = 0
  try {
    const runtime = join(f.root, 'runtime')
    const outside = join(f.root, 'outside-cache')
    mkdirSync(runtime)
    mkdirSync(outside)
    symlinkSync(outside, join(runtime, 'cache'))
    await assert.rejects(
      ensureEnvironment({
        ...input(f.root, f.descriptor),
        fetch: async () => {
          fetches++
          return new Response(new Uint8Array(binary))
        }
      }),
      /cache.*symlink/i
    )
    assert.equal(fetches, 0)
    assert.equal(existsSync(join(outside, idFor(f.descriptor))), false)
  } finally {
    removeTree(f.root)
  }
})

test('a live lease prevents rebuild and forced repair from deleting a drifted prefix', async () => {
  const f = fixture()
  let release: (() => void) | undefined
  try {
    const runtime = join(f.root, 'runtime')
    const built = await ensureEnvironment({
      ...input(f.root, f.descriptor),
      fetch: async () => new Response(new Uint8Array(binary))
    })
    const lease = await acquireEnvironmentLease({ root: runtime, envId: built.envId })
    release = () => lease.release()
    const metadataPath = join(built.prefix, '.phi', 'env.json')
    chmodSync(metadataPath, 0o644)
    writeFileSync(metadataPath, JSON.stringify({ ...built.metadata, status: 'drifted' }))
    updateEnvironmentEntry(runtime, built.envId, {
      status: 'drifted',
      updatedAt: new Date().toISOString()
    })
    let installs = 0
    const applicationInstaller: ApplicationInstallationProvider = async () => {
      installs++
      throw new Error('unsafe replacement installer ran')
    }
    const request = { ...input(f.root, f.descriptor), applicationInstaller }
    await assert.rejects(ensureEnvironment(request), /lease|in use|active consumer/i)
    await assert.rejects(repairEnvironment(request), /lease|in use|active consumer/i)
    assert.equal(installs, 0)
    assert.deepEqual(readFileSync(join(built.prefix, 'bin', 'native-fixture')), binary)
    assert.equal(readEnvironmentIndex(runtime).environments[built.envId].status, 'drifted')
    lease.release()
    const repaired = await repairEnvironment({
      ...input(f.root, f.descriptor),
      fetch: async () => {
        throw new Error('repair should use verified cache')
      }
    })
    assert.equal(repaired.metadata.status, 'ready')
  } finally {
    release?.()
    removeTree(f.root)
  }
})

test('Bun JavaScript source pins validate both manifest and selected lock before cache reuse', () => {
  const f = fixture()
  try {
    const manifest = JSON.stringify({ name: 'js-fixture', version: '1.0.0' })
    const lock = '{"lockfileVersion": 1}\n'
    writeFileSync(join(f.source, 'package.json'), manifest)
    writeFileSync(join(f.source, 'bun.lock'), lock)
    const installation: JavaScriptBunInstallation = {
      backend: 'javascript-bun',
      manifest: './package.json',
      manifestSha256: digest(manifest),
      lock: './bun.lock',
      lockSha256: digest(lock),
      executable: 'js-fixture'
    }
    validateApplicationInstallationSource(installation, f.source, platform)
    writeFileSync(join(f.source, 'bun.lock'), 'tampered')
    assert.throws(
      () => validateApplicationInstallationSource(installation, f.source, platform),
      /sha256|digest|hash/i
    )
    writeFileSync(join(f.source, 'bun.lock'), lock)
    writeFileSync(join(f.source, 'package.json'), 'tampered')
    assert.throws(
      () => validateApplicationInstallationSource(installation, f.source, platform),
      /sha256|digest|hash/i
    )
  } finally {
    removeTree(f.root)
  }
})

test('JavaScript dispatcher requires prefix-managed Bun and never invokes a host installer', async () => {
  const f = fixture()
  let fetched = false
  try {
    const manifest = JSON.stringify({ name: 'js-fixture', version: '1.0.0', dependencies: {} })
    const lock = JSON.stringify({
      name: 'js-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'js-fixture', version: '1.0.0', dependencies: {} } }
    })
    writeFileSync(join(f.source, 'package.json'), manifest)
    writeFileSync(join(f.source, 'package-lock.json'), lock)
    const installation: JavaScriptBunInstallation = {
      backend: 'javascript-bun',
      manifest: './package.json',
      manifestSha256: digest(manifest),
      lock: './package-lock.json',
      lockSha256: digest(lock),
      executable: 'js-fixture'
    }
    const runtime = join(f.root, 'runtime')
    const prefix = join(runtime, 'envs', 'private-js-prefix')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    await assert.rejects(
      installApplication({
        root: runtime,
        prefix,
        sourceDir: f.source,
        platform,
        installation,
        fetch: async () => {
          fetched = true
          throw new Error('must not fetch without managed Bun')
        }
      }),
      /managed.*bun|bun.*managed/i
    )
    assert.equal(fetched, false)
    const cache = join(runtime, 'cache', 'private-js-prefix', 'applications', 'artifacts')
    assert.deepEqual(readFileSync(join(cache, `sha256-${digest(manifest)}`)), Buffer.from(manifest))
    assert.deepEqual(readFileSync(join(cache, `sha256-${digest(lock)}`)), Buffer.from(lock))
  } finally {
    removeTree(f.root)
  }
})
