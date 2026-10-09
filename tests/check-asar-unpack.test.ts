import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import {
  collectOmpWorkerPackageAssets,
  collectOmpWorkerPackageDirs,
  collectOmpWorkerSources,
  copyOmpWorkerClosure,
  ompWorkerOutputFiles
} from '../scripts/build/omp-worker-closure.mjs'
import { assertBundledBun } from '../scripts/build/after-pack.mjs'
import {
  checkAsarUnpack,
  globToRegExp,
  missingExtraResourceMappings,
  uncoveredPaths
} from '../scripts/check-asar-unpack.mjs'

const repoRoot = process.cwd()

test('asarUnpack covers the OMP worker, its copied closure and its runtime packages', () => {
  assert.deepEqual(checkAsarUnpack(repoRoot), [])
})

test('electron-builder distributes the remote helper outside the asar', () => {
  assert.deepEqual(missingExtraResourceMappings(repoRoot), [])
})

test('asar check reports a missing arch-specific Bun resource mapping', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-bun-mapping-'))
  try {
    writeFileSync(
      path.join(root, 'electron-builder.yml'),
      [
        'extraResources:',
        '  - from: resources/remote-helper',
        '    to: remote-helper',
        'mac:',
        '  extraResources: []',
        ''
      ].join('\n')
    )
    assert.deepEqual(missingExtraResourceMappings(root), [
      'mac.extraResources: resources/runtime/bun/darwin-${arch} -> runtime/bun/darwin-${arch}'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('electron-builder packages Bun as a macOS arch-specific external resource', () => {
  const config = parse(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'))
  assert.ok(config.files.includes('!resources/runtime/bun/**'))
  assert.ok(
    config.mac.extraResources.some(
      (entry: { from?: string; to?: string }) =>
        entry.from === 'resources/runtime/bun/darwin-${arch}' &&
        entry.to === 'runtime/bun/darwin-${arch}'
    )
  )
  assert.match(
    readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'),
    /resources\/runtime\/bun\//u
  )
})

test('afterPack rejects a packaged app with a missing or non-executable Bun', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-packaged-bun-'))
  const bunPath = path.join(root, 'runtime', 'bun', 'darwin-arm64', 'bun')
  try {
    assert.throws(() => assertBundledBun(root, 'darwin-arm64'), /missing bundled Bun/u)
    mkdirSync(path.dirname(bunPath), { recursive: true })
    writeFileSync(bunPath, '#!/bin/sh\n')
    assert.throws(() => assertBundledBun(root, 'darwin-arm64'), /not executable/u)
    chmodSync(bunPath, 0o755)
    assert.equal(assertBundledBun(root, 'darwin-arm64'), bunPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker closure follows relative imports beyond the old hand-maintained list', () => {
  const { files, packages } = collectOmpWorkerSources(repoRoot)
  for (const expected of [
    'src/main/agent/omp/omp-sdk-worker.ts',
    'src/main/agent/omp/next-action-extension.ts',
    'src/main/agent/runtime-paths.ts',
    'src/shared/presentedFileTypes.ts'
  ]) {
    assert.ok(files.includes(expected), `${expected} missing from worker closure`)
  }
  assert.ok(packages.includes('@oh-my-pi/pi-coding-agent'))
  assert.ok(!packages.some((name) => name.startsWith('node:')))
  assert.ok(
    collectOmpWorkerPackageDirs(repoRoot).includes('node_modules/@oh-my-pi/pi-coding-agent')
  )
})

test('copy plugin emits exactly the closure files under out/', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-omp-closure-'))
  try {
    const write = (relative: string, body: string): void => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
      writeFileSync(path.join(root, relative), body)
    }
    write(
      'src/main/agent/omp/omp-sdk-worker.ts',
      "import { a } from '../a'\nimport type { T } from '../../../shared/t'\nimport 'yaml'\n"
    )
    write('src/main/agent/a.ts', "export { b } from './nested/b'\nexport const a = 1\n")
    write('src/main/agent/nested/b.ts', "const c = await import('./c')\nexport const b = c\n")
    write('src/main/agent/nested/c.ts', 'export {}\n')
    write('src/shared/t.ts', 'export type T = 1\n')
    write('src/main/agent/unrelated.ts', 'export {}\n')

    copyOmpWorkerClosure(root)

    const emitted = readdirSync(path.join(root, 'out'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
      )
      .sort()
    assert.deepEqual(emitted, ompWorkerOutputFiles(root))
    assert.deepEqual(emitted, [
      'out/main/agent/a.ts',
      'out/main/agent/nested/b.ts',
      'out/main/agent/nested/c.ts',
      'out/main/agent/omp/omp-sdk-worker.ts',
      'out/shared/t.ts'
    ])
    assert.deepEqual(collectOmpWorkerSources(root).packages, ['yaml'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('glob matching flags the old single-file worker glob as insufficient', () => {
  assert.ok(globToRegExp('node_modules/@scope/**').test('node_modules/@scope/pkg/package.json'))
  assert.ok(!globToRegExp('out/*.ts').test('out/main/x.ts'))
  assert.deepEqual(
    uncoveredPaths(
      ['out/main/agent/omp-sdk-worker.ts'],
      ['out/main/agent/omp/omp-sdk-worker.ts', 'out/main/agent/runtime-paths.ts']
    ),
    ['out/main/agent/omp/omp-sdk-worker.ts', 'out/main/agent/runtime-paths.ts']
  )
})

test('worker package assets include files electron-builder strips from node_modules', () => {
  const assets = collectOmpWorkerPackageAssets(repoRoot)
  for (const expected of [
    'node_modules/@oh-my-pi/pi-coding-agent/CHANGELOG.md',
    'node_modules/@oh-my-pi/pi-coding-agent/src/tools/computer/declarations.d.ts'
  ]) {
    assert.ok(assets.includes(expected), `${expected} missing from worker assets`)
  }
})
