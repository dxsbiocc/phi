import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addCustomWrapper,
  BUNDLED_WRAPPER_SOURCE_FINGERPRINT,
  ensureBundledWrappersInstalled,
  fingerprintBundledWrapperSource,
  findWrapperCatalogEntry,
  getBundledWrapperPackagesDir,
  listDefaultAgentToolWrappers,
  listWrapperCatalog,
  migrateLegacyCustomWrappers
} from '../src/main/agent/wrappers/catalog'
import { buildLegacyWrapperPackIndex } from '../src/main/agent/wrappers/legacy-pack-migration'
import {
  listWrapperCompositionCatalog,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'

function withAgentDir<T>(callback: (agentDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-catalog-'))
  const agentDir = join(root, '.phi-home')
  try {
    return callback(agentDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeCustomWrapperFixture(
  dir: string,
  overrides: { id?: string; version?: string } = {}
): void {
  const id = overrides.id ?? 'acme/tools/toy-wrapper'
  const version = overrides.version ?? '0.1.0'
  writeFileSync(
    join(dir, 'wrapper.yaml'),
    `phiWrapperVersion: 1
id: ${id}
shortId: toy-wrapper
name: Toy Wrapper
version: ${version}
summary: A tiny wrapper for tests.
runtime:
  minVersion: 1.0.0
  maxVersion: 1.x
resourceClass: light
engine:
  type: nextflow
  entrypoint: main.nf
  profiles:
    - id: local
      executor: local
inputs: []
parameters:
  schema:
    type: object
    properties: {}
outputs:
  - id: report
    label: Report
    type: html
    path: results/report.html
    primary: true
resources:
  defaults:
    cpus: 1
`,
    'utf-8'
  )
  writeFileSync(join(dir, 'main.nf'), 'workflow {}\n')
}

function writeBundledCompositionFixture(root: string, main = 'workflow {}\n'): void {
  writeBundledModuleFixture(root, 'toy', main)
}

function writeBundledModuleFixture(root: string, name: string, main = 'workflow {}\n'): void {
  const wrapper = join(root, 'modules', 'acme', name, 'wrapper')
  mkdirSync(wrapper, { recursive: true })
  writeFileSync(join(wrapper, 'main.nf'), main)
  writeFileSync(join(wrapper, 'params.json'), '{}\n')
  writeFileSync(
    join(wrapper, 'wrapper.yaml'),
    `id: acme/modules/${name}
name: ${name}
summary: Small bundled wrapper fixture.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
  )
}

test('bundled wrapper source fingerprint matches the shipped wrapper tree', () => {
  assert.equal(
    fingerprintBundledWrapperSource(getBundledWrapperPackagesDir()),
    BUNDLED_WRAPPER_SOURCE_FINGERPRINT
  )
})

test('Finder metadata does not change a bundled wrapper source fingerprint', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-fingerprint-'))
  try {
    writeBundledCompositionFixture(root)
    const expected = fingerprintBundledWrapperSource(root)
    writeFileSync(join(root, '.DS_Store'), 'Finder root metadata')
    writeFileSync(join(root, 'modules', '.DS_Store'), 'Finder module metadata')
    assert.equal(fingerprintBundledWrapperSource(root), expected)
    writeFileSync(
      join(root, 'modules', 'acme', 'toy', 'wrapper', 'main.nf'),
      'workflow { changed }\n'
    )
    assert.notEqual(fingerprintBundledWrapperSource(root), expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startup migration preserves custom wrappers without installing the bundled catalogue', () => {
  withAgentDir((agentDir) => {
    assert.deepEqual(migrateLegacyCustomWrappers(agentDir), [])
    assert.equal(existsSync(join(agentDir, 'wrappers', 'tree.json')), false)
    assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])

    const customSource = join(agentDir, 'custom-source')
    mkdirSync(customSource, { recursive: true })
    writeCustomWrapperFixture(customSource)
    addCustomWrapper(customSource, agentDir)
    assert.deepEqual(migrateLegacyCustomWrappers(agentDir), ['acme/tools/toy-wrapper'])
    assert.deepEqual(migrateLegacyCustomWrappers(agentDir), [])
    resetWrapperCompositionCatalogCache()
    assert.deepEqual(
      listWrapperCompositionCatalog({ agentDir }).map((entry) => entry.manifest.id),
      ['acme/modules/toy-wrapper']
    )
    assert.equal(existsSync(join(agentDir, 'wrappers', 'tree.json')), false)
  })
})

test('bundled wrapper packages install idempotently into the assembled tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-bundled-wrapper-'))
  const agentDir = join(root, 'agent')
  const sourceRoot = join(root, 'source')
  try {
    writeBundledCompositionFixture(sourceRoot)
    const first = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      generatedAt: '2026-10-02T00:00:00.000Z'
    })
    assert.deepEqual(first.installed, ['module-acme-toy'])
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/main.nf'), 'utf8'),
      'workflow {}\n'
    )

    const second = await ensureBundledWrappersInstalled(agentDir, { sourceRoot })
    assert.deepEqual(second.installed, [])
    assert.equal(second.packages.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bundled wrapper packages skip unchanged payloads across app-version bumps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-bundled-wrapper-version-bump-'))
  const agentDir = join(root, 'agent')
  const sourceRoot = join(root, 'source')
  try {
    writeBundledCompositionFixture(sourceRoot)
    await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.0.0'
    })
    const before = readFileSync(join(agentDir, 'wrappers', 'tree.json'), 'utf8')

    const bumped = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.1.0'
    })

    assert.deepEqual(bumped.installed, [])
    assert.equal(bumped.packages[0]?.version, '1.0.0')
    assert.equal(readFileSync(join(agentDir, 'wrappers', 'tree.json'), 'utf8'), before)

    rmSync(join(sourceRoot, 'modules', 'acme', 'toy'), { recursive: true, force: true })
    const removed = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.2.0'
    })
    assert.deepEqual(removed.removed, ['module-acme-toy'])
    assert.deepEqual(removed.packages, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bundled wrapper app-version bump reinstalls only the changed package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-bundled-wrapper-partial-bump-'))
  const agentDir = join(root, 'agent')
  const sourceRoot = join(root, 'source')
  try {
    writeBundledCompositionFixture(sourceRoot, 'workflow { v1 }\n')
    writeBundledModuleFixture(sourceRoot, 'steady')
    await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.0.0'
    })
    const before = JSON.parse(readFileSync(join(agentDir, 'wrappers', 'tree.json'), 'utf8')) as {
      packages: Record<string, { version: string; source: { sha256: string } }>
    }

    writeBundledCompositionFixture(sourceRoot, 'workflow { v2 }\n')
    const bumped = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.1.0'
    })
    const after = JSON.parse(readFileSync(join(agentDir, 'wrappers', 'tree.json'), 'utf8')) as {
      packages: Record<string, { version: string; source: { sha256: string } }>
    }

    assert.deepEqual(bumped.installed, ['module-acme-toy'])
    assert.equal(after.packages['module-acme-toy'].version, '1.1.0')
    assert.notEqual(
      after.packages['module-acme-toy'].source.sha256,
      before.packages['module-acme-toy'].source.sha256
    )
    assert.equal(after.packages['module-acme-steady'].version, '1.0.0')
    assert.equal(
      after.packages['module-acme-steady'].source.sha256,
      before.packages['module-acme-steady'].source.sha256
    )
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/main.nf'), 'utf8'),
      'workflow { v2 }\n'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bundled migration converts the newest valid overlay and preserves custom wrappers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-pack-migration-'))
  const agentDir = join(root, 'agent')
  const sourceRoot = join(root, 'source')
  const legacyCustomSource = join(root, 'legacy-custom')
  const oldPackRoot = join(agentDir, 'wrappers', 'packs', '9.9.9')
  const custom = join(agentDir, 'wrappers', 'custom', 'notes.txt')
  try {
    writeBundledCompositionFixture(sourceRoot, 'workflow { v1 }\n')
    const retiredWrapper = join(sourceRoot, 'modules', 'acme', 'retired', 'wrapper')
    mkdirSync(retiredWrapper, { recursive: true })
    writeFileSync(join(retiredWrapper, 'main.nf'), 'workflow {}\n')
    writeFileSync(join(retiredWrapper, 'params.json'), '{}\n')
    writeFileSync(
      join(retiredWrapper, 'wrapper.yaml'),
      `id: acme/modules/retired
name: Retired
summary: Package removed by the next bundled version.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
    )
    mkdirSync(legacyCustomSource, { recursive: true })
    writeCustomWrapperFixture(legacyCustomSource)
    addCustomWrapper(legacyCustomSource, agentDir)
    writeBundledCompositionFixture(oldPackRoot, 'workflow { overlay }\n')
    writeFileSync(
      join(oldPackRoot, 'modules', 'acme', 'toy', 'wrapper', 'params.json'),
      '{"threads": 2}\n'
    )
    writeFileSync(
      join(oldPackRoot, 'modules', 'acme', 'toy', 'wrapper', 'wrapper.yaml'),
      `id: acme/modules/toy
name: Toy
summary: Legacy default migration fixture.
params:
  threads:
    kind: option
    type: integer
    default: 2
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
    )
    const overlayRetired = join(oldPackRoot, 'modules', 'acme', 'retired', 'wrapper')
    mkdirSync(overlayRetired, { recursive: true })
    writeFileSync(join(overlayRetired, 'main.nf'), 'workflow {}\n')
    writeFileSync(join(overlayRetired, 'params.json'), '{}\n')
    writeFileSync(
      join(overlayRetired, 'wrapper.yaml'),
      `id: acme/modules/retired
name: Retired
summary: Package removed by the next bundled version.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
    )
    const overlaySubworkflow = join(oldPackRoot, 'subworkflows', 'acme', 'retired_flow')
    mkdirSync(join(overlaySubworkflow, 'wrapper'), { recursive: true })
    writeFileSync(
      join(overlaySubworkflow, 'main.nf'),
      "include { RETIRED } from '../../../modules/acme/retired/wrapper/main.nf'\nworkflow {}\n"
    )
    writeFileSync(
      join(overlaySubworkflow, 'wrapper', 'main.nf'),
      "include { RUN } from '../main.nf'\n"
    )
    writeFileSync(join(overlaySubworkflow, 'wrapper', 'params.json'), '{}\n')
    writeFileSync(
      join(overlaySubworkflow, 'wrapper', 'wrapper.yaml'),
      `id: acme/subworkflows/retired-flow
name: Retired flow
summary: Dependent package removed by the next bundled version.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
    )
    writeFileSync(
      join(oldPackRoot, 'pack.json'),
      `${JSON.stringify({ schemaVersion: 1, name: 'phi-wrappers', version: '9.9.9' })}\n`
    )
    writeFileSync(
      join(oldPackRoot, 'index.json'),
      `${JSON.stringify(buildLegacyWrapperPackIndex(oldPackRoot), null, 2)}\n`
    )
    mkdirSync(join(custom, '..'), { recursive: true })
    writeFileSync(custom, 'user-authored\n')
    const migrated = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.0.0'
    })
    assert.equal(migrated.migratedPackVersion, '9.9.9')
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/main.nf'), 'utf8'),
      'workflow { overlay }\n'
    )
    assert.doesNotMatch(
      readFileSync(
        join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/wrapper.yaml'),
        'utf8'
      ),
      /default:/
    )
    assert.deepEqual(migrated.migratedCustom, ['acme/tools/toy-wrapper'])
    assert.equal(
      existsSync(
        join(
          agentDir,
          'wrappers',
          'custom',
          'modules',
          'acme',
          'toy-wrapper',
          'wrapper',
          'wrapper.yaml'
        )
      ),
      true
    )
    resetWrapperCompositionCatalogCache()
    assert.ok(
      listWrapperCompositionCatalog({ agentDir }).some(
        (entry) => entry.manifest.id === 'acme/modules/toy-wrapper'
      )
    )

    writeBundledCompositionFixture(sourceRoot, 'workflow { v2 }\n')
    rmSync(join(sourceRoot, 'modules', 'acme', 'retired'), { recursive: true, force: true })
    const upgraded = await ensureBundledWrappersInstalled(agentDir, {
      sourceRoot,
      packageVersion: '1.1.0'
    })
    assert.deepEqual(upgraded.installed, ['module-acme-toy'])
    assert.deepEqual(upgraded.removed, ['module-acme-retired', 'subworkflow-acme-retired-flow'])
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/main.nf'), 'utf8'),
      'workflow { v2 }\n'
    )
    assert.equal(readFileSync(custom, 'utf8'), 'user-authored\n')
    assert.equal(existsSync(join(oldPackRoot, 'index.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an intact but incompatible legacy overlay falls back to bundled source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-pack-fallback-'))
  const agentDir = join(root, 'agent')
  const sourceRoot = join(root, 'source')
  const overlayRoot = join(agentDir, 'wrappers', 'packs', '2.0.0')
  try {
    writeBundledCompositionFixture(sourceRoot, 'workflow { bundled }\n')
    writeBundledCompositionFixture(
      overlayRoot,
      "include { GONE } from '../missing/main.nf'\nworkflow {}\n"
    )
    writeFileSync(
      join(overlayRoot, 'pack.json'),
      `${JSON.stringify({ schemaVersion: 1, name: 'phi-wrappers', version: '2.0.0' })}\n`
    )
    writeFileSync(
      join(overlayRoot, 'index.json'),
      `${JSON.stringify(buildLegacyWrapperPackIndex(overlayRoot), null, 2)}\n`
    )

    const result = await ensureBundledWrappersInstalled(agentDir, { sourceRoot })
    assert.equal(result.migratedPackVersion, undefined)
    assert.ok(result.legacyPackWarnings.some((warning) => /conversion failed/.test(warning.reason)))
    assert.equal(
      readFileSync(join(agentDir, 'wrappers', 'tree', 'modules/acme/toy/wrapper/main.nf'), 'utf8'),
      'workflow { bundled }\n'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('addCustomWrapper installs a local wrapper folder as custom', () => {
  withAgentDir((agentDir) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-custom-wrapper-'))
    try {
      writeCustomWrapperFixture(sourceRoot)
      const entry = addCustomWrapper(sourceRoot, agentDir)
      assert.equal(entry.trustTier, 'custom')
      assert.equal(entry.manifest.id, 'acme/tools/toy-wrapper')

      const found = findWrapperCatalogEntry('acme/tools/toy-wrapper', '0.1.0', agentDir)
      assert.equal(found?.trustTier, 'custom')
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})

test("addCustomWrapper copies the wrapper's real pipeline source, not just wrapper.yaml, and excludes .git", () => {
  withAgentDir((agentDir) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-custom-wrapper-'))
    try {
      writeCustomWrapperFixture(sourceRoot)
      mkdirSync(join(sourceRoot, 'workflows'), { recursive: true })
      writeFileSync(join(sourceRoot, 'main.nf'), '#!/usr/bin/env nextflow\n')
      writeFileSync(join(sourceRoot, 'workflows', 'sub.nf'), '// subworkflow\n')
      mkdirSync(join(sourceRoot, '.git'), { recursive: true })
      writeFileSync(join(sourceRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n')

      const entry = addCustomWrapper(sourceRoot, agentDir)

      assert.equal(
        readFileSync(join(entry.installedPath, 'main.nf'), 'utf-8'),
        '#!/usr/bin/env nextflow\n'
      )
      assert.equal(
        readFileSync(join(entry.installedPath, 'workflows', 'sub.nf'), 'utf-8'),
        '// subworkflow\n'
      )
      assert.equal(existsSync(join(entry.installedPath, '.git')), false)
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})

test('a custom wrapper is never returned by the default agent tools query', () => {
  withAgentDir((agentDir) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-custom-wrapper-'))
    try {
      writeCustomWrapperFixture(sourceRoot)
      addCustomWrapper(sourceRoot, agentDir)

      const defaults = listDefaultAgentToolWrappers(agentDir)
      assert.deepEqual(defaults.map((entry) => entry.manifest.id).sort(), [])
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})

test('two versions of the same canonical id coexist in the catalog', () => {
  withAgentDir((agentDir) => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-custom-wrapper-'))
    try {
      writeCustomWrapperFixture(sourceRoot, { version: '0.1.0' })
      addCustomWrapper(sourceRoot, agentDir)
      writeCustomWrapperFixture(sourceRoot, { version: '0.2.0' })
      addCustomWrapper(sourceRoot, agentDir)

      const versions = listWrapperCatalog(agentDir)
        .filter((entry) => entry.manifest.id === 'acme/tools/toy-wrapper')
        .map((entry) => entry.manifest.version)
        .sort()
      assert.deepEqual(versions, ['0.1.0', '0.2.0'])
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})
