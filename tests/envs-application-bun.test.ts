import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { installBunApplication } from '../src/main/agent/envs/applications/bun'
import { bunCachePackagePath } from '../src/main/agent/envs/applications/bun-cache'
import type {
  ApplicationInstallInput,
  JavaScriptBunInstallation
} from '../src/main/agent/envs/applications/types'
import { currentPlatform } from '../src/main/agent/envs/platform'
import { findBunExecutable } from '../src/main/agent/omp/bun-executable'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'

const PACKAGE = 'phi-published-js-fixture'
const VERSION = '1.0.0'
const BUN_VERSION = '1.3.14'
const SHA = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const SRI = (bytes: Buffer): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
type RecordValue = Record<string, unknown>

interface BunFixture {
  base: string
  root: string
  prefix: string
  sourceDir: string
  archive: Buffer
  manifest: RecordValue
  native: RecordValue
  npm: RecordValue
  nativePackages: Record<string, unknown[]>
  npmPackages: Record<string, RecordValue>
  requests: string[]
  artifacts: Map<string, Buffer>
  input(overrides?: Partial<ApplicationInstallInput>): ApplicationInstallInput
  fakeRuntime(outcome?: 'success' | 'failure' | 'missing-bin' | 'escape', version?: string): void
  realRuntime(withNode?: boolean): void
}

