import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { readEnablementState, writeEnablementState } from '../src/main/agent/enablement'
import { readWrapperTreeState } from '../src/main/agent/packages/wrapper-tree'
import {
  previewWrapperRemoval,
  removeWrapperPackage
} from '../src/main/agent/packages/wrapper-removal'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

interface Fixture {
  id: string
  registry: 'bundled-wrappers' | 'phi-packages'
  dependsOn?: string[]
}

function makeAgentDir(fixtures: Fixture[], enablement: Record<string, boolean> = {}): string {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-wrapper-removal-'))
  roots.push(agentDir)
  const treeDir = join(agentDir, 'wrappers', 'tree')
  const packages: Record<string, unknown> = {}
  for (const fixture of fixtures) {
    const file = `modules/nf-core/${fixture.id}/main.nf`
    mkdirSync(dirname(join(treeDir, file)), { recursive: true })
    writeFileSync(join(treeDir, file), 'process X {}\n')
    packages[fixture.id] = {
      version: '1.0.0',
      title: fixture.id,
      summary: '',
      manifest: {
        schemaVersion: 1,
        id: fixture.id,
        type: 'wrapper',
        version: '1.0.0',
        title: fixture.id,
        summary: '',
        dependsOn: (fixture.dependsOn ?? []).map((dependency) => ({
          id: dependency,
          type: 'wrapper',
          version: '^1.0.0'
        })),
        files: 'files.json'
      },
      source: {
        registry: fixture.registry,
        id: fixture.id,
        type: 'wrapper',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        installedAt: '2026-10-08T00:00:00.000Z',
        installedBy: 'user',
        trust: fixture.registry === 'bundled-wrappers' ? 'builtin' : 'official'
      },
      paths: [file]
    }
  }
  mkdirSync(join(agentDir, 'wrappers'), { recursive: true })
  writeFileSync(join(agentDir, 'wrappers', 'tree.json'), JSON.stringify({ version: 1, packages }))
  writeEnablementState({ version: 1, global: enablement, projects: {} }, { agentDir })
  return agentDir
}

test('removing a package deletes it even when it came from the old bundled pack', () => {
  const agentDir = makeAgentDir([{ id: 'module-nf-core-samtools', registry: 'bundled-wrappers' }], {
    'wrapper:module-nf-core-samtools': true
  })
  assert.deepEqual(removeWrapperPackage('module-nf-core-samtools', { agentDir }), {
    id: 'module-nf-core-samtools',
    disabledDependents: []
  })
  assert.equal(
    readEnablementState({ agentDir }).global['wrapper:module-nf-core-samtools'],
    undefined
  )
  assert.equal(readWrapperTreeState(agentDir).packages['module-nf-core-samtools'], undefined)
  assert.equal(
    existsSync(
      join(agentDir, 'wrappers', 'tree', 'modules/nf-core/module-nf-core-samtools/main.nf')
    ),
    false
  )
})

test('the choice is cleared in every project override as well', () => {
  const agentDir = makeAgentDir([{ id: 'module-nf-core-samtools', registry: 'bundled-wrappers' }], {
    'wrapper:module-nf-core-samtools': true
  })
  writeEnablementState(
    {
      version: 1,
      global: { 'wrapper:module-nf-core-samtools': true },
      projects: { '/work/a': { 'wrapper:module-nf-core-samtools': false } }
    },
    { agentDir }
  )
  removeWrapperPackage('module-nf-core-samtools', { agentDir })
  const state = readEnablementState({ agentDir })
  assert.deepEqual(state.global, {})
  assert.deepEqual(state.projects, {})
})

test('a package that an enabled chosen package needs cannot be removed', () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-samtools', registry: 'bundled-wrappers' },
      {
        id: 'module-nf-core-bam-tool',
        registry: 'bundled-wrappers',
        dependsOn: ['module-nf-core-samtools']
      },
      {
        id: 'subworkflow-nf-core-align',
        registry: 'bundled-wrappers',
        dependsOn: ['module-nf-core-bam-tool']
      }
    ],
    { 'wrapper:module-nf-core-samtools': true, 'wrapper:subworkflow-nf-core-align': true }
  )
  assert.throws(
    () => removeWrapperPackage('module-nf-core-samtools', { agentDir }),
    /samtools.*align|align.*samtools/
  )
  assert.equal(readEnablementState({ agentDir }).global['wrapper:module-nf-core-samtools'], true)
})

