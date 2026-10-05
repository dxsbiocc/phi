import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { setEnabled } from '../src/main/agent/enablement'
import {
  listWrapperCompositionCatalog,
  listWrapperCompositionCatalogStatus,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { buildWrapperCompositionSearchTool } from '../src/main/agent/wrappers/composition/tools'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'

const roots: string[] = []

test.afterEach(() => {
  resetWrapperCompositionCatalogCache()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function wrapperYaml(id: string): string {
  return `id: ${id}
name: ${id.split('/').at(-1)}
summary: Test wrapper for package-aware discovery.
params: {}
outputs:
  report:
    type: path
    path: results/report.txt
    primary: true
`
}

function source(id: string, automaticallyInstalled = false): Record<string, unknown> {
  return {
    registry: automaticallyInstalled ? 'bundled-wrappers' : 'builtin',
    id,
    type: 'wrapper',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-10-02T00:00:00.000Z',
    installedBy: 'user'
  }
}

function fixture(automaticallyInstalled = false): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-discovery-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const tree = join(agentDir, 'wrappers', 'tree')
  const moduleYaml = 'modules/nf-core/fastqc/wrapper/wrapper.yaml'
  const moduleMain = 'modules/nf-core/fastqc/wrapper/main.nf'
  const subworkflowYaml = 'subworkflows/nf-core/qc/wrapper/wrapper.yaml'
  const subworkflowMain = 'subworkflows/nf-core/qc/wrapper/main.nf'
  write(join(tree, moduleYaml), wrapperYaml('nf-core/modules/fastqc'))
  write(join(tree, moduleMain), 'workflow {}\n')
  write(join(tree, 'modules/nf-core/fastqc/wrapper/params.json'), '{}\n')
  write(join(tree, subworkflowYaml), wrapperYaml('nf-core/subworkflows/qc'))
  write(
    join(tree, subworkflowMain),
    "include { FASTQC } from '../../../../modules/nf-core/fastqc/main.nf'\nworkflow {}\n"
  )
  write(join(tree, 'subworkflows/nf-core/qc/wrapper/params.json'), '{}\n')

  const moduleId = 'module-nf-core-fastqc'
  const subworkflowId = 'subworkflow-nf-core-qc'
  write(
    join(agentDir, 'wrappers', 'tree.json'),
    `${JSON.stringify(
      {
        version: 1,
        packages: {
          [moduleId]: {
            version: '1.0.0',
            title: 'FastQC',
            summary: 'FastQC family.',
            manifest: {
              schemaVersion: 1,
              id: moduleId,
              type: 'wrapper',
              version: '1.0.0',
              title: 'FastQC',
              summary: 'FastQC family.',
              dependsOn: [],
              files: 'files.json'
            },
            source: source(moduleId, automaticallyInstalled),
            paths: [
              'modules/nf-core/fastqc/wrapper/main.nf',
              'modules/nf-core/fastqc/wrapper/params.json',
              moduleYaml
            ].sort()
          },
          [subworkflowId]: {
            version: '1.0.0',
            title: 'QC',
            summary: 'QC subworkflow.',
            manifest: {
              schemaVersion: 1,
              id: subworkflowId,
              type: 'wrapper',
              version: '1.0.0',
              title: 'QC',
              summary: 'QC subworkflow.',
              dependsOn: [{ id: moduleId, type: 'wrapper', version: '^1.0.0' }],
              files: 'files.json'
            },
            source: source(subworkflowId, automaticallyInstalled),
            paths: [
              'subworkflows/nf-core/qc/wrapper/main.nf',
              'subworkflows/nf-core/qc/wrapper/params.json',
              subworkflowYaml
            ].sort()
          }
        }
      },
      null,
      2
    )}\n`
  )
  return agentDir
}

test('agent discovery hides disabled packages and enabled dependents with a UI reason', () => {
  const agentDir = fixture()
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir })
  resetWrapperCompositionCatalogCache()

  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  const status = listWrapperCompositionCatalogStatus({ agentDir })
  assert.equal(status.length, 2)
  const module = status.find((entry) => entry.id === 'nf-core/modules/fastqc')
  const subworkflow = status.find((entry) => entry.id === 'nf-core/subworkflows/qc')
  assert.equal(module?.packageEnabled, false)
  assert.match(module?.hiddenReason ?? '', /module-nf-core-fastqc 已停用/)
  assert.equal(subworkflow?.packageEnabled, true)
  assert.match(subworkflow?.hiddenReason ?? '', /依赖 module-nf-core-fastqc 不可用.*已停用/)
})

test('custom wrappers remain visible outside package ownership and enablement', () => {
  const agentDir = fixture()
  const custom = join(agentDir, 'wrappers', 'custom', 'modules', 'acme', 'toy', 'wrapper')
  write(join(custom, 'wrapper.yaml'), wrapperYaml('acme/modules/toy'))
  write(join(custom, 'main.nf'), 'workflow {}\n')
  write(join(custom, 'params.json'), '{}\n')
  resetWrapperCompositionCatalogCache()

  const visible = listWrapperCompositionCatalog({ agentDir })
  assert.ok(visible.some((entry) => entry.manifest.id === 'acme/modules/toy'))
  const item = listWrapperCompositionCatalogStatus({ agentDir }).find(
    (entry) => entry.id === 'acme/modules/toy'
  )
  assert.equal(item?.packageId, undefined)
  assert.match(item?.enablementId ?? '', /^custom-[a-f0-9]{24}$/)
  assert.equal(item?.packageEnabled, true)
  assert.equal(item?.packageSelected, true)
  assert.equal(item?.hiddenReason, undefined)
})