function fixture(
  t: TestContext,
  options: {
    format?: 'bun' | 'npm'
    version?: string
    published?: RecordValue
    typescript?: boolean
  } = {}
): BunFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'phi-bun-install-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const prefix = join(base, 'runtime', 'envs', 'staging')
  const root = join(base, 'runtime', 'cache', 'staging', 'applications')
  const sourceDir = join(base, 'signed-content')
  mkdirSync(root, { recursive: true })
  mkdirSync(sourceDir)
  const version = options.version ?? VERSION
  const bin = options.typescript ? 'bin/cli.ts' : 'bin/cli.cjs'
  const published = { name: PACKAGE, version, bin: { 'fixture-mcp': bin }, ...options.published }
  const cli = `${options.typescript ? 'const output: { executable: string; args: string[] }' : 'const output'} = { executable: process.execPath, args: process.argv.slice(2) }; console.log(JSON.stringify(output))\n`
  const archive = createDeterministicTarGz([
    { path: 'package/package.json', data: Buffer.from(JSON.stringify(published)) },
    { path: `package/${bin}`, data: Buffer.from(cli), mode: 0o755 }
  ])
  const url = `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`
  const artifacts = new Map([[url, archive]])
  const manifest: RecordValue = {
    name: 'phi-bun-application',
    version: VERSION,
    private: true,
    dependencies: { [PACKAGE]: version }
  }
  const nativePackages: Record<string, unknown[]> = {
    [PACKAGE]: [`${PACKAGE}@${version}`, '', { bin: { 'fixture-mcp': bin } }, SRI(archive)]
  }
  const native: RecordValue = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: { '': { name: manifest.name, dependencies: manifest.dependencies } },
    packages: nativePackages
  }
  const npmPackages: Record<string, RecordValue> = {
    '': { name: manifest.name, version: VERSION, dependencies: manifest.dependencies },
    [`node_modules/${PACKAGE}`]: {
      version,
      resolved: url,
      integrity: SRI(archive),
      bin: { 'fixture-mcp': bin }
    }
  }
  const npm: RecordValue = {
    name: manifest.name,
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: npmPackages
  }
  const requests: string[] = []
  const fetch: typeof globalThis.fetch = async (requested) => {
    const request = String(requested)
    requests.push(request)
    const bytes = artifacts.get(request)
    assert.ok(bytes, `unexpected artifact ${request}`)
    return new Response(new Uint8Array(bytes))
  }
  function input(overrides: Partial<ApplicationInstallInput> = {}): ApplicationInstallInput {
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const file = options.format === 'npm' ? './package-lock.json' : './bun.lock'
    const bytes = Buffer.from(JSON.stringify(options.format === 'npm' ? npm : native))
    writeFileSync(join(sourceDir, 'package.json'), manifestBytes)
    writeFileSync(join(sourceDir, file.slice(2)), bytes)
    const installation: JavaScriptBunInstallation = {
      backend: 'javascript-bun',
      manifest: './package.json',
      manifestSha256: SHA(manifestBytes),
      lock: file,
      lockSha256: SHA(bytes),
      executable: 'fixture-mcp'
    }
    return {
      root,
      prefix,
      sourceDir,
      platform: currentPlatform(),
      installation,
      fetch,
      ...overrides
    }
  }
  function fakeRuntime(
    outcome: 'success' | 'failure' | 'missing-bin' | 'escape' = 'success',
    bunVersion = BUN_VERSION
  ): void {
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    const app = join(prefix, 'application', 'javascript')
    const packageRoot = join(app, 'node_modules', PACKAGE)
    const bins = join(app, 'node_modules', '.bin')
    const create =
      outcome === 'success' || outcome === 'escape'
        ? `/bin/mkdir -p ${quote(join(packageRoot, 'bin'))} ${quote(bins)}\nprintf '%s\\n' ${quote(JSON.stringify({ name: PACKAGE, version }))} > ${quote(join(packageRoot, 'package.json'))}\nprintf '%s\\n' 'console.log("fixture")' > ${quote(join(packageRoot, bin))}\n/bin/ln -s ${quote(outcome === 'escape' ? join(base, 'outside.cjs') : `../${PACKAGE}/${bin}`)} ${quote(join(bins, 'fixture-mcp'))}\n`
        : ''
    if (outcome === 'escape') writeFileSync(join(base, 'outside.cjs'), 'console.log("outside")')
    writeFileSync(
      join(prefix, 'bin', 'bun'),
      `#!/bin/sh\nif [ "$1" = '--version' ]; then printf '%s\\n' ${quote(bunVersion)}; exit 0; fi\nprintf '%s\\n' "$@" > ${quote(join(prefix, 'args'))}\n/usr/bin/env > ${quote(join(prefix, 'env'))}\nprintf yes > ${quote(join(prefix, 'invoked'))}\n${create}${outcome === 'failure' ? 'printf failure >&2\nexit 17' : 'exit 0'}\n`,
      { mode: 0o755 }
    )
  }
  function realRuntime(withNode = false): void {
    const bun = findBunExecutable()
    assert.ok(bun, 'real fixture requires the local Bun engine')
    assert.equal(
      execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(),
      BUN_VERSION,
      'cache ABI fixture requires the pinned Bun 1.3.14'
    )
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    copyFileSync(bun, join(prefix, 'bin', 'bun'))
    chmodSync(join(prefix, 'bin', 'bun'), 0o755)
    if (withNode) {
      copyFileSync(process.execPath, join(prefix, 'bin', 'node'))
      chmodSync(join(prefix, 'bin', 'node'), 0o755)
    }
  }
  return {
    base,
    root,
    prefix,
    sourceDir,
    archive,
    manifest,
    native,
    npm,
    nativePackages,
    npmPackages,
    requests,
    artifacts,
    input,
    fakeRuntime,
    realRuntime
  }
}

