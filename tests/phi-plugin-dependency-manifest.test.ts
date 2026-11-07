import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readPhiPluginDependencyManifest } from '../src/main/agent/plugins/dependency-manifest'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): { root: string; plugin: string; environments: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-plugin-dependencies-'))
  roots.push(root)
  const plugin = join(root, 'plugin')
  const environments = join(root, 'resources', 'runtime', 'environments')
  mkdirSync(plugin, { recursive: true })
  mkdirSync(environments, { recursive: true })
  return { root, plugin, environments }
}

function read(
  state: ReturnType<typeof fixture>,
  environmentRef = 'plugin:analysis',
  explicitManifest?: string
): ReturnType<typeof readPhiPluginDependencyManifest> {
  return readPhiPluginDependencyManifest({
    pluginDir: state.plugin,
    environmentRef,
    ...(explicitManifest ? { explicitManifest } : {}),
    bundledEnvironmentsDir: state.environments
  })
}

test('environment YAML parses conda, pip and source packages', () => {
  const state = fixture()
  writeFileSync(
    join(state.plugin, 'environment.yml'),
    [
      'channels:',
      '  - conda-forge',
      'dependencies:',
      '  - python=3.12',
      '  - conda: coreutils',
      '    platforms: [linux-x64]',
      '  - pip:',
      '      - httpx>=0.28',
      'sourcePackages:',
      '  - name: demo-source',
      '    repo: owner/repo',
      '    ref: abcdef1234567890'
    ].join('\n')
  )

  const result = read(state)

  assert.deepEqual(result.channels, ['conda-forge'])
  assert.deepEqual(result.dependencyManifest.dependencies, [
    { name: 'python', version: '3.12', kind: 'conda' },
    { name: 'coreutils', kind: 'conda' },
    { name: 'httpx', version: '0.28', kind: 'pip' },
    {
      name: 'demo-source',
      version: 'abcdef1234567890',
      kind: 'source',
      note: 'github:owner/repo'
    }
  ])
  assert.equal(result.dependencyManifest.sourceFile, 'environment.yml')
  assert.match(result.dependencyManifest.yamlText ?? '', /sourcePackages:/)
})

test('JSON, DESCRIPTION and conda-lock formats expose only declared packages', async (t) => {
  await t.test('package.json dependencies and peer dependencies', () => {
    const state = fixture()
    writeFileSync(
      join(state.plugin, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' }, peerDependencies: { vite: '^7.0.0' } })
    )
    assert.deepEqual(read(state).dependencyManifest.dependencies, [
      { name: 'react', version: '^19.0.0', kind: 'other', note: 'npm' },
      { name: 'vite', version: '^7.0.0', kind: 'other', note: 'npm peer' }
    ])
  })

  await t.test('renv.lock packages', () => {
    const state = fixture()
    writeFileSync(
      join(state.plugin, 'renv.lock'),
      JSON.stringify({
        Packages: {
          R: { Version: '4.5.0' },
          renv: { Version: '1.1.0' },
          ggplot2: { Version: '4.0.0', Source: 'Repository' }
        }
      })
    )
    assert.deepEqual(read(state).dependencyManifest.dependencies, [
      { name: 'ggplot2', version: '4.0.0', kind: 'other', note: 'Repository' }
    ])
  })

  await t.test('DESCRIPTION Depends and Imports', () => {
    const state = fixture()
    writeFileSync(
      join(state.plugin, 'DESCRIPTION'),
      'Package: demo\nDepends: R (>= 4.4),\n  methods\nImports: ggplot2 (>= 3.5), jsonlite\nSuggests: testthat\n'
    )
    assert.deepEqual(read(state).dependencyManifest.dependencies, [
      { name: 'methods', kind: 'other', note: 'DESCRIPTION' },
      { name: 'ggplot2', version: '>= 3.5', kind: 'other', note: 'DESCRIPTION' },
      { name: 'jsonlite', kind: 'other', note: 'DESCRIPTION' }
    ])
  })

  await t.test('conda-lock package records', () => {
    const state = fixture()
    writeFileSync(
      join(state.plugin, 'conda-lock.yml'),
      'package:\n  - name: python\n    version: 3.12.8\n    manager: conda\n  - name: httpx\n    version: 0.28.1\n    manager: pip\n'
    )
    assert.deepEqual(read(state).dependencyManifest.dependencies, [
      { name: 'python', version: '3.12.8', kind: 'conda' },
      { name: 'httpx', version: '0.28.1', kind: 'pip' }
    ])
  })
})

test('explicit declarations precede package-root manifests and shared runtime comes last', () => {
  const state = fixture()
  const explicit = join(state.plugin, 'skills', 'demo', 'environment.yml')
  mkdirSync(join(state.plugin, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(state.plugin, 'environment.yml'), 'dependencies:\n  - root-package\n')
  writeFileSync(explicit, 'dependencies:\n  - explicit-package\n')
  mkdirSync(join(state.environments, 'phi-python'), { recursive: true })
  writeFileSync(
    join(state.environments, 'phi-python', 'environment.yml'),
    'dependencies:\n  - shared-package\n'
  )

  const explicitResult = read(state, './environment.yml', explicit)
  assert.deepEqual(explicitResult.dependencyManifest.dependencies, [
    { name: 'explicit-package', kind: 'conda' }
  ])
  assert.equal(explicitResult.dependencyManifest.lookedFor[0], 'skills/demo/environment.yml')

  rmSync(explicit)
  rmSync(join(state.plugin, 'environment.yml'))
  const sharedResult = read(state, 'phi:python@1')
  assert.deepEqual(sharedResult.dependencyManifest.dependencies, [
    { name: 'shared-package', kind: 'conda' }
  ])
  assert.equal(
    sharedResult.dependencyManifest.sourceFile,
    'resources/runtime/environments/phi-python/environment.yml'
  )
})

test('manifest fields distinguish package, shared-runtime, empty-manifest and missing states', () => {
  const packages = fixture()
  writeFileSync(join(packages.plugin, 'environment.yml'), 'dependencies:\n  - python\n')
  const packageManifest = read(packages).dependencyManifest
  assert.equal(packageManifest.dependencies.length, 1)
  assert.equal(packageManifest.sourceFile, 'environment.yml')

  const empty = fixture()
  writeFileSync(join(empty.plugin, 'environment.yml'), 'dependencies: []\n')
  const emptyManifest = read(empty).dependencyManifest
  assert.deepEqual(emptyManifest.dependencies, [])
  assert.equal(emptyManifest.sourceFile, 'environment.yml')

  const shared = fixture()
  const sharedManifest = read(shared, 'phi:r@1').dependencyManifest
  assert.deepEqual(sharedManifest.dependencies, [])
  assert.equal(sharedManifest.sourceFile, undefined)
  assert.ok(
    sharedManifest.lookedFor.includes('resources/runtime/environments/phi-r/environment.yml')
  )

  const missing = fixture()
  const missingManifest = read(missing, 'plugin:analysis').dependencyManifest
  assert.deepEqual(missingManifest.dependencies, [])
  assert.equal(missingManifest.sourceFile, undefined)
  assert.deepEqual(missingManifest.lookedFor.slice(0, 2), ['environment.yml', 'environment.yaml'])
})
