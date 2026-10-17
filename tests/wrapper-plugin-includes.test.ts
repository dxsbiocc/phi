import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  collectIncludeReferences,
  collectIncludedFiles
} from '../src/main/agent/wrappers/composition/includes'
import {
  buildWrapperPackageSources,
  materializeWrapperRegistry
} from '../src/main/agent/wrappers/packages/builder'
import { installPackages } from '../src/main/agent/packages/installer'
import { planInstall } from '../src/main/agent/packages/planning'
import { readRegistry } from '../src/main/agent/packages/registry'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-plugin-includes-'))
  roots.push(root)
  return root
}

function write(root: string, path: string, content: string): string {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

test('Nextflow plugin imports are classified separately and never resolved as local files', () => {
  const root = fixture()
  const main = write(
    root,
    'main.nf',
    [
      "include { validateParameters } from 'plugin/nf-schema'",
      "include { LOCAL } from './local'",
      "include { LOCAL_PLUGIN_FILE } from './plugin/local'"
    ].join('\n')
  )
  const local = write(root, 'local/main.nf', 'workflow LOCAL {}\n')
  const localPlugin = write(root, 'plugin/local/main.nf', 'workflow LOCAL_PLUGIN_FILE {}\n')
  write(root, 'plugin/nf-schema/main.nf', "include { HIDDEN } from '../../missing'\n")
  const references = collectIncludeReferences(main)
  assert.equal(references[0].pluginId, 'nf-schema')
  assert.equal(references[0].resolvedFile, undefined)
  assert.equal(references[1].resolvedFile, local)
  assert.equal(references[2].resolvedFile, localPlugin)
  assert.deepEqual(collectIncludedFiles(main), [main, local, localPlugin])
})

test('four valid plugin references keep the workflow complete and installable without missing-file warnings', async () => {
  const root = fixture()
  const wrappersRoot = join(root, 'source')
  const workflow = 'workflows/rnaseq'
  write(
    wrappersRoot,
    `${workflow}/wrapper/wrapper.yaml`,
    [
      'id: nf-core/workflows/rnaseq',
      'name: RNA-seq',
      'summary: Schema-enabled workflow',
      'params:',
      '  outdir: {kind: output, type: path, required: true}',
      'outputs:',
      '  results: {type: directory, path: "${outdir}", primary: true}'
    ].join('\n')
  )
  write(wrappersRoot, `${workflow}/wrapper/main.nf`, "include { RNASEQ } from '../main'\n")
  write(wrappersRoot, `${workflow}/wrapper/params.json`, '{}\n')
  write(wrappersRoot, `${workflow}/wrapper/nextflow.config`, "includeConfig '../nextflow.config'\n")
  const config = "plugins { id 'nf-schema@2.5.1' }\n"
  write(wrappersRoot, `${workflow}/nextflow.config`, config)
  write(
    wrappersRoot,
    `${workflow}/main.nf`,
    [
      ...['qc', 'pipeline', 'schema', 'rnaseq'].map(
        (name) => `include { ${name.toUpperCase()} } from './subworkflows/${name}'`
      ),
      'workflow RNASEQ {}'
    ].join('\n')
  )
  for (const name of ['qc', 'pipeline', 'schema', 'rnaseq']) {
    write(
      wrappersRoot,
      `${workflow}/subworkflows/${name}/main.nf`,
      "include { validateParameters } from 'plugin/nf-schema'\n"
    )
  }
  const built = buildWrapperPackageSources({ wrappersRoot })
  assert.deepEqual(built.diagnostics.unattributedIncludes, [])
  assert.equal(built.sources.length, 1)
  assert.deepEqual(built.sources[0].manifest.dependsOn, [])
  assert.equal(built.sources[0].files.get(`${workflow}/nextflow.config`)?.toString(), config)
  const output = join(root, 'registry')
  const { index } = materializeWrapperRegistry({ wrappersRoot, outDir: output })
  const registry = readRegistry(output)
  const agentDir = join(root, 'agent')
  await installPackages(
    planInstall(registry, { type: 'wrapper', id: index.packages[0].id }, { agentDir }),
    { agentDir }
  )
  assert.equal(
    readFileSync(join(agentDir, 'wrappers/tree', workflow, 'nextflow.config'), 'utf8'),
    config
  )
  const installedMain = join(agentDir, 'wrappers/tree', workflow, 'wrapper/main.nf')
  assert.equal(
    collectIncludeReferences(installedMain).filter((item) => item.pluginId === 'nf-schema').length,
    4
  )
})

test('genuine missing local includes and invalid plugin paths remain visible diagnostics', () => {
  const root = fixture()
  const module = 'modules/acme/example'
  write(
    root,
    `${module}/wrapper/wrapper.yaml`,
    [
      'id: acme/modules/example',
      'name: Example',
      'summary: Missing local include fixture',
      'params:',
      '  outdir: {kind: output, type: path, required: true}',
      'outputs:',
      '  results: {type: directory, path: "${outdir}", primary: true}'
    ].join('\n')
  )
  write(root, `${module}/wrapper/main.nf`, "include { RUN } from '../main'\n")
  write(root, `${module}/wrapper/params.json`, '{}\n')
  write(
    root,
    `${module}/main.nf`,
    "include { MISSING } from './missing'\ninclude { INVALID } from 'plugin/../missing'\ninclude { ALIAS } from 'plugin/../main'\n"
  )
  const diagnostics = buildWrapperPackageSources({ wrappersRoot: root }).diagnostics
    .unattributedIncludes
  assert.equal(diagnostics.length, 3)
  assert.ok(diagnostics.every((item) => item.reason === 'not-found'))
  assert.deepEqual(diagnostics.map((item) => item.target).sort(), [
    './missing',
    'plugin/../main',
    'plugin/../missing'
  ])
})
