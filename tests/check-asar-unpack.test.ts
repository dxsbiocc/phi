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
import { afterPack, assertBundledBun } from '../scripts/build/after-pack.mjs'
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
      'mac.extraResources: resources/runtime/bun/darwin-${arch} -> runtime/bun/darwin-${arch}',
      'linux.extraResources: resources/runtime/bun/linux-${arch} -> runtime/bun/linux-${arch}'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('electron-builder packages Bun as arch-specific external resources', () => {
  const config = parse(readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'))
  assert.ok(config.files.includes('!resources/runtime/bun/**'))
  assert.ok(
    config.mac.extraResources.some(
      (entry: { from?: string; to?: string }) =>
        entry.from === 'resources/runtime/bun/darwin-${arch}' &&
        entry.to === 'runtime/bun/darwin-${arch}'
    )
  )
  assert.ok(
    config.linux.extraResources.some(
      (entry: { from?: string; to?: string }) =>
        entry.from === 'resources/runtime/bun/linux-${arch}' &&
        entry.to === 'runtime/bun/linux-${arch}'
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

test('Linux afterPack rejects a missing or non-executable x64 Bun', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-linux-packaged-bun-'))
  const bunPath = path.join(root, 'runtime', 'bun', 'linux-x64', 'bun')
  const context = {
    appOutDir: root,
    // electron-builder passes its Arch enum; x64 is index 1.
    arch: 1,
    electronPlatformName: 'linux',
    packager: { getResourcesDir: () => root }
  }
  try {
    await assert.rejects(() => afterPack(context), /missing bundled Bun.*linux-x64/u)
    mkdirSync(path.dirname(bunPath), { recursive: true })
    writeFileSync(bunPath, '#!/bin/sh\n')
    await assert.rejects(() => afterPack(context), /not executable.*linux-x64/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime worker closure follows value imports beyond the old hand-maintained list', () => {
  const { files, packages } = collectOmpWorkerSources(repoRoot)
  for (const expected of [
    'src/main/agent/engine/in-process/main.ts',
    'src/main/agent/engine/rpc/desktop-websearch-worker.ts',
    'src/main/agent/engine/phi-extension/index.ts',
    'src/main/agent/engine/phi-extension/extensions/next-action.ts',
    'src/main/agent/engine/tool-adapter.ts',
    'src/main/agent/runtime-paths.ts'
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
      'src/main/agent/engine/in-process/main.ts',
      "import { a } from '../../a'\nimport type { T } from '../../../../shared/t'\nimport 'yaml'\n"
    )
    write(
      'src/main/agent/engine/rpc/desktop-websearch-worker.ts',
      "import { search } from './desktop-websearch-owned'\nimport 'search-package'\n"
    )
    write('src/main/agent/engine/rpc/desktop-websearch-owned.ts', 'export const search = 1\n')
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
      'out/main/agent/engine/in-process/main.ts',
      'out/main/agent/engine/rpc/desktop-websearch-owned.ts',
      'out/main/agent/engine/rpc/desktop-websearch-worker.ts',
      'out/main/agent/nested/b.ts',
      'out/main/agent/nested/c.ts'
    ])
    assert.deepEqual(collectOmpWorkerSources(root).packages, ['search-package', 'yaml'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('glob matching flags the old single-file worker glob as insufficient', () => {
  assert.ok(globToRegExp('node_modules/@scope/**').test('node_modules/@scope/pkg/package.json'))
  assert.ok(!globToRegExp('out/*.ts').test('out/main/x.ts'))
  assert.deepEqual(
    uncoveredPaths(
      ['out/main/worker.ts'],
      ['out/main/agent/engine/in-process/main.ts', 'out/main/agent/runtime-paths.ts']
    ),
    ['out/main/agent/engine/in-process/main.ts', 'out/main/agent/runtime-paths.ts']
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

test('every worker entry is mandatory and second-entry dependencies/assets share the same closure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-search-closure-'))
  const write = (relative: string, body: string): void => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    writeFileSync(path.join(root, relative), body)
  }
  try {
    write('src/main/agent/engine/in-process/main.ts', 'export {}')
    assert.throws(() => collectOmpWorkerSources(root), /desktop-websearch-worker/u)
    write('src/main/agent/engine/rpc/desktop-websearch-worker.ts', "import 'search-package'")
    assert.throws(() => collectOmpWorkerPackageDirs(root), /search-package/u)
    write(
      'node_modules/search-package/package.json',
      JSON.stringify({ dependencies: { 'search-dependency': '1' } })
    )
    assert.throws(() => collectOmpWorkerPackageDirs(root), /search-dependency/u)
    write('node_modules/search-dependency/package.json', '{}')
    write(
      'node_modules/search-package/index.ts',
      "import prompt from './prompt.md' with { type: 'text' }"
    )
    write(
      'node_modules/search-package/multiline.ts',
      `const n = 1; import asset from './prompt.md' with\n{ type: 'text' };`
    )
    write('node_modules/search-package/prompt.md', 'owned search prompt')
    write(
      'node_modules/search-package/comment.ts',
      '/**\n * import example from "./missing-example.json" with { type: "json" }\n */'
    )
    assert.deepEqual(collectOmpWorkerPackageAssets(root), ['node_modules/search-package/prompt.md'])
    assert.deepEqual(collectOmpWorkerPackageDirs(root), [
      'node_modules/search-dependency',
      'node_modules/search-package'
    ])
    rmSync(path.join(root, 'node_modules/search-package/prompt.md'))
    assert.throws(() => collectOmpWorkerPackageAssets(root), /prompt.md/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime closure erases only explicit type edges and keeps value, mixed, side-effect and dynamic imports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phi-runtime-closure-'))
  const write = (relative: string, source: string): void => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    writeFileSync(path.join(root, relative), source)
  }
  try {
    write(
      'src/main/agent/engine/in-process/main.ts',
      `
      import type { Approval } from './missing-types'
      import type from 'default-type-value'
      import { type A, type B } from 'erased-named'
      import { type A, live } from 'mixed-value'
      import Default, { type A } from 'default-plus-types'
      import {} from 'empty-side-effect'
      import 'side-effect'
      import {
 live
} from 'multiline-value'
      export type { Type } from 'erased-export'
      export { type Type } from 'erased-export-named'
      export { type Type, live } from 'mixed-export'
      export * from 'export-star'
      type T = typeof import('erased-import-type')
      const dynamic = import('dynamic-runtime')
      const template = import(\`dynamic-template-runtime\`)
      import required = require('required-runtime')
      import type ErasedRequired = require('erased-required')
      /* import bad from './missing-comment' */
      // import 'missing-comment-sideeffect'
    `
    )
    write('src/main/agent/engine/rpc/desktop-websearch-worker.ts', `import './runtime-value'`)
    write('src/main/agent/engine/rpc/runtime-value.ts', 'export const live = true')
    const closure = collectOmpWorkerSources(root)
    assert.deepEqual(closure.packages, [
      'default-plus-types',
      'default-type-value',
      'dynamic-runtime',
      'dynamic-template-runtime',
      'empty-side-effect',
      'export-star',
      'mixed-export',
      'mixed-value',
      'multiline-value',
      'required-runtime',
      'side-effect'
    ])
    assert.equal(closure.files.includes('src/main/agent/engine/rpc/runtime-value.ts'), true)
    assert.throws(() => collectOmpWorkerPackageDirs(root), /default-type-value/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
