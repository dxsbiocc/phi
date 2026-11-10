import assert from 'node:assert/strict'
import test from 'node:test'

import type { PackageUpdateView } from '../src/shared/packageManagerTypes'
import type { OfficialWrapperToolChoice } from '../src/renderer/src/features/wrapper/lib/officialWrapperCatalog'
import type { WrapperCatalogChoice } from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'
import type { WrapperInstallItem } from '../src/renderer/src/features/wrapper/lib/wrapperInstallPlan'
import {
  summarizeWrapperSuiteInstall,
  wrapperSuiteAction,
  wrapperSuiteBusyKey,
  wrapperSuiteUpdateIds
} from '../src/renderer/src/features/wrapper/lib/wrapperSuiteAction'

function suiteChoice(
  id: string,
  state: Partial<WrapperCatalogChoice> = {}
): OfficialWrapperToolChoice {
  return {
    tool: { id: `nf-core/modules/${id}`, name: id } as OfficialWrapperToolChoice['tool'],
    choice: {
      id,
      title: id,
      summary: '',
      metadata: '',
      category: '',
      installed: false,
      selected: false,
      enabled: false,
      ...state
    }
  }
}

test('suite action state covers installed, missing and update cases', () => {
  const installed = { installed: true, selected: true, enabled: true }
  assert.deepEqual(wrapperSuiteAction([suiteChoice('fastqc', installed)]), {
    state: 'installed',
    kind: 'uninstall',
    label: 'Uninstall',
    updates: []
  })
  assert.deepEqual(wrapperSuiteAction([suiteChoice('fastqc', installed), suiteChoice('multiqc')]), {
    state: 'install',
    kind: 'install',
    label: 'Install',
    updates: []
  })

  const updateIds = wrapperSuiteUpdateIds([
    { type: 'skill', id: 'not-a-wrapper' },
    { type: 'wrapper', id: 'fastqc' }
  ] as PackageUpdateView[])
  assert.deepEqual([...updateIds], ['fastqc'])
  const updateAction = wrapperSuiteAction([suiteChoice('fastqc', installed)], updateIds)
  assert.equal(updateAction.state, 'update')
  assert.equal(updateAction.kind, 'update')
  assert.equal(updateAction.label, 'Update')
  assert.deepEqual(
    updateAction.updates.map((choice) => choice.id),
    ['fastqc']
  )
  assert.equal(wrapperSuiteBusyKey('samtools'), 'suite:samtools')
})

test('suite install summary merges tools and shared dependencies once', () => {
  const item = (id: string, size: number): WrapperInstallItem => ({
    id,
    name: id,
    kind: 'Module',
    version: '1.0.0',
    size
  })
  const summary = summarizeWrapperSuiteInstall([
    {
      choice: suiteChoice('fastqc').choice,
      summary: {
        root: item('fastqc', 10),
        dependencies: [item('shared', 5), item('dep-a', 3)],
        totalSize: 18,
        needsConfirmation: true
      }
    },
    {
      choice: suiteChoice('multiqc').choice,
      summary: {
        root: item('multiqc', 20),
        dependencies: [item('shared', 5)],
        totalSize: 25,
        needsConfirmation: false
      }
    }
  ])
  assert.deepEqual(
    summary.tools.map((tool) => tool.id),
    ['fastqc', 'multiqc']
  )
  assert.deepEqual(
    summary.dependencies.map((dependency) => dependency.id),
    ['shared', 'dep-a']
  )
  assert.equal(summary.totalSize, 38)
  assert.equal(summary.needsConfirmation, true)
})
