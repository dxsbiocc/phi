import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getMicromambaPath, micromambaCandidates } from '../src/main/agent/envs/paths'
import { findPlatform } from '../src/main/agent/envs/platform'
import { REMOTE_MICROMAMBA_TARGETS } from '../src/main/agent/remote-micromamba-artifact'
import {
  MICROMAMBA_PLATFORM_IDS,
  fileSha256,
  lookupMicromambaPlatform,
  phiPlatformId
} from '../scripts/runtime/fetch-micromamba.mjs'
import {
  ensureWindowsRuntimeSidecars,
  extractSidecars,
  runTar,
  lookupVcRuntime,
  runtimeTargetDir,
  sidecarProblems
} from '../scripts/runtime/windows-micromamba-runtime.mjs'
import { assertBundledWindowsSidecars } from '../scripts/build/after-pack.mjs'

const repoRoot = process.cwd()

const condaSubdirByPlatform: Record<string, string> = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-64',
  'linux-x64': 'linux-64',
  'linux-arm64': 'linux-aarch64',
  'win32-x64': 'win-64'
}

test('micromamba manifest lists bundled and on-demand remote platforms', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'runtime', 'manifest.json'), 'utf8')
  ) as {
    micromamba: {
      version: string
      platforms: Record<string, { url: string; sha256: string }>
    }
  }

  assert.equal(manifest.micromamba.version, '2.9.0-0')
  const manifestPlatformIds = [
    ...new Set([...MICROMAMBA_PLATFORM_IDS, ...REMOTE_MICROMAMBA_TARGETS])
  ]
  assert.deepEqual(Object.keys(manifest.micromamba.platforms).sort(), manifestPlatformIds.sort())

  for (const platformId of manifestPlatformIds) {
    const release = lookupMicromambaPlatform(manifest, platformId)
    const subdir = condaSubdirByPlatform[platformId]
    assert.ok(release)
    assert.equal(
      release.url,
      `https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-${subdir}`
    )
    assert.match(release.sha256, /^[0-9a-f]{64}$/)
    assert.equal(release.url.startsWith('https://'), true)
  }

  assert.ok(lookupMicromambaPlatform(manifest, 'win32-x64'))
})

