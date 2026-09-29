import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  computeEnvId,
  createSourcePackageInstaller,
  currentPlatform,
  ensureEnvironment,
  ensureRuntimeLayout,
  fetchSourceArchive,
  parseEnvironmentSpec,
  readEnvironmentIndex,
  removeTree,
  runMicromamba,
  sourceArchiveUrls,
  type EnsureEnvironmentInput,
  type EnvironmentSpec,
  type SourceArchiveDownloader,
  type SourcePackage
} from '../src/main/agent/envs'
import { requireEnvironmentCompiler } from '../src/main/agent/envs/source-packages'
import { getMicromambaPath } from '../src/main/agent/envs/paths'

const PRAISE_SHA256 = '5c035e74fd05dfa59b03afe0d5f4c53fbf34144e175e90c53d09c6baedf5debd'
const TESTIT_SHA256 = '63da38c42bd795724f4c2afc8e46f1280c60475fa22542749a77acfc4a50f2e5'
const TESTIT_REF = '48a814e3b2f069a24de8e701e2379dfe6ec96c73'

const GITHUB: SourcePackage = {
  language: 'r',
  name: 'testit',
  source: 'github',
  repo: 'yihui/testit',
  ref: TESTIT_REF,
  sha256: TESTIT_SHA256
}

const CRAN: SourcePackage = {
  language: 'r',
  name: 'praise',
  source: 'cran',
  ref: '1.0.0',
  sha256: PRAISE_SHA256
}

// Pure R (no src/), imports rprojroot, which the environment does not have.
const HERE: SourcePackage = {
  language: 'r',
  name: 'here',
  source: 'cran',
  ref: '1.0.1',
  sha256: '08ed908033420d3d665c87248b3a14d1b6e2b37844bf736be620578c20ca346b'
}

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

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

async function withTemp(name: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-src-${name}-`))
  try {
    await body(root)
  } finally {
    removeTree(root)
  }
}

function loadRSource(): { spec: EnvironmentSpec; lockText: string } {
  const platform = currentPlatform()
  const parsed = parseEnvironmentSpec(
    readFileSync(join(process.cwd(), 'tests/fixtures/envs/r-source/environment.yml'), 'utf8')
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return {
    spec: parsed.spec,
    lockText: readFileSync(
      join(process.cwd(), 'tests/fixtures/envs/r-source/locks', `${platform}.txt`),
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

test('sourceArchiveUrls builds GitHub codeload and CRAN archive URLs', () => {
  assert.deepEqual(sourceArchiveUrls(GITHUB), [
    `https://codeload.github.com/yihui/testit/tar.gz/${TESTIT_REF}`
  ])
  assert.deepEqual(sourceArchiveUrls(CRAN), [
    'https://cran.r-project.org/src/contrib/praise_1.0.0.tar.gz',
    'https://cran.r-project.org/src/contrib/Archive/praise/praise_1.0.0.tar.gz'
  ])
})

test('r-source fixture pins praise and testit', () => {
  const parsed = parseEnvironmentSpec(
    readFileSync(join(process.cwd(), 'tests/fixtures/envs/r-source/environment.yml'), 'utf8')
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  assert.deepEqual(parsed.spec.sourcePackages, [CRAN, GITHUB])
})

test('fetchSourceArchive uses a cached archive without calling the downloader', async () => {
  await withTemp('cache-hit', async (root) => {
    const body = 'cached-source-archive'
    const sha256 = digest(body)
    mkdirSync(join(root, 'sources'), { recursive: true })
    const cached = join(root, 'sources', sha256)
    writeFileSync(cached, body)
    let calls = 0
    const download: SourceArchiveDownloader = () => {
      calls += 1
      return Promise.reject(new Error('downloader should not be called'))
    }
    const pkg: SourcePackage = { ...CRAN, sha256 }
    const path = await fetchSourceArchive(root, pkg, { download })
    assert.equal(calls, 0)
    assert.equal(path, cached)
    assert.equal(readFileSync(path, 'utf8'), body)
  })
})

test('fetchSourceArchive rejects a sha256 mismatch and leaves sources empty', async () => {
  await withTemp('mismatch', async (root) => {
    const body = 'not-the-archive'
    const actual = digest(body)
    const pkg: SourcePackage = { ...CRAN, sha256: 'ab'.repeat(32) }
    const urls: string[] = []
    const download: SourceArchiveDownloader = async (url, destination) => {
      urls.push(url)
      writeFileSync(destination, body)
    }
    await assert.rejects(
      () => fetchSourceArchive(root, pkg, { download }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, new RegExp(`expected ${pkg.sha256}`))
        assert.match(error.message, new RegExp(`actual ${actual}`))
        return true
      }
    )
    assert.deepEqual(urls, [sourceArchiveUrls(pkg)[0]])
    assert.deepEqual(readdirSync(join(root, 'sources')), [])
  })
})

test('fetchSourceArchive falls back to the CRAN Archive URL when the current URL fails', async () => {
  await withTemp('cran-fallback', async (root) => {
    const body = 'archived-source'
    const sha256 = digest(body)
    const pkg: SourcePackage = { ...CRAN, sha256 }
    const urls: string[] = []
    const download: SourceArchiveDownloader = async (url, destination) => {
      urls.push(url)
      if (urls.length === 1) throw new Error('HTTP 404')
      writeFileSync(destination, body)
    }
    const path = await fetchSourceArchive(root, pkg, { download })
    assert.deepEqual(urls, sourceArchiveUrls(pkg))
    assert.equal(path, join(root, 'sources', sha256))
    assert.equal(readFileSync(path, 'utf8'), body)
  })
})

