import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PackageRegistryEntryView,
  PackageRegistryView
} from '../src/shared/packageManagerTypes'
import { getCatalogPage } from '../src/renderer/src/components/catalog/catalogPaging'
import {
  filterSkillCatalogItems,
  initialSkillCatalogBrowserState,
  knownSkillCatalogPackages,
  skillCatalogBrowserReducer,
  skillCatalogGroups,
  skillCatalogItems,
  type SkillCatalogItem
} from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'

function entry(
  id: string,
  overrides: Partial<PackageRegistryEntryView> = {}
): PackageRegistryEntryView {
  return {
    id,
    type: 'skill',
    version: '1.0.0',
    title: id,
    summary: `${id} summary`,
    archive: `${id}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 1024,
    dependsOn: [],
    ...overrides
  }
}

function registry(dir: string, packages: PackageRegistryEntryView[]): PackageRegistryView {
  return { id: dir, dir, packages, trust: 'imported', schemaVersion: 1, generatedAt: '2026-10-07' }
}

test('skill catalog groups use actual categories and count only offered items', () => {
  const packages = [
    entry('scanpy', { category: '生物信息' }),
    entry('alignment', { category: ' 生物信息 ' }),
    entry('imaging', { category: '生物信息' }),
    entry('local', { category: '  ' })
  ]
  const items = skillCatalogItems(packages)
  const groups = skillCatalogGroups(items)

  assert.deepEqual(groups[0], { id: 'all', label: '全部技能', count: 4 })
  assert.ok(groups.every((group) => group.id !== 'bundled'))
  assert.deepEqual(
    groups.find((group) => group.label === '生物信息'),
    {
      id: 'category:生物信息',
      label: '生物信息',
      count: 3
    }
  )
  assert.deepEqual(
    groups.find((group) => group.label === '软件包'),
    {
      id: 'category:软件包',
      label: '软件包',
      count: 1
    }
  )
  assert.deepEqual(
    filterSkillCatalogItems(items, 'category:生物信息', '').map(
      (item) => item.kind === 'package' && item.entry.id
    ),
    ['scanpy', 'alignment', 'imaging']
  )
})

test('skill catalog search stays within its selected group and includes source metadata', () => {
  const items = skillCatalogItems([
    entry('scanpy', { summary: 'Single Cell Analysis', category: '生物信息' }),
    entry('package-id', {
      title: 'Workbench',
      summary: 'Analysis tools',
      category: '成像',
      registryLabel: 'Phi Packages'
    })
  ])
  assert.equal(filterSkillCatalogItems(items, 'category:生物信息', '  CELL  ').length, 1)
  assert.equal(filterSkillCatalogItems(items, 'all', 'analysis').length, 2)
  assert.equal(filterSkillCatalogItems(items, 'all', 'PACKAGE-ID').length, 1)
  assert.equal(filterSkillCatalogItems(items, 'category:成像', 'workbench').length, 1)
  assert.equal(filterSkillCatalogItems(items, 'category:成像', '成像').length, 1)
  assert.equal(filterSkillCatalogItems(items, 'category:生物信息', 'workbench').length, 0)
  assert.equal(filterSkillCatalogItems(items, 'all', 'Phi Packages').length, 1)
  assert.equal(filterSkillCatalogItems(items, 'all', 'nothing').length, 0)
})

test('skill catalog pages are disjoint and filtering happens before pagination', () => {
  const items = skillCatalogItems([
    ...Array.from({ length: 12 }, (_, index) => entry(`other-${index}`)),
    ...Array.from({ length: 23 }, (_, index) => entry(`package-${index}`, { category: '软件包组' }))
  ])
  let state = initialSkillCatalogBrowserState
  const visible = (): SkillCatalogItem[] =>
    getCatalogPage(
      filterSkillCatalogItems(items, state.groupId, state.query),
      state.page,
      state.rowsPerPage
    ).rows
  const firstPage = visible()
  assert.equal(firstPage.length, 10)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  const secondPage = visible()
  assert.equal(secondPage.length, 10)
  assert.equal(
    secondPage.some((item) => firstPage.includes(item)),
    false
  )
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 3 })
  assert.equal(visible().length, 5)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 2 })
  assert.equal(visible().length, 10)

  state = skillCatalogBrowserReducer(state, { type: 'group', groupId: 'category:软件包组' })
  assert.equal(state.page, 0)
  assert.equal(visible().length, 10)
  assert.equal(
    visible().every((item) => item.kind === 'package'),
    true
  )
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 2 })
  assert.equal(visible().length, 3)
  state = skillCatalogBrowserReducer(state, { type: 'query', query: 'package-1' })
  assert.equal(state.page, 0)
  assert.equal(visible().length, 10)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  assert.equal(visible().length, 1)
})

test('skill catalog page-size, group and query changes reset the page while close resets all defaults', () => {
  const items = Array.from({ length: 55 }, (_, index) => index)
  let state = skillCatalogBrowserReducer(initialSkillCatalogBrowserState, { type: 'page', page: 2 })
  state = skillCatalogBrowserReducer(state, { type: 'page-size', rowsPerPage: 20 })
  assert.deepEqual(state, { groupId: 'all', query: '', page: 0, rowsPerPage: 20 })
  assert.equal(getCatalogPage(items, state.page, state.rowsPerPage).rows.length, 20)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  assert.equal(getCatalogPage(items, state.page, state.rowsPerPage).rows[0], 20)
  state = skillCatalogBrowserReducer(state, { type: 'group', groupId: 'bundled' })
  assert.equal(state.page, 0)
  assert.equal(state.rowsPerPage, 20)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  state = skillCatalogBrowserReducer(state, { type: 'query', query: 'built' })
  assert.equal(state.page, 0)
  assert.equal(state.rowsPerPage, 20)
  state = skillCatalogBrowserReducer(state, { type: 'page-size', rowsPerPage: 50 })
  assert.equal(state.rowsPerPage, 50)
  assert.equal(getCatalogPage(items, state.page, state.rowsPerPage).rows.length, 50)
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  assert.deepEqual(getCatalogPage(items, state.page, state.rowsPerPage).rows, [50, 51, 52, 53, 54])
  state = skillCatalogBrowserReducer(state, { type: 'close' })
  assert.deepEqual(state, { groupId: 'all', query: '', page: 0, rowsPerPage: 10 })
})

test('known skill sources retain newest package metadata and installation directory', () => {
  const result = knownSkillCatalogPackages([
    registry('/old', [entry('newest', { version: '1.0.0', category: '旧分类' })]),
    null,
    registry('/new', [
      entry('newest', { version: '2.0.0', category: '新分类', title: 'B' }),
      entry('first', { title: 'A' }),
      entry('wrapper', { type: 'wrapper' })
    ]),
    registry('/older', [entry('newest', { version: '0.9.0' })])
  ])

  assert.deepEqual(
    result.map((item) => item.id),
    ['first', 'newest']
  )
  assert.equal(result[1].version, '2.0.0')
  assert.equal(result[1].category, '新分类')
  assert.equal(result[1].registryDir, '/new')
})

test('completed skill refresh resets a removed group to the first page and keeps query and size', () => {
  let state = skillCatalogBrowserReducer(initialSkillCatalogBrowserState, {
    type: 'group',
    groupId: 'category:旧分类'
  })
  state = skillCatalogBrowserReducer(state, { type: 'query', query: 'match' })
  state = skillCatalogBrowserReducer(state, { type: 'page-size', rowsPerPage: 20 })
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })

  const refreshedItems = skillCatalogItems(
    Array.from({ length: 42 }, (_, index) => entry(`match-${index}`, { category: '新分类' }))
  )
  const groupIds = skillCatalogGroups(refreshedItems).map((group) => group.id)
  state = skillCatalogBrowserReducer(state, { type: 'reconcile', groupIds, ready: true, page: 1 })
  assert.deepEqual(state, { groupId: 'all', query: 'match', page: 0, rowsPerPage: 20 })
  const matches = filterSkillCatalogItems(refreshedItems, state.groupId, state.query)
  const firstPage = getCatalogPage(matches, state.page, state.rowsPerPage).rows
  state = skillCatalogBrowserReducer(state, { type: 'page', page: 1 })
  const nextPage = getCatalogPage(matches, state.page, state.rowsPerPage).rows
  assert.equal(firstPage.length, 20)
  assert.equal(nextPage.length, 20)
  assert.equal(
    nextPage.some((item) => firstPage.includes(item)),
    false
  )
})

test('skill catalog clamps pages after successful shrink but preserves them during loading or failure', () => {
  const selected = {
    groupId: 'category:成像',
    query: 'match',
    page: 2,
    rowsPerPage: 10
  }
  const groupIds = ['all', 'bundled', 'category:成像']
  const loadingState = skillCatalogBrowserReducer(selected, {
    type: 'reconcile',
    groupIds: ['all', 'bundled'],
    ready: false,
    page: getCatalogPage([], selected.page, selected.rowsPerPage).page
  })
  assert.strictEqual(loadingState, selected)
  const failedState = skillCatalogBrowserReducer(loadingState, {
    type: 'reconcile',
    groupIds,
    ready: false,
    page: 0
  })
  assert.strictEqual(failedState, selected)
  const restoredItems = Array.from({ length: 24 }, (_, index) => index)
  const restored = skillCatalogBrowserReducer(failedState, {
    type: 'reconcile',
    groupIds,
    ready: true,
    page: getCatalogPage(restoredItems, selected.page, selected.rowsPerPage).page
  })
  assert.strictEqual(restored, selected)
  const shrunkItems = restoredItems.slice(0, 18)
  const shrunk = skillCatalogBrowserReducer(restored, {
    type: 'reconcile',
    groupIds,
    ready: true,
    page: getCatalogPage(shrunkItems, restored.page, restored.rowsPerPage).page
  })
  assert.deepEqual(shrunk, { ...selected, page: 1 })
  assert.deepEqual(
    getCatalogPage(shrunkItems, shrunk.page, shrunk.rowsPerPage).rows,
    [10, 11, 12, 13, 14, 15, 16, 17]
  )
  const empty = skillCatalogBrowserReducer(shrunk, {
    type: 'reconcile',
    groupIds,
    ready: true,
    page: getCatalogPage([], shrunk.page, shrunk.rowsPerPage).page
  })
  assert.equal(empty.page, 0)
})
