import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BUN_PLATFORM_IDS,
  bunPlatformId,
  lookupBunPlatform
} from '../scripts/runtime/fetch-bun.mjs'

test('Bun fetch supports the initial darwin-arm64 target only', () => {
  assert.deepEqual(BUN_PLATFORM_IDS, ['darwin-arm64'])
  assert.equal(bunPlatformId('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(bunPlatformId('darwin', 'x64'), undefined)
  assert.equal(bunPlatformId('linux', 'x64'), undefined)
})

test('Bun manifest lookup requires archive and executable checksums', () => {
  const release = {
    url: 'https://example.test/bun.zip',
    sha256: 'archive-sha256',
    executableSha256: 'executable-sha256',
    archivePath: 'bun-darwin-aarch64/bun'
  }
  assert.deepEqual(
    lookupBunPlatform({ bun: { platforms: { 'darwin-arm64': release } } }, 'darwin-arm64'),
    release
  )
  assert.equal(
    lookupBunPlatform(
      { bun: { platforms: { 'darwin-arm64': { ...release, executableSha256: undefined } } } },
      'darwin-arm64'
    ),
    undefined
  )
})

test('package scripts fetch Bun before building application output', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(packageJson.scripts['bun:fetch'], 'node scripts/runtime/fetch-bun.mjs')
  assert.match(packageJson.scripts.build, /runtime:fetch && bun run bun:fetch &&/u)
})
