import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildHelperManifest,
  HELPER_TARGETS,
  readHelperVersion,
  verifyFileSha256
} from '../scripts/build-helper.mjs'
import { missingExtraResourceMappings } from '../scripts/check-asar-unpack.mjs'
import { offendingResourcePaths } from '../scripts/check-resources.mjs'
import {
  GO_RELEASE,
  goArchivePlatform,
  goBinaryPath,
  goToolchainEnvironment
} from '../scripts/helper-toolchain.mjs'

test('Go release manifest pins every supported official archive', () => {
  assert.equal(GO_RELEASE.version, '1.27.2')
  assert.equal(GO_RELEASE.source, 'https://go.dev/dl/?mode=json')
  assert.deepEqual(Object.keys(GO_RELEASE.platforms).sort(), [
    'darwin-amd64',
    'darwin-arm64',
    'linux-amd64',
    'linux-arm64'
  ])
  const expectedSha256 = {
    'darwin-amd64': '587b59182488b23aa6e5fc25110405a3e0e5b38ed2f5b2f46ed13c32aee356fe',
    'darwin-arm64': '76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5',
    'linux-amd64': 'ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5',
    'linux-arm64': '94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8'
  }
  const releases = GO_RELEASE.platforms as Record<string, { url: string; sha256: string }>
  for (const [platformId, release] of Object.entries(releases)) {
    assert.equal(release.url, `https://go.dev/dl/go1.27.2.${platformId}.tar.gz`)
    assert.equal(release.sha256, expectedSha256[platformId as keyof typeof expectedSha256])
  }
})

test('Go platform selection translates Node x64 without widening support', () => {
  assert.equal(goArchivePlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(goArchivePlatform('linux', 'x64'), 'linux-amd64')
  assert.equal(goArchivePlatform('win32', 'x64'), undefined)
})

test('Go commands receive an offline cache-scoped environment', () => {
  const cacheRoot = '/cache/phi-go/1.27.2'
  const env = goToolchainEnvironment({ PATH: '/usr/bin' }, cacheRoot)
  assert.equal(goBinaryPath(cacheRoot), '/cache/phi-go/1.27.2/go/bin/go')
  assert.equal(env.GOFLAGS, '-mod=readonly')
  assert.equal(env.GOTOOLCHAIN, 'local')
  assert.equal(env.GOPROXY, 'off')
  assert.equal(env.GOSUMDB, 'off')
  assert.equal(env.GOCACHE, path.join(cacheRoot, 'gocache'))
  assert.equal(env.GOPATH, path.join(cacheRoot, 'gopath'))
  assert.equal(env.PATH, '/usr/bin')
})

test('helper build target matrix publishes only static Linux binaries', () => {
  assert.deepEqual(HELPER_TARGETS, [
    { id: 'linux-amd64', goos: 'linux', goarch: 'amd64' },
    { id: 'linux-arm64', goos: 'linux', goarch: 'arm64' }
  ])
})

test('helper version comes from the helper module canonical file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-helper-version-'))
  try {
    mkdirSync(path.join(root, 'helper'))
    writeFileSync(path.join(root, 'helper', 'VERSION'), '0.1.0\n')
    assert.equal(readHelperVersion(root), '0.1.0')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('helper manifest is stable and uses resource-root-relative paths', () => {
  const entries = [
    { id: 'linux-arm64', sha256: 'b'.repeat(64), size: 22 },
    { id: 'linux-amd64', sha256: 'a'.repeat(64), size: 11 }
  ]
  assert.deepEqual(buildHelperManifest('0.1.0', entries), {
    version: '0.1.0',
    platforms: {
      'linux-amd64': {
        path: '0.1.0/linux-amd64/phi-helper',
        sha256: 'a'.repeat(64),
        size: 11
      },
      'linux-arm64': {
        path: '0.1.0/linux-arm64/phi-helper',
        sha256: 'b'.repeat(64),
        size: 22
      }
    }
  })
})

test('sha256 verification rejects a mismatched file', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'phi-helper-build-'))
  try {
    const filePath = path.join(directory, 'artifact')
    writeFileSync(filePath, 'artifact')
    const expected = createHash('sha256').update('artifact').digest('hex')
    assert.equal(verifyFileSha256(filePath, expected), true)
    assert.equal(verifyFileSha256(filePath, '0'.repeat(64)), false)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('generated helper artifacts are accepted resource-cache entries', () => {
  assert.deepEqual(
    offendingResourcePaths([
      'resources/remote-helper/manifest.json',
      'resources/remote-helper/0.1.0/linux-amd64/phi-helper'
    ]),
    []
  )
})

test('electron-builder distributes the remote helper outside the asar', () => {
  assert.deepEqual(missingExtraResourceMappings(), [])
})
