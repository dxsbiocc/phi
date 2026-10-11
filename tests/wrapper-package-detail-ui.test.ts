import assert from 'node:assert/strict'
import test from 'node:test'

import type { WrapperCompositionCatalogItem } from '../src/shared/wrapperCompositionManifestTypes'
import {
  filterWrapperMembers,
  wrapperPackageMembers,
  wrapperParamConstraint
} from '../src/renderer/src/features/wrapper/lib/wrapperPackageDetail'
import {
  wrapperChoiceAction,
  wrapperChoiceIcon,
  type WrapperCatalogChoice
} from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'

function item(
  id: string,
  packageId: string,
  overrides: Partial<WrapperCompositionCatalogItem> = {}
): WrapperCompositionCatalogItem {
  return {
    id,
    name: id.split('/').at(-1)!.replace('-', ' '),
    summary: `summary of ${id}`,
    params: {},
    outputs: { out: { type: 'file', path: 'out', primary: true } },
    packageId,
    enablementId: packageId,
    ...overrides
  }
}

test('package members are the cached wrappers of that package, sorted by id', () => {
  const catalog = [
    item('nf-core/modules/samtools-view', 'module-nf-core-samtools'),
    item('nf-core/modules/bowtie2-align', 'module-nf-core-bowtie2'),
    item('nf-core/modules/samtools-sort', 'module-nf-core-samtools'),
    item('local/modules/mine', 'x', { packageId: undefined, enablementId: 'custom-mine' })
  ]
  assert.deepEqual(
    wrapperPackageMembers(catalog, 'module-nf-core-samtools').map((entry) => entry.id),
    ['nf-core/modules/samtools-sort', 'nf-core/modules/samtools-view']
  )
  assert.deepEqual(
    wrapperPackageMembers(catalog, 'custom-mine').map((entry) => entry.id),
    ['local/modules/mine']
  )
  assert.deepEqual(wrapperPackageMembers(catalog, 'absent'), [])
})

test('parameter constraints describe enums and numeric ranges', () => {
  assert.equal(
    wrapperParamConstraint({ kind: 'option', type: 'string', required: true, enum: ['a', 'b'] }),
    '可选值：a、b'
  )
  assert.equal(
    wrapperParamConstraint({
      kind: 'option',
      type: 'integer',
      required: false,
      minimum: 1,
      maximum: 64
    }),
    '范围：1 – 64'
  )
  assert.equal(
    wrapperParamConstraint({ kind: 'option', type: 'integer', required: false, minimum: 1 }),
    '范围：1 – ∞'
  )
  assert.equal(wrapperParamConstraint({ kind: 'input', type: 'file', required: true }), '')
})

test('member filter matches name, id and summary case-insensitively', () => {
  const members = [
    item('nf-core/modules/samtools-sort', 'p', { summary: 'Sort a BAM' }),
    item('nf-core/modules/samtools-view', 'p', { summary: 'Filter alignments' })
  ]
  assert.deepEqual(
    filterWrapperMembers(members, 'BAM').map((entry) => entry.id),
    ['nf-core/modules/samtools-sort']
  )
  assert.equal(filterWrapperMembers(members, '  ').length, 2)
  assert.equal(filterWrapperMembers(members, 'nothing').length, 0)
})

test('one action per choice: install or add when absent, uninstall once chosen', () => {
  const base = { id: 'x', title: 'x', summary: '', metadata: '', category: '' }
  const choice = (state: Partial<WrapperCatalogChoice>): WrapperCatalogChoice => ({
    ...base,
    installed: false,
    selected: false,
    enabled: false,
    ...state
  })
  assert.deepEqual(wrapperChoiceAction(choice({})), { label: '安装', kind: 'add' })
  assert.deepEqual(wrapperChoiceAction(choice({ installed: true })), { label: '添加', kind: 'add' })
  // A chosen package is removed whether or not it is currently switched on.
  assert.deepEqual(wrapperChoiceAction(choice({ installed: true, selected: true })), {
    label: '卸载',
    kind: 'remove'
  })
  assert.deepEqual(
    wrapperChoiceAction(choice({ installed: true, selected: true, enabled: true })),
    { label: '卸载', kind: 'remove' }
  )
})

test('a catalog logo is shown instead of a generated icon the installed copy fell back to', () => {
  const base = { id: 'x', title: 'x', summary: '', metadata: '', category: '' }
  const choice = (state: Partial<WrapperCatalogChoice>): WrapperCatalogChoice => ({
    ...base,
    installed: true,
    selected: true,
    enabled: true,
    ...state
  })
  const registryIcon = { key: 'registry-logo' }
  const cachedIcon = { key: 'generated-or-installed' }
  const entry = { icon: registryIcon } as WrapperCatalogChoice['registryEntry']
  const cached = { icon: cachedIcon } as WrapperCatalogChoice['cached']
  assert.equal(wrapperChoiceIcon(choice({ registryEntry: entry, cached })), registryIcon)
  assert.equal(wrapperChoiceIcon(choice({ cached })), cachedIcon)
  assert.equal(wrapperChoiceIcon(choice({})), undefined)
})