test('Bun installs only a verified full closure with frozen inputs and isolated network-blocked configuration', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime()
  const previous = process.env.BUN_OPTIONS
  process.env.BUN_OPTIONS = '--preload=/host-only-invalid.js'
  t.after(() => {
    if (previous === undefined) delete process.env.BUN_OPTIONS
    else process.env.BUN_OPTIONS = previous
  })
  const progress: string[] = []
  const input = fx.input({ onProgress: (event) => progress.push(event.phase) })
  const signed = readFileSync(join(fx.sourceDir, 'bun.lock'))
  const result = await installBunApplication(input)
  assert.equal(result.backend, 'javascript-bun')
  assert.deepEqual(result.installer, { name: 'bun', version: BUN_VERSION })
  assert.deepEqual(result.packages, [{ name: PACKAGE, version: VERSION }])
  assert.equal(result.artifacts[0].sha256, SHA(fx.archive))
  const args = readFileSync(join(fx.prefix, 'args'), 'utf8').trim().split('\n')
  assert.deepEqual(args.slice(0, 6), [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--production',
    '--backend=copyfile',
    '--linker=hoisted'
  ])
  assert.equal(args.includes('--offline'), false)
  assert.equal(args.includes('npm'), false)
  const env = Object.fromEntries(
    readFileSync(join(fx.prefix, 'env'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
  assert.equal(env.PATH, join(fx.prefix, 'bin'))
  assert.equal(env.HOME, join(fx.root, 'bun', 'home'))
  assert.equal(env.BUN_INSTALL_CACHE_DIR, join(fx.root, 'bun', 'cache'))
  assert.equal(env.BUN_OPTIONS, undefined)
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9')
  assert.equal(env.NO_PROXY, '')
  assert.deepEqual(readFileSync(join(fx.sourceDir, 'bun.lock')), signed)
  assert.deepEqual(readFileSync(join(fx.prefix, 'application', 'javascript', 'bun.lock')), signed)
  assert.deepEqual(progress, ['application-fetch', 'application-install', 'application-verify'])
  assert.match(readFileSync(result.executable, 'utf8'), /exec "\$bin\/bun" --no-install/)
})

test('Bun requires managed Bun, and managed Node only when the package explicitly selects Node', async (t) => {
  const fx = fixture(t)
  await assert.rejects(installBunApplication(fx.input()), /managed bun runtime is missing/)
  fx.fakeRuntime()
  const input = fx.input()
  if (input.installation.backend === 'javascript-bun') input.installation.runtime = 'node'
  await assert.rejects(installBunApplication(input), /managed node runtime is missing/)
  symlinkSync(process.execPath, join(fx.prefix, 'bin', 'node'))
  await assert.rejects(installBunApplication(input), /managed node runtime is missing/)
  assert.equal(fx.requests.length, 0)
})

test('Bun rejects unknown runtime cache ABIs before acquisition and records no installation', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime('success', '1.4.2')
  await assert.rejects(installBunApplication(fx.input()), /offline cache ABI is unsupported/)
  assert.equal(fx.requests.length, 0)
  assert.equal(existsSync(join(fx.prefix, 'invoked')), false)
})

test('Bun verifies source assets before any installation and rejects symlink/traversal assets', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime()
  const input = fx.input()
  writeFileSync(join(fx.sourceDir, 'bun.lock'), '{}')
  await assert.rejects(installBunApplication(input), /sha256 mismatch/)
  const next = fx.input()
  renameSync(join(fx.sourceDir, 'bun.lock'), join(fx.base, 'outside.lock'))
  symlinkSync(join(fx.base, 'outside.lock'), join(fx.sourceDir, 'bun.lock'))
  await assert.rejects(installBunApplication(next), /without symlinks/)
  Object.assign(next.installation, { lock: '../outside.lock' })
  await assert.rejects(installBunApplication(next), /unsafe application asset path/)
  assert.equal(existsSync(join(fx.prefix, 'invoked')), false)
})

for (const url of [
  'git+https://github.com/example/repo.git#main',
  'file:../outside.tgz',
  'https://user:pass@registry.npmjs.org/test.tgz',
  'https://github.com/example/repo/archive/main.tar.gz',
  'https://git.example.org/example/repo/archive/main.tar.gz',
  'https://registry.npmjs.org/test.tgz#main'
]) {
  test(`Bun rejects non-registry or mutable lock resolution ${url}`, async (t) => {
    const fx = fixture(t)
    fx.fakeRuntime()
    fx.nativePackages[PACKAGE][1] = url
    await assert.rejects(installBunApplication(fx.input()), /pinned HTTPS registry tarball/)
    assert.equal(fx.requests.length, 0)
  })
}