test('platform ids map process.platform and process.arch', () => {
  assert.equal(phiPlatformId('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(phiPlatformId('darwin', 'x64'), 'darwin-x64')
  assert.equal(phiPlatformId('linux', 'x64'), 'linux-x64')
  assert.equal(phiPlatformId('win32', 'x64'), 'win32-x64')
  assert.equal(phiPlatformId('linux', 'arm64'), undefined)

  assert.equal(findPlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(findPlatform('darwin', 'x64'), 'darwin-x64')
  assert.equal(findPlatform('linux', 'x64'), 'linux-x64')
  assert.equal(findPlatform('win32', 'x64'), 'win32-x64')
  assert.equal(findPlatform('linux', 'arm64'), undefined)
  assert.equal(findPlatform(), phiPlatformId())
})

test('manifest lookup rejects an incomplete platform entry', () => {
  const manifest = {
    micromamba: {
      platforms: {
        'linux-x64': { url: 'https://example.test/micromamba' }
      }
    }
  }
  assert.equal(lookupMicromambaPlatform(manifest, 'linux-x64'), undefined)
  assert.deepEqual(
    lookupMicromambaPlatform(
      {
        micromamba: {
          platforms: {
            'linux-x64': {
              url: 'https://example.test/micromamba',
              sha256: 'ab'.repeat(32)
            }
          }
        }
      },
      'linux-x64'
    ),
    { url: 'https://example.test/micromamba', sha256: 'ab'.repeat(32) }
  )
})

test('fileSha256 hashes file bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-micromamba-sha-'))
  try {
    const filePath = join(root, 'payload')
    writeFileSync(filePath, 'abc')
    assert.equal(
      fileSha256(filePath),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Plain Node resolves bundled resources from the working directory: electron's
// export outside the Electron process is the binary path, not app.
test('getMicromambaPath resolves a binary under the working directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-micromamba-path-'))
  const previous = process.cwd()
  try {
    process.chdir(root)
    // cwd() realpath differs from mkdtemp's path on macOS (/var -> /private/var).
    const directory = join(process.cwd(), 'resources', 'runtime', 'micromamba', 'darwin-arm64')
    const binary = join(directory, 'micromamba')
    mkdirSync(directory, { recursive: true })
    writeFileSync(binary, 'micromamba')
    assert.equal(getMicromambaPath('darwin-arm64'), binary)
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})

test('micromambaCandidates uses the .exe name on Windows', () => {
  const bundledRuntimeDir = '/repo/resources/runtime'
  assert.deepEqual(micromambaCandidates('win32-x64', { bundledRuntimeDir }), [
    join(bundledRuntimeDir, 'micromamba', 'win32-x64', 'micromamba.exe')
  ])
})

test('micromambaCandidates prefers the packaged resources path', () => {
  const resourcesPath = '/Applications/Phi.app/Contents/Resources'
  const bundledRuntimeDir = '/repo/resources/runtime'
  assert.deepEqual(micromambaCandidates('darwin-arm64', { resourcesPath, bundledRuntimeDir }), [
    join(resourcesPath, 'runtime', 'micromamba', 'darwin-arm64', 'micromamba'),
    join(bundledRuntimeDir, 'micromamba', 'darwin-arm64', 'micromamba')
  ])
})

test('micromambaCandidates omits the packaged path when resourcesPath is undefined', () => {
  const bundledRuntimeDir = '/repo/resources/runtime'
  assert.deepEqual(micromambaCandidates('linux-x64', { bundledRuntimeDir }), [
    join(bundledRuntimeDir, 'micromamba', 'linux-x64', 'micromamba')
  ])
  assert.deepEqual(
    micromambaCandidates('linux-x64', { resourcesPath: undefined, bundledRuntimeDir }),
    [join(bundledRuntimeDir, 'micromamba', 'linux-x64', 'micromamba')]
  )
})

test('getMicromambaPath reports how to fetch a missing binary', () => {
  // Outside Electron, resolution falls back to the repository's own resources/runtime, which CI
  // (and any developer who ran runtime:fetch) has populated for the real platforms. A platform
  // name nothing is ever bundled for keeps this about the error message, not the machine.
  const root = mkdtempSync(join(tmpdir(), 'phi-micromamba-missing-'))
  const previous = process.cwd()
  try {
    process.chdir(root)
    assert.throws(
      () => getMicromambaPath('no-such-platform'),
      /Bundled micromamba for no-such-platform is missing at .*micromamba; run npm run runtime:fetch/
    )
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Windows app-local MSVC sidecars (micromamba 0xC0000135) -----------------------
//
// micromamba-win-64 imports MSVCP140/VCRUNTIME140/VCRUNTIME140_1, which no clean
// Windows host has. A cached matching micromamba.exe must never mask missing or
// corrupt DLLs, packaging must fail rather than ship a runtime that cannot load,
// and no partial update may survive a corrupt member.

const SIDECAR_NAMES = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const LICENSE_NAMES = ['LICENSE.TXT', 'LICENSE.RTF', 'LICENSE.DOCX']

function bodyFor(name: string): string {
  return name.startsWith('LICENSE') ? `license-bytes:${name}` : `dll-bytes:${name}`
}

/** Synthetic runtime spec whose hashes match the synthetic bodies used below. */
interface RuntimeFileFixture {
  name: string
  member: string
  sha256: string
  size: number
}
interface RuntimeFixture {
  version: string
  archive: { url: string; sha256: string; size: number; format: string }
  files: RuntimeFileFixture[]
  licenses: RuntimeFileFixture[]
}
function syntheticRuntime(): RuntimeFixture {
  const entry = (name: string, member: string): RuntimeFileFixture => ({
    name,
    member,
    sha256: createHash('sha256').update(bodyFor(name)).digest('hex'),
    size: bodyFor(name).length
  })
  return {
    version: 'test',
    archive: {
      url: 'https://example.test/vc14_runtime.conda',
      sha256: createHash('sha256').update('archive-body').digest('hex'),
      size: 12,
      format: 'conda'
    },
    files: SIDECAR_NAMES.map((name) => entry(name, `Library/bin/${name}`)),
    licenses: LICENSE_NAMES.map((name) => entry(name, `info/licenses/${name}`))
  }
}

function syntheticManifest(runtime: RuntimeFixture): Record<string, unknown> {
  return {
    micromamba: {
      platforms: {
        'win32-x64': {
          url: 'https://example.test/micromamba-win-64',
          sha256: 'ab'.repeat(32),
          vcRuntime: runtime
        }
      }
    }
  }
}

function writeSidecars(
  directory: string,
  runtime: RuntimeFixture,
  override?: (name: string) => string
): void {
  mkdirSync(directory, { recursive: true })
  for (const file of [...runtime.files, ...runtime.licenses] as Array<{ name: string }>) {
    writeFileSync(join(directory, file.name), override ? override(file.name) : bodyFor(file.name))
  }
}

/** Extraction stand-in: exact bytes the synthetic hashes were computed over. */
function matchingExtractor(runtime: RuntimeFixture) {
  return () =>
    new Map(
      ([...runtime.files, ...runtime.licenses] as Array<{ name: string; member: string }>).map(
        (file) => [file.member, Buffer.from(bodyFor(file.name))]
      )
    )
}

function downloadArchive(destination: string): void {
  writeFileSync(destination, 'archive-body')
}

test('vcRuntime manifest entry pins the archive and every sidecar', () => {
  const runtime = lookupVcRuntime(
    JSON.parse(readFileSync(join(repoRoot, 'resources', 'runtime', 'manifest.json'), 'utf8'))
  )
  assert.ok(runtime)
  assert.equal(
    runtime.archive.url,
    'https://conda.anaconda.org/conda-forge/win-64/vc14_runtime-14.51.36247-habf1de7_42.conda'
  )
  assert.equal(
    runtime.archive.sha256,
    '8dfbfd68ebf53249d11e528cbb80ad5a2460b0c5b4636eed82ee0d3950827a3d'
  )
  assert.deepEqual(
    runtime.files.map((file: { name: string }) => file.name).sort(),
    [...SIDECAR_NAMES].sort()
  )
  assert.deepEqual(
    runtime.licenses.map((file: { name: string }) => file.name).sort(),
    [...LICENSE_NAMES].sort()
  )
  for (const file of [...runtime.files, ...runtime.licenses]) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.name} needs a sha256`)
    assert.match(file.member, /^(?:Library\/bin|info\/licenses)\/[A-Za-z0-9._-]+$/)
    assert.ok(file.size > 0)
  }
})

test('vcRuntime lookup rejects a file set that is not exactly the allowlist', () => {
  const runtime = syntheticRuntime()
  assert.equal(
    lookupVcRuntime(syntheticManifest({ ...runtime, files: runtime.files.slice(0, 2) })),
    undefined
  )
  const extra = syntheticManifest({
    ...runtime,
    files: [
      ...runtime.files,
      {
        name: 'concrt140.dll',
        member: 'Library/bin/concrt140.dll',
        sha256: 'ab'.repeat(32),
        size: 1
      }
    ]
  })
  assert.equal(lookupVcRuntime(extra), undefined)
})

test('sidecarProblems reports every missing DLL and licence', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-problems-'))
  try {
    const runtime = syntheticRuntime()
    assert.deepEqual(sidecarProblems(root, runtime), [
      ...(runtime.files as Array<{ name: string }>).map((file) => `missing ${file.name}`),
      ...(runtime.licenses as Array<{ name: string }>).map((file) => `missing ${file.name}`)
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cached matching micromamba.exe does not skip missing sidecars', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-cache-'))
  try {
    const runtime = syntheticRuntime()
    const directory = runtimeTargetDir(root)
    mkdirSync(directory, { recursive: true })
    const exe = join(directory, 'micromamba.exe')
    writeFileSync(exe, 'cached-exe')
    const before = fileSha256(exe)

    let downloads = 0
    const result = ensureWindowsRuntimeSidecars({
      repoRoot: root,
      manifest: syntheticManifest(runtime),
      extract: matchingExtractor(runtime),
      download(destination: string) {
        downloads += 1
        downloadArchive(destination)
      }
    })
    assert.equal(downloads, 1, 'missing sidecars must force an archive fetch')
    assert.equal(result.status, 'repaired')
    assert.equal(result.repaired, true)
    assert.deepEqual(result.written.sort(), [...SIDECAR_NAMES, ...LICENSE_NAMES].sort())
    assert.equal(fileSha256(exe), before, 'the cached exe must not be rewritten')
    assert.deepEqual(sidecarProblems(directory, runtime), [])
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith('.vc14-')),
      [],
      'no scratch state may survive'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt sidecars are repaired with the manifest bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-corrupt-'))
  try {
    const runtime = syntheticRuntime()
    const directory = runtimeTargetDir(root)
    writeSidecars(directory, runtime)
    assert.deepEqual(sidecarProblems(directory, runtime), [])

    writeFileSync(join(directory, 'vcruntime140.dll'), 'truncated')
    writeFileSync(join(directory, 'LICENSE.TXT'), 'wrong')
    assert.deepEqual(sidecarProblems(directory, runtime), [
      'checksum mismatch for vcruntime140.dll',
      'checksum mismatch for LICENSE.TXT'
    ])

    const result = ensureWindowsRuntimeSidecars({
      repoRoot: root,
      manifest: syntheticManifest(runtime),
      extract: matchingExtractor(runtime),
      download: downloadArchive
    })
    assert.equal(result.repaired, true)
    assert.deepEqual(sidecarProblems(directory, runtime), [])
    assert.equal(
      readFileSync(join(directory, 'vcruntime140.dll'), 'utf8'),
      bodyFor('vcruntime140.dll')
    )
    assert.equal(readFileSync(join(directory, 'LICENSE.TXT'), 'utf8'), bodyFor('LICENSE.TXT'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a complete sidecar set needs neither download nor extraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-ready-'))
  try {
    const runtime = syntheticRuntime()
    writeSidecars(runtimeTargetDir(root), runtime)
    const result = ensureWindowsRuntimeSidecars({
      repoRoot: root,
      manifest: syntheticManifest(runtime),
      extract() {
        throw new Error('extraction must not run when sidecars are already valid')
      },
      download() {
        throw new Error('download must not run when sidecars are already valid')
      }
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.repaired, false)
    assert.deepEqual(result.written, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an archive whose digest does not match the locked value installs nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-integrity-'))
  try {
    const runtime = syntheticRuntime()
    const directory = runtimeTargetDir(root)
    let extractionRan = false
    assert.throws(
      () =>
        ensureWindowsRuntimeSidecars({
          repoRoot: root,
          manifest: syntheticManifest(runtime),
          extract() {
            extractionRan = true
            return new Map()
          },
          download(destination: string) {
            writeFileSync(destination, 'tampered-bytes')
          }
        }),
      /archive checksum mismatch/
    )
    assert.equal(extractionRan, false, 'a bad archive must never be extracted')
    assert.equal(existsSync(join(directory, 'msvcp140.dll')), false)
    assert.deepEqual(readdirSync(directory), [], 'scratch directory is removed entirely')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupt member late in the set leaves the directory untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-partial-'))
  try {
    const runtime = syntheticRuntime()
    const directory = runtimeTargetDir(root)
    writeSidecars(directory, runtime)
    // Force a repair by damaging one file, then make the LAST member corrupt.
    writeFileSync(join(directory, 'vcruntime140.dll'), 'truncated')
    const snapshot = readdirSync(directory).sort()
    const before = new Map(
      snapshot.map((name) => [name, readFileSync(join(directory, name), 'utf8')])
    )
    const result = (): Map<string, Buffer> => {
      const map = matchingExtractor(runtime)()
      map.set('info/licenses/LICENSE.DOCX', Buffer.from('corrupt-last-member'))
      return map
    }
    assert.throws(
      () =>
        ensureWindowsRuntimeSidecars({
          repoRoot: root,
          manifest: syntheticManifest(runtime),
          extract: result,
          download: downloadArchive
        }),
      /checksum mismatch for info\/licenses\/LICENSE.DOCX/
    )
    assert.deepEqual(readdirSync(directory).sort(), snapshot, 'no file added or removed')
    for (const [name, contents] of before) {
      assert.equal(
        readFileSync(join(directory, name), 'utf8'),
        contents,
        `${name} must be unchanged`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('afterPack fails when packaged sidecars are absent or corrupt', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-afterpack-'))
  try {
    const runtime = syntheticRuntime()
    const manifest = syntheticManifest(runtime)
    const resources = join(root, 'resources')
    const directory = join(resources, 'runtime', 'micromamba', 'win32-x64')
    mkdirSync(directory, { recursive: true })

    assert.throws(() => assertBundledWindowsSidecars(resources, manifest), /runtime incomplete/)

    writeSidecars(directory, runtime)
    assert.doesNotThrow(() => assertBundledWindowsSidecars(resources, manifest))

    writeFileSync(join(directory, 'vcruntime140_1.dll'), 'corrupt')
    assert.throws(
      () => assertBundledWindowsSidecars(resources, manifest),
      /checksum mismatch for vcruntime140_1.dll/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('afterPack refuses a manifest without a vcRuntime entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-vc-nomanifest-'))
  try {
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    assert.throws(
      () => assertBundledWindowsSidecars(resources, { micromamba: { platforms: {} } }),
      /no vcRuntime entry/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sidecar extraction rejects member names outside the allowlist', () => {
  const runtime = syntheticRuntime()
  const hostile = {
    ...runtime,
    files: [{ ...runtime.files[0], member: '../../evil.dll' }]
  }
  assert.throws(
    () =>
      extractSidecars('/nonexistent.conda', hostile, {
        scratch: tmpdir(),
        tar: () => Buffer.alloc(0)
      }),
    /unsafe member name/
  )
})

test('GNU tar ZIP rejection uses unzip without hiding inner tar errors', () => {
  const calls: Array<[string, string[]]> = []
  const execute = (command: string, args: string[]): Buffer => {
    calls.push([command, args])
    if (command === 'tar') throw new Error('not a tar archive')
    return Buffer.from('selected-member')
  }
  assert.equal(
    runTar(['-xOf', '/tmp/runtime.conda', 'pkg-test.tar.zst'], execute).toString(),
    'selected-member'
  )
  assert.deepEqual(calls, [
    ['tar', ['-xOf', '/tmp/runtime.conda', 'pkg-test.tar.zst']],
    ['unzip', ['-p', '/tmp/runtime.conda', 'pkg-test.tar.zst']]
  ])
  calls.length = 0
  assert.throws(
    () => runTar(['-xOf', '/tmp/pkg-test.tar', 'Library/bin/msvcp140.dll'], execute),
    /not a tar archive/
  )
  assert.equal(calls.length, 1)
})
