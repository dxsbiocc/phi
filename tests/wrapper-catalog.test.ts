import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  addCustomWrapper,
  ensureBundledWrappersInstalled,
  findWrapperCatalogEntry,
  listDefaultAgentToolWrappers,
  listWrapperCatalog
} from '../src/main/agent/wrappers/catalog'

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
resources:
  defaults:
    cpus: 1
`,
    'utf-8'
  )
}

test('ensureBundledWrappersInstalled is empty after bundled packages move to composition discovery', () => {
  withAgentDir((agentDir) => {
    const first = ensureBundledWrappersInstalled(agentDir)
    assert.deepEqual(first, [])

    const second = ensureBundledWrappersInstalled(agentDir)
    assert.deepEqual(second, [])

    const catalog = listWrapperCatalog(agentDir)
    assert.deepEqual(catalog, [])
  })
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
    ensureBundledWrappersInstalled(agentDir)
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
