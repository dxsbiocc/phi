import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { estimateBuild, packageArchiveName } from '../src/main/agent/envs/estimate'

const MD5 = '0123456789abcdef0123456789abcdef'
const ZLIB = `https://conda.anaconda.org/conda-forge/osx-arm64/zlib-1.3-h0.conda#${MD5}`
const CA = `https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026-h0.tar.bz2#${MD5}`

function lock(urls: string[], bytes?: number): string {
  return [
    '# baseline: osx 11.0',
    ...(bytes === undefined ? [] : [`# download-bytes: ${String(bytes)}`]),
    '@EXPLICIT',
    ...urls,
    ''
  ].join('\n')
}

test('estimateBuild subtracts cached archives and counts extracted packages as a share', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-estimate-'))
  try {
    const pkgs = join(root, 'pkgs')
    mkdirSync(pkgs)
    const text = lock([ZLIB, CA], 100)
    assert.deepEqual(estimateBuild(root, text), {
      packages: 2,
      cachedPackages: 0,
      downloadBytes: 100,
      remainingBytes: 100
    })

    writeFileSync(join(pkgs, packageArchiveName(ZLIB)), Buffer.alloc(40))
    mkdirSync(join(pkgs, 'zlib-1.3-h0'))
    assert.deepEqual(estimateBuild(root, text), {
      packages: 2,
      cachedPackages: 1,
      downloadBytes: 100,
      remainingBytes: 60
    })

    mkdirSync(join(pkgs, 'ca-certificates-2026-h0'))
    assert.deepEqual(estimateBuild(root, text), {
      packages: 2,
      cachedPackages: 2,
      downloadBytes: 100,
      remainingBytes: 10
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an extracted package with no archive counts as downloadBytes / packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-estimate-'))
  try {
    mkdirSync(join(root, 'pkgs', 'zlib-1.3-h0'), { recursive: true })
    const text = lock([ZLIB, CA], 100)
    assert.deepEqual(estimateBuild(root, text), {
      packages: 2,
      cachedPackages: 1,
      downloadBytes: 100,
      remainingBytes: 50
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('estimateBuild omits byte fields when the lock has no download size', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-estimate-'))
  try {
    const pkgs = join(root, 'pkgs')
    mkdirSync(pkgs)
    writeFileSync(join(pkgs, packageArchiveName(ZLIB)), Buffer.alloc(10))
    assert.deepEqual(estimateBuild(root, lock([ZLIB])), {
      packages: 1,
      cachedPackages: 1
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('remainingBytes does not go below zero when a cached archive is larger than the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-estimate-'))
  try {
    const pkgs = join(root, 'pkgs')
    mkdirSync(pkgs)
    writeFileSync(join(pkgs, packageArchiveName(ZLIB)), Buffer.alloc(80))
    assert.deepEqual(estimateBuild(root, lock([ZLIB], 10)), {
      packages: 1,
      cachedPackages: 1,
      downloadBytes: 10,
      remainingBytes: 0
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('estimateBuild rejects a lock that is not explicit', () => {
  assert.throws(() => estimateBuild('/tmp', 'not a lock\n'), /@EXPLICIT/)
})
