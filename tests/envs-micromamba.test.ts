import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getMicromambaPath, micromambaCandidates } from '../src/main/agent/envs/paths'
import { findPlatform } from '../src/main/agent/envs/platform'
import {
  MICROMAMBA_PLATFORM_IDS,
  fileSha256,
  lookupMicromambaPlatform,
  phiPlatformId
} from '../scripts/runtime/fetch-micromamba.mjs'

const repoRoot = process.cwd()

const condaSubdirByPlatform: Record<string, string> = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-64',
  'linux-x64': 'linux-64'
}

test('micromamba manifest lists the three bundled platforms', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'resources', 'runtime', 'manifest.json'), 'utf8')
  ) as {
    micromamba: {
      version: string
      platforms: Record<string, { url: string; sha256: string }>
    }
  }

  assert.equal(manifest.micromamba.version, '2.9.0-0')
  assert.deepEqual(
    Object.keys(manifest.micromamba.platforms).sort(),
    [...MICROMAMBA_PLATFORM_IDS].sort()
  )

  for (const platformId of MICROMAMBA_PLATFORM_IDS) {
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

  assert.equal(lookupMicromambaPlatform(manifest, 'win32-x64'), undefined)
})

test('platform ids map process.platform and process.arch', () => {
  assert.equal(phiPlatformId('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(phiPlatformId('darwin', 'x64'), 'darwin-x64')
  assert.equal(phiPlatformId('linux', 'x64'), 'linux-x64')
  assert.equal(phiPlatformId('win32', 'x64'), undefined)
  assert.equal(phiPlatformId('linux', 'arm64'), undefined)

  assert.equal(findPlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(findPlatform('darwin', 'x64'), 'darwin-x64')
  assert.equal(findPlatform('linux', 'x64'), 'linux-x64')
  assert.equal(findPlatform('win32', 'x64'), undefined)
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