test('untouched automatically bundled packages remain cached without becoming agent tools', () => {
  const agentDir = fixture(true)
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  const status = listWrapperCompositionCatalogStatus({ agentDir })
  assert.equal(status.length, 2)
  assert.ok(status.every((entry) => entry.packageEnabled === false))
  assert.ok(status.every((entry) => entry.packageSelected === false))
  assert.ok(status.every((entry) => entry.enablementId === entry.packageId))
})

test('selecting a cached bundled root makes only its dependency closure available', () => {
  const agentDir = fixture(true)
  setEnabled('wrapper:subworkflow-nf-core-qc', true, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.equal(listWrapperCompositionCatalog({ agentDir }).length, 2)
  assert.ok(
    listWrapperCompositionCatalogStatus({ agentDir }).every(
      (entry) => entry.packageSelected === true && entry.packageEnabled === true
    )
  )

  setEnabled('wrapper:subworkflow-nf-core-qc', false, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  const status = listWrapperCompositionCatalogStatus({ agentDir })
  assert.equal(
    status.find((entry) => entry.packageId === 'subworkflow-nf-core-qc')?.packageSelected,
    true
  )
  assert.equal(
    status.find((entry) => entry.packageId === 'module-nf-core-fastqc')?.packageSelected,
    false
  )
})

test('selecting one bundled module does not expose unrelated bundled roots', () => {
  const agentDir = fixture(true)
  setEnabled('wrapper:module-nf-core-fastqc', true, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.deepEqual(
    listWrapperCompositionCatalog({ agentDir }).map((entry) => entry.manifest.id),
    ['nf-core/modules/fastqc']
  )
  assert.equal(
    listWrapperCompositionCatalogStatus({ agentDir }).find(
      (entry) => entry.packageId === 'subworkflow-nf-core-qc'
    )?.packageSelected,
    false
  )
})

test('a running agent observes user enablement changes without a host cache reset', () => {
  const agentDir = fixture(true)
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  setEnabled('wrapper:module-nf-core-fastqc', true, { agentDir })
  assert.deepEqual(
    listWrapperCompositionCatalog({ agentDir }).map((entry) => entry.manifest.id),
    ['nf-core/modules/fastqc']
  )
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir })
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
})

test('an explicit disabled dependency blocks an opted-in root', () => {
  const agentDir = fixture(true)
  setEnabled('wrapper:subworkflow-nf-core-qc', true, { agentDir })
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  const root = listWrapperCompositionCatalogStatus({ agentDir }).find(
    (entry) => entry.packageId === 'subworkflow-nf-core-qc'
  )
  assert.equal(root?.packageEnabled, true)
  assert.match(root?.hiddenReason ?? '', /依赖 module-nf-core-fastqc 不可用.*已停用/)
})

test('custom wrappers can be disabled and restored through their stable enablement identifier', () => {
  const agentDir = fixture(true)
  const custom = join(agentDir, 'wrappers', 'custom', 'modules', 'acme', 'toy', 'wrapper')
  write(join(custom, 'wrapper.yaml'), wrapperYaml('acme/modules/toy'))
  const item = listWrapperCompositionCatalogStatus({ agentDir }).find(
    (entry) => entry.id === 'acme/modules/toy'
  )
  assert.ok(item?.enablementId)
  const key = `wrapper:${item.enablementId}` as const
  setEnabled(key, false, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.deepEqual(listWrapperCompositionCatalog({ agentDir }), [])
  const disabled = listWrapperCompositionCatalogStatus({ agentDir }).find(
    (entry) => entry.id === item.id
  )
  assert.equal(disabled?.packageSelected, true)
  assert.equal(disabled?.packageEnabled, false)
  assert.match(disabled?.hiddenReason ?? '', /自定义 wrapper toy 已停用/)

  setEnabled(key, true, { agentDir })
  resetWrapperCompositionCatalogCache()
  assert.equal(listWrapperCompositionCatalog({ agentDir })[0]?.manifest.id, item.id)
})

test('wrapper_search uses the same enablement and dependency-filtered catalog', async () => {
  const agentDir = fixture()
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir })
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionSearchTool({ agentDir }).execute('search', {
    query: ''
  })
  const details = result.details as { results: Array<{ id: string }> }
  assert.deepEqual(details.results, [])
})

test('project wrapper enablement overrides the global package setting', () => {
  const agentDir = fixture()
  const projectDir = join(agentDir, 'project')
  mkdirSync(projectDir, { recursive: true })
  setEnabled('wrapper:module-nf-core-fastqc', true, { agentDir })
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir, projectDir })
  resetWrapperCompositionCatalogCache()

  assert.deepEqual(listWrapperCompositionCatalog({ agentDir, projectDir }), [])
})

test('wrapper_run refuses a disabled package even when called directly by id', async () => {
  const agentDir = fixture()
  setEnabled('wrapper:module-nf-core-fastqc', false, { agentDir })
  resetWrapperCompositionCatalogCache()

  const started = await new WrapperJobManager({ agentDir: () => agentDir }).start({
    id: 'nf-core/modules/fastqc',
    overrides: {}
  })
  assert.equal(started.ok, false)
  if (!started.ok) assert.match(started.error, /disabled/)
})