test('a disabled or unchosen dependent does not block removal', () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-samtools', registry: 'bundled-wrappers' },
      {
        id: 'subworkflow-nf-core-align',
        registry: 'bundled-wrappers',
        dependsOn: ['module-nf-core-samtools']
      },
      {
        id: 'subworkflow-nf-core-other',
        registry: 'bundled-wrappers',
        dependsOn: ['module-nf-core-samtools']
      }
    ],
    { 'wrapper:module-nf-core-samtools': true, 'wrapper:subworkflow-nf-core-align': false }
  )
  assert.ok(removeWrapperPackage('module-nf-core-samtools', { agentDir }))
})

test('previewing reports a disabled target that an enabled package still uses', () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-custom', registry: 'bundled-wrappers' },
      {
        id: 'module-local-differential-expression',
        registry: 'phi-packages',
        dependsOn: ['module-nf-core-custom']
      }
    ],
    {
      'wrapper:module-nf-core-custom': false,
      'wrapper:module-local-differential-expression': true
    }
  )
  assert.deepEqual(previewWrapperRemoval('module-nf-core-custom', { agentDir }), {
    id: 'module-nf-core-custom',
    name: 'custom',
    dependents: [
      {
        id: 'module-local-differential-expression',
        name: 'differential-expression'
      }
    ]
  })
})

test('removal can switch dependents off first when the user confirms it', () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-custom', registry: 'bundled-wrappers' },
      {
        id: 'module-local-differential-expression',
        registry: 'phi-packages',
        dependsOn: ['module-nf-core-custom']
      }
    ],
    {
      'wrapper:module-nf-core-custom': true,
      'wrapper:module-local-differential-expression': true
    }
  )
  assert.throws(
    () => removeWrapperPackage('module-nf-core-custom', { agentDir }),
    /differential-expression/
  )
  assert.deepEqual(
    removeWrapperPackage('module-nf-core-custom', { agentDir, disableDependents: true }),
    {
      id: 'module-nf-core-custom',
      disabledDependents: [
        {
          id: 'module-local-differential-expression',
          name: 'differential-expression'
        }
      ]
    }
  )
  const state = readEnablementState({ agentDir })
  assert.equal(state.global['wrapper:module-nf-core-custom'], undefined)
  assert.equal(state.global['wrapper:module-local-differential-expression'], false)
  assert.equal(readWrapperTreeState(agentDir).packages['module-nf-core-custom'], undefined)
})

test('a package enabled only by a project still blocks removal', () => {
  const agentDir = makeAgentDir(
    [
      { id: 'module-nf-core-custom', registry: 'bundled-wrappers' },
      {
        id: 'module-local-differential-expression',
        registry: 'phi-packages',
        dependsOn: ['module-nf-core-custom']
      }
    ],
    {
      'wrapper:module-nf-core-custom': false,
      'wrapper:module-local-differential-expression': true
    }
  )
  writeEnablementState(
    {
      version: 1,
      global: {
        'wrapper:module-nf-core-custom': false,
        'wrapper:module-local-differential-expression': true
      },
      projects: { '/work/a': { 'wrapper:module-nf-core-custom': true } }
    },
    { agentDir }
  )
  assert.throws(
    () => removeWrapperPackage('module-nf-core-custom', { agentDir }),
    /differential-expression/
  )
  removeWrapperPackage('module-nf-core-custom', { agentDir, disableDependents: true })
  const state = readEnablementState({ agentDir })
  assert.deepEqual(state.projects, {})
  assert.equal(state.global['wrapper:module-local-differential-expression'], false)
})

test('a package installed from the registry is uninstalled from disk', () => {
  const agentDir = makeAgentDir([{ id: 'module-nf-core-fastqc', registry: 'phi-packages' }], {
    'wrapper:module-nf-core-fastqc': true
  })
  assert.deepEqual(previewWrapperRemoval('module-nf-core-fastqc', { agentDir }), {
    id: 'module-nf-core-fastqc',
    name: 'fastqc',
    dependents: []
  })
  assert.deepEqual(removeWrapperPackage('module-nf-core-fastqc', { agentDir }), {
    id: 'module-nf-core-fastqc',
    disabledDependents: []
  })
  assert.equal(readWrapperTreeState(agentDir).packages['module-nf-core-fastqc'], undefined)
  assert.equal(
    existsSync(join(agentDir, 'wrappers', 'tree', 'modules/nf-core/module-nf-core-fastqc/main.nf')),
    false
  )
})

test('removing an unknown package fails clearly', () => {
  const agentDir = makeAgentDir([])
  assert.throws(() => removeWrapperPackage('module-nf-core-missing', { agentDir }), /尚未安装/)
})