test('native Bun locks require exact versions, hashes, safe keys and a complete dependency tree', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime()
  fx.nativePackages['../../escape'] = fx.nativePackages[PACKAGE]
  await assert.rejects(installBunApplication(fx.input()), /unsafe lock package path/)
  delete fx.nativePackages['../../escape']
  fx.nativePackages[PACKAGE][3] = 'sha512-invalid'
  await assert.rejects(installBunApplication(fx.input()), /sha512 integrity/)
  fx.nativePackages[PACKAGE][3] = SRI(fx.archive)
  fx.nativePackages[PACKAGE][0] = `${PACKAGE}@^1.0.0`
  await assert.rejects(installBunApplication(fx.input()), /exact version/)
  fx.nativePackages[PACKAGE][0] = `${PACKAGE}@${VERSION}`
  fx.nativePackages[PACKAGE][2] = { dependencies: { missing: '^2.0.0' } }
  await assert.rejects(
    installBunApplication(fx.input()),
    /incomplete or inconsistent lock dependency/
  )
  assert.equal(existsSync(join(fx.prefix, 'invoked')), false)
})

test('Bun validates every tarball integrity/name/version and refuses lifecycle/native builds before installation', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime()
  await assert.rejects(
    installBunApplication(fx.input({ fetch: async () => new Response('tampered') })),
    /sha512 mismatch/
  )
  for (const published of [
    { scripts: { postinstall: 'touch /tmp/never-run' } },
    { gypfile: true },
    { bin: { 'fixture-mcp': '../../outside.cjs' } },
    { version: '9.0.0' }
  ]) {
    const bad = fixture(t, { published })
    bad.fakeRuntime()
    await assert.rejects(
      installBunApplication(bad.input()),
      /unsupported lifecycle scripts\/native builds|unsafe executable path|name\/version does not match/
    )
    assert.equal(existsSync(join(bad.prefix, 'invoked')), false)
  }
})

test('Bun propagates failure and rejects unsafe or missing installed executables', async (t) => {
  for (const outcome of ['failure', 'missing-bin', 'escape'] as const) {
    const fx = fixture(t)
    fx.fakeRuntime(outcome)
    await assert.rejects(
      installBunApplication(fx.input()),
      outcome === 'failure' ? /frozen install failed/ : /executable .* missing, unsafe/
    )
    assert.equal(existsSync(join(fx.prefix, 'bin', 'fixture-mcp')), false)
  }
})

test('Bun rejects runtime shadowing and respects cancellation without a downloader', async (t) => {
  const fx = fixture(t)
  fx.fakeRuntime()
  const input = fx.input()
  Object.assign(input.installation, { executable: 'bun' })
  await assert.rejects(installBunApplication(input), /cannot shadow/)
  const signal = AbortSignal.abort()
  await assert.rejects(installBunApplication(fx.input({ signal })), /abort/i)
  assert.equal(fx.requests.length, 0)
})

for (const format of ['bun', 'npm'] as const) {
  for (const runtime of ['bun', 'node'] as const) {
    test(`real managed Bun installs ${format} lock fully offline and launches with declared ${runtime}`, async (t) => {
      const fx = fixture(t, { format })
      fx.realRuntime(runtime === 'node')
      const input = fx.input()
      Object.assign(input.installation, { runtime })
      const signedLock = readFileSync(
        join(fx.sourceDir, format === 'bun' ? 'bun.lock' : 'package-lock.json')
      )
      const result = await installBunApplication(input)
      const ready = join(dirname(fx.prefix), 'ready')
      renameSync(fx.prefix, ready)
      const actual = JSON.parse(
        execFileSync(join(ready, 'bin', 'fixture-mcp'), ['serve', '--stdio'], {
          encoding: 'utf8',
          env: {
            PATH: '/no-host-runtime',
            HTTP_PROXY: 'http://127.0.0.1:9',
            HTTPS_PROXY: 'http://127.0.0.1:9',
            NO_PROXY: ''
          }
        })
      )
      assert.equal(actual.executable, join(ready, 'bin', runtime))
      assert.deepEqual(actual.args, ['serve', '--stdio'])
      assert.equal(result.installer?.version, BUN_VERSION)
      assert.equal(result.artifacts[0].sha256, SHA(fx.archive))
      assert.deepEqual(
        readFileSync(join(fx.sourceDir, format === 'bun' ? 'bun.lock' : 'package-lock.json')),
        signedLock
      )
      assert.equal(existsSync(join(ready, 'bin', 'npm')), false)
    })
  }
}

