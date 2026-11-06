import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BUN_PLATFORM_IDS,
  bunDownloadUrls,
  bunPlatformId,
  fetchBunPlatform,
  lookupBunPlatform
} from '../scripts/runtime/fetch-bun.mjs'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('Bun fetch supports the packaged macOS arm64, Linux x64, and Windows x64 targets', () => {
  assert.deepEqual(BUN_PLATFORM_IDS, ['darwin-arm64', 'linux-x64', 'win32-x64'])
  assert.equal(bunPlatformId('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(bunPlatformId('darwin', 'x64'), undefined)
  assert.equal(bunPlatformId('linux', 'x64'), 'linux-x64')
  assert.equal(bunPlatformId('win32', 'x64'), 'win32-x64')
})

test('Bun manifest pins the verified Linux x64 archive and executable', () => {
  const manifest = JSON.parse(readFileSync('resources/runtime/manifest.json', 'utf8'))
  assert.deepEqual(lookupBunPlatform(manifest, 'linux-x64'), {
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip',
    sha256: '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f',
    executableSha256: '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74',
    archivePath: 'bun-linux-x64/bun',
    mirrorPrefixes: ['https://gh-proxy.com/', 'https://ghfast.top/']
  })
})

test('Bun manifest pins the verified Windows x64 archive and executable', () => {
  const manifest = JSON.parse(readFileSync('resources/runtime/manifest.json', 'utf8'))
  assert.deepEqual(lookupBunPlatform(manifest, 'win32-x64'), {
    url: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip',
    sha256: '0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922',
    executableSha256: '0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c',
    archivePath: 'bun-windows-x64/bun.exe',
    mirrorPrefixes: ['https://gh-proxy.com/', 'https://ghfast.top/']
  })
  assert.deepEqual(bunDownloadUrls(lookupBunPlatform(manifest, 'win32-x64')!), [
    'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip',
    'https://gh-proxy.com/https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip',
    'https://ghfast.top/https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64.zip'
  ])
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

test('Linux Bun fetch verifies and extracts an injected local archive without network access', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fetch-bun-linux-'))
  const archiveRoot = join(root, 'archive')
  const archiveDir = join(archiveRoot, 'bun-linux-x64')
  const sourceExecutable = join(archiveDir, 'bun')
  const archive = join(root, 'bun-linux-x64.zip')
  const runtimeDir = join(root, 'runtime')
  try {
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(sourceExecutable, '#!/bin/sh\necho 1.3.14\n')
    execFileSync('zip', ['-q', '-r', archive, 'bun-linux-x64'], { cwd: archiveRoot })
    const url = 'https://example.test/bun-linux-x64.zip'
    const downloads: string[] = []
    const target = fetchBunPlatform(
      {
        bun: {
          version: '1.3.14',
          platforms: {
            'linux-x64': {
              url,
              sha256: sha256(archive),
              executableSha256: sha256(sourceExecutable),
              archivePath: 'bun-linux-x64/bun'
            }
          }
        }
      },
      'linux-x64',
      {
        runtimeDir,
        download: (source, destination) => {
          downloads.push(source)
          copyFileSync(archive, destination)
        }
      }
    )

    assert.equal(target, join(runtimeDir, 'bun', 'linux-x64', 'bun'))
    assert.equal(sha256(target), sha256(sourceExecutable))
    assert.doesNotThrow(() => accessSync(target, constants.X_OK))
    assert.deepEqual(downloads, [url])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows Bun fetch verifies and extracts an injected local archive without network access', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fetch-bun-win-'))
  const archiveRoot = join(root, 'archive')
  const archiveDir = join(archiveRoot, 'bun-windows-x64')
  const sourceExecutable = join(archiveDir, 'bun.exe')
  const archive = join(root, 'bun-windows-x64.zip')
  const runtimeDir = join(root, 'runtime')
  try {
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(sourceExecutable, 'MZ-fake-bun')
    execFileSync('zip', ['-q', '-r', archive, 'bun-windows-x64'], { cwd: archiveRoot })
    const url = 'https://example.test/bun-windows-x64.zip'
    const downloads: string[] = []
    const target = fetchBunPlatform(
      {
        bun: {
          version: '1.3.14',
          platforms: {
            'win32-x64': {
              url,
              sha256: sha256(archive),
              executableSha256: sha256(sourceExecutable),
              archivePath: 'bun-windows-x64/bun.exe'
            }
          }
        }
      },
      'win32-x64',
      {
        runtimeDir,
        download: (source, destination) => {
          downloads.push(source)
          copyFileSync(archive, destination)
        }
      }
    )

    assert.equal(target, join(runtimeDir, 'bun', 'win32-x64', 'bun.exe'))
    assert.equal(sha256(target), sha256(sourceExecutable))
    assert.doesNotThrow(() => accessSync(target, constants.X_OK))
    assert.deepEqual(downloads, [url])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Bun fetch falls through GitHub to the next mirror prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-fetch-bun-mirror-'))
  const archiveRoot = join(root, 'archive')
  const archiveDir = join(archiveRoot, 'bun-windows-x64')
  const sourceExecutable = join(archiveDir, 'bun.exe')
  const archive = join(root, 'bun-windows-x64.zip')
  const runtimeDir = join(root, 'runtime')
  try {
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(sourceExecutable, 'MZ-mirror-bun')
    execFileSync('zip', ['-q', '-r', archive, 'bun-windows-x64'], { cwd: archiveRoot })
    const primary = 'https://github.example/bun-windows-x64.zip'
    const mirror = 'https://gh-proxy.com/https://github.example/bun-windows-x64.zip'
    const downloads: string[] = []
    const target = fetchBunPlatform(
      {
        bun: {
          version: '1.3.14',
          platforms: {
            'win32-x64': {
              url: primary,
              mirrorPrefixes: ['https://gh-proxy.com/'],
              sha256: sha256(archive),
              executableSha256: sha256(sourceExecutable),
              archivePath: 'bun-windows-x64/bun.exe'
            }
          }
        }
      },
      'win32-x64',
      {
        runtimeDir,
        download: (source, destination) => {
          downloads.push(source)
          if (source === primary) throw new Error('github timed out')
          copyFileSync(archive, destination)
        }
      }
    )

    assert.equal(target, join(runtimeDir, 'bun', 'win32-x64', 'bun.exe'))
    assert.deepEqual(downloads, [primary, mirror])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package scripts fetch Bun before building application output', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(packageJson.scripts['bun:fetch'], 'node scripts/runtime/fetch-bun.mjs')
  assert.match(packageJson.scripts.build, /runtime:fetch && bun run bun:fetch &&/u)
  assert.match(packageJson.scripts['build:win'], /bun run runtime:fetch:win && bun run build/u)
  const windowsRuntimeFetch = packageJson.scripts['runtime:fetch:win']
  assert.match(windowsRuntimeFetch, /fetch-bun\.mjs --platform win32-x64/u)
  assert.match(windowsRuntimeFetch, /fetch-micromamba\.mjs --platform win32-x64/u)
  assert.match(windowsRuntimeFetch, /fetch-micromamba\.mjs --platform linux-x64/u)
  for (const scriptName of Object.keys(packageJson.scripts)) {
    assert.doesNotMatch(scriptName, /^office:/u, 'the retired Office runtime has no scripts')
  }
})