test('createSourcePackageInstaller rejects a non-r language', async () => {
  await withTemp('language', async (root) => {
    const install = createSourcePackageInstaller({ root })
    const pkg = { ...CRAN, language: 'python' as 'r' }
    await assert.rejects(
      () => install(join(root, 'prefix'), [pkg]),
      /unsupported language 'python'/
    )
  })
})

describe(
  'r source package integration',
  {
    ...(integrationSkip ? { skip: integrationSkip } : {}),
    concurrency: 1
  },
  () => {
    let root = ''
    let ownsRoot = false
    let spec: EnvironmentSpec
    let lockText = ''

    before(() => {
      const fixture = loadRSource()
      spec = fixture.spec
      lockText = fixture.lockText
      const persistent = process.env.PHI_TEST_RUNTIME_ROOT
      if (persistent) {
        root = persistent
        ownsRoot = false
        mkdirSync(root, { recursive: true })
      } else {
        root = mkdtempSync(join(tmpdir(), 'phi-rsource-runtime-'))
        ownsRoot = true
      }
    })

    after(() => {
      if (ownsRoot && root) removeTree(root)
    })

    function baseInput(environment: EnvironmentSpec = spec): EnsureEnvironmentInput {
      return { root, scope: 'phi', kind: 'base', spec: environment, lockText }
    }

    test('ensureEnvironment installs pinned praise and testit', { timeout: 900_000 }, async () => {
      const envId = envIdFor(spec, lockText)
      ensureRuntimeLayout(root)
      const runtimeRoot = realpathSync(root)
      removeTree(join(runtimeRoot, 'envs', envId))
      const result = await ensureEnvironment(baseInput())

      assert.equal(result.created, true)
      assert.equal(result.envId, envId)
      assert.equal(result.metadata.status, 'ready')
      assert.deepEqual(result.metadata.sourcePackages, spec.sourcePackages)
      const onDisk = JSON.parse(readFileSync(join(result.prefix, '.phi', 'env.json'), 'utf8')) as {
        sourcePackages: SourcePackage[]
      }
      assert.deepEqual(onDisk.sourcePackages, spec.sourcePackages)

      const runtime = dirname(dirname(result.prefix))
      const praise = await runMicromamba(
        ['run', '-p', result.prefix, 'Rscript', '-e', 'library(praise); cat(praise())'],
        { root: runtime }
      )
      assert.equal(praise.code, 0, praise.stderr)
      assert.match(praise.stdout, /\S/)

      const testit = await runMicromamba(
        [
          'run',
          '-p',
          result.prefix,
          'Rscript',
          '-e',
          'library(testit); cat(as.character(packageVersion("testit")))'
        ],
        { root: runtime }
      )
      assert.equal(testit.code, 0, testit.stderr)
      assert.equal(testit.stdout.trim(), '1.1.3')

      assert.throws(
        () => writeFileSync(join(result.prefix, 'phi-write-probe.txt'), 'nope'),
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code
          return code === 'EACCES' || code === 'EPERM'
        }
      )
    })

    for (const [label, extra, pattern] of [
      [
        'a source package with a missing dependency fails and leaves no prefix',
        HERE,
        /source package here: missing dependency rprojroot \(declare it in the conda dependencies or earlier in sourcePackages\)/
      ]
    ] as const) {
      test(label, { timeout: 900_000 }, async () => {
        const broken: EnvironmentSpec = {
          ...spec,
          sourcePackages: [...(spec.sourcePackages ?? []), extra]
        }
        const envId = envIdFor(broken, lockText)
        ensureRuntimeLayout(root)
        const runtimeRoot = realpathSync(root)
        const prefix = join(runtimeRoot, 'envs', envId)
        removeTree(prefix)
        await assert.rejects(() => ensureEnvironment(baseInput(broken)), pattern)
        assert.equal(existsSync(prefix), false)
        const entry = readEnvironmentIndex(runtimeRoot).environments[envId]
        assert.equal(entry.status, 'failed')
        assert.match(entry.error ?? '', pattern)
      })
    }
  }
)

test('native code needs a compiler inside the environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-src-compiler-'))
  try {
    const prefix = join(root, 'prefix')
    const pure = join(root, 'pure')
    const native = join(root, 'native')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    mkdirSync(pure, { recursive: true })
    mkdirSync(join(native, 'src'), { recursive: true })
    writeFileSync(join(prefix, 'bin', 'R'), '')
    const pkg: SourcePackage = { ...CRAN, name: 'nativepkg' }

    assert.doesNotThrow(() => requireEnvironmentCompiler(prefix, pure, pkg))
    assert.throws(
      () => requireEnvironmentCompiler(prefix, native, pkg),
      /source package nativepkg: contains native code \(src\/\) but the environment has no compiler/
    )
    for (const compiler of [
      'clang',
      'arm64-apple-darwin20.0.0-clang',
      'x86_64-conda-linux-gnu-cc'
    ]) {
      const bin = join(root, `prefix-${compiler}`)
      mkdirSync(join(bin, 'bin'), { recursive: true })
      writeFileSync(join(bin, 'bin', compiler), '')
      assert.doesNotThrow(() => requireEnvironmentCompiler(bin, native, pkg))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