test('Bun executes a published TypeScript entry without a build or an automatic install', async (t) => {
  const fx = fixture(t, { typescript: true })
  fx.realRuntime()
  const result = await installBunApplication(fx.input())
  const actual = JSON.parse(
    execFileSync(result.executable, ['serve'], {
      encoding: 'utf8',
      env: { PATH: '/no-host-runtime' }
    })
  )
  assert.equal(actual.executable, join(fx.prefix, 'bin', 'bun'))
  assert.deepEqual(actual.args, ['serve'])
})

test('Bun supports its pinned cache ABI for exact prerelease and build versions', async (t) => {
  const version = '1.0.0-beta.1+build.2'
  assert.equal(
    bunCachePackagePath(PACKAGE, version, BUN_VERSION),
    `${PACKAGE}@1.0.0-c0734e9369ab610d+9FABA5F07D0401CB@@@1`
  )
  const fx = fixture(t, { version })
  fx.realRuntime()
  const result = await installBunApplication(fx.input())
  assert.deepEqual(result.packages, [{ name: PACKAGE, version }])
})

test('real Bun hashes the transitive closure and omits locked dev packages offline', async (t) => {
  const dependency = 'phi-dependency-fixture'
  const dev = 'phi-dev-fixture'
  const fx = fixture(t, { published: { dependencies: { [dependency]: '^2.0.0' } } })
  fx.realRuntime()
  const runtimeMetadata = fx.nativePackages[PACKAGE][2] as RecordValue
  runtimeMetadata.dependencies = { [dependency]: '^2.0.0' }
  fx.manifest.devDependencies = { [dev]: VERSION }
  const root = (fx.native.workspaces as Record<string, RecordValue>)['']
  root.devDependencies = fx.manifest.devDependencies
  for (const [name, version] of [
    [dependency, '2.0.0'],
    [dev, VERSION]
  ]) {
    const archive = createDeterministicTarGz([
      { path: 'package/package.json', data: Buffer.from(JSON.stringify({ name, version })) },
      { path: 'package/index.js', data: Buffer.from('module.exports = "fixture"') }
    ])
    fx.artifacts.set(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, archive)
    fx.nativePackages[name] = [`${name}@${version}`, '', {}, SRI(archive)]
  }
  const result = await installBunApplication(fx.input())
  assert.equal(result.artifacts.length, 3)
  assert.equal(fx.requests.length, 3)
  assert.deepEqual(result.packages?.map((entry) => entry.name).sort(), [PACKAGE, dependency].sort())
  assert.equal(existsSync(join(fx.prefix, 'application', 'javascript', 'node_modules', dev)), false)
})

test('Bun rehydrates corrupted extracted caches from verified artifacts with no network request', async (t) => {
  const fx = fixture(t)
  fx.realRuntime()
  const first = await installBunApplication(fx.input())
  rmSync(join(fx.prefix, 'application'), { recursive: true })
  rmSync(first.executable)
  const cached = join(
    fx.root,
    'bun',
    'cache',
    bunCachePackagePath(PACKAGE, VERSION, BUN_VERSION),
    'package.json'
  )
  writeFileSync(cached, '{"name":"tampered","version":"9.0.0"}')
  const retry = await installBunApplication(
    fx.input({
      fetch: async () => {
        throw new Error('network must remain unavailable')
      }
    })
  )
  assert.deepEqual(retry.artifacts, first.artifacts)
  assert.deepEqual(retry.packages, first.packages)
  assert.equal(fx.requests.length, 1)
})

test('native Bun JSONC comments and trailing commas keep signed lock contents unchanged', async (t) => {
  const fx = fixture(t)
  fx.realRuntime()
  const input = fx.input()
  const content = readFileSync(join(fx.sourceDir, 'bun.lock'), 'utf8').replace(/}$/, ',\n}\n')
  const bytes = Buffer.from(`// signed native lock\n${content}`)
  writeFileSync(join(fx.sourceDir, 'bun.lock'), bytes)
  Object.assign(input.installation, { lockSha256: SHA(bytes) })
  await installBunApplication(input)
  assert.deepEqual(readFileSync(join(fx.prefix, 'application', 'javascript', 'bun.lock')), bytes)
})
