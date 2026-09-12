import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('ensureBundledWrappersInstalled installs the fastq-qc fixture as bundled and is idempotent', () => {
  withAgentDir((agentDir) => {
    const first = ensureBundledWrappersInstalled(agentDir)
    assert.equal(first.length, 1)
    assert.equal(first[0].manifest.id, 'phi/ngs/fastq-qc')
    assert.equal(first[0].trustTier, 'bundled')

    const second = ensureBundledWrappersInstalled(agentDir)
    assert.equal(second.length, 1)
    assert.equal(second[0].installedAt, first[0].installedAt)

    const catalog = listWrapperCatalog(agentDir)
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].trustTier, 'bundled')
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

test('a custom wrapper is never returned by the default agent tools query', () => {
  withAgentDir((agentDir) => {
    ensureBundledWrappersInstalled(agentDir)
    const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-custom-wrapper-'))
    try {
      writeCustomWrapperFixture(sourceRoot)
      addCustomWrapper(sourceRoot, agentDir)

      const defaults = listDefaultAgentToolWrappers(agentDir)
      assert.deepEqual(
        defaults.map((entry) => entry.manifest.id),
        ['phi/ngs/fastq-qc']
      )
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
