import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillCatalogState } from '../src/renderer/src/features/skill/hooks/useSkillCatalog'
import type { SkillCatalogDialogProps } from '../src/renderer/src/features/skill/components/SkillCatalogDialog'
import type { PromptAgentSummary, SkillSummary } from '../src/renderer/src/types'
import type { PackageRegistryView } from '../src/shared/packageManagerTypes'
import type {
  PhiSkillCatalogDetail,
  PhiSkillCatalogItem,
  PhiSkillGroupsPage,
  PhiSkillListPage
} from '../src/shared/phiWebsiteCatalogTypes'
import { loadContentCatalog } from '../src/renderer/src/lib/contentCatalog'
import * as resourceUi from '../src/renderer/src/lib/resourceUi'
import { skillCopy } from '../src/renderer/src/features/skill/lib/skillCopy'
import * as skillCatalogBrowser from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'
import type { OfficialSkillCatalogState } from '../src/renderer/src/features/skill/hooks/useOfficialSkillCatalog'
import { getCatalogPage } from '../src/renderer/src/components/catalog/catalogPaging'
import { deferred, flush, hookHarness, type Deferred } from './helpers/resourceCatalogHarness'

const hookPath = 'src/renderer/src/features/skill/hooks/useSkillCatalog.ts'
const officialHookPath = 'src/renderer/src/features/skill/hooks/useOfficialSkillCatalog.ts'
const dialogPath = 'src/renderer/src/features/skill/components/SkillCatalogDialog.tsx'

function installedSkill(id: string): SkillSummary {
  return {
    id,
    name: id,
    description: id,
    filePath: `/skills/${id}/SKILL.md`,
    source: 'package',
    scope: 'user',
    sourceCategory: 'installed-package',
    sourceCategoryLabel: '已安装',
    sourceId: id,
    enabled: true,
    globalEnabled: true,
    globalOverride: null,
    projectOverride: null,
    core: false,
    disabled: false
  }
}

function resourceEvents(): {
  listeners: Set<() => void>
  onPackageResourcesChanged: (callback: () => void) => () => void
  emit: () => void
} {
  const listeners = new Set<() => void>()
  return {
    listeners,
    onPackageResourcesChanged: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    emit: () => {
      for (const callback of [...listeners]) callback()
    }
  }
}

test('agent package installation refreshes skills and prompt agents while discarding the pending old list', async () => {
  const events = resourceEvents()
  const skills: Array<Deferred<SkillSummary[]>> = []
  const prompts: Array<Deferred<PromptAgentSummary[]>> = []
  const harness = hookHarness<SkillCatalogState>(
    hookPath,
    'useSkillCatalog',
    {
      ...events,
      listSkills: () => {
        const read = deferred<SkillSummary[]>()
        skills.push(read)
        return read.promise
      },
      listPromptAgents: () => {
        const read = deferred<PromptAgentSummary[]>()
        prompts.push(read)
        return read.promise
      }
    },
    [() => '/project']
  )
  const state = harness.read()
  state.setActiveSkillId('new-skill')
  const old = state.refreshSkillsForNavigation()
  await flush()
  events.emit()
  await flush()
  assert.equal(skills.length, 2)
  assert.equal(prompts.length, 1)
  skills[1].resolve([installedSkill('new-skill')])
  prompts[0].resolve([
    { id: 'new-agent', name: 'New agent', description: '', source: 'user', trigger: '' }
  ])
  await flush()
  skills[0].resolve([installedSkill('old-skill')])
  await old
  assert.equal(harness.read().skills[0].id, 'new-skill')
  assert.equal(harness.read().activeSkillId, 'new-skill')
  assert.equal(harness.read().promptAgents[0].id, 'new-agent')
  const queuedEvent = [...events.listeners][0]
  harness.unmount()
  const writes = harness.writes()
  assert.equal(events.listeners.size, 0)
  queuedEvent()
  await flush()
  assert.equal(skills.length, 2)
  assert.equal(harness.writes(), writes)
})

test('resource events follow the current project and cleanup prevents stale reads after StrictMode setup', async () => {
  const events = resourceEvents()
  let cwd = '/old'
  const reads: Array<{ cwd: string; skills: Deferred<SkillSummary[]> }> = []
  const prompts: Array<Deferred<PromptAgentSummary[]>> = []
  const harness = hookHarness<SkillCatalogState>(
    hookPath,
    'useSkillCatalog',
    {
      ...events,
      listSkills: (path: string) => {
        const skills = deferred<SkillSummary[]>()
        reads.push({ cwd: path, skills })
        return skills.promise
      },
      listPromptAgents: () => {
        const read = deferred<PromptAgentSummary[]>()
        prompts.push(read)
        return read.promise
      }
    },
    [() => cwd]
  )
  harness.read()
  events.emit()
  await flush()
  cwd = '/current'
  harness.restartEffects()
  assert.equal(events.listeners.size, 1)
  events.emit()
  await flush()
  assert.deepEqual(
    reads.map((read) => read.cwd),
    ['/old', '/current']
  )
  reads[1].skills.resolve([installedSkill('current')])
  prompts[1].resolve([])
  await flush()
  reads[0].skills.resolve([installedSkill('old')])
  prompts[0].resolve([{ id: 'old', name: 'Old', description: '', source: 'user', trigger: '' }])
  await flush()
  assert.equal(harness.read().skills[0].id, 'current')
  assert.equal(harness.read().promptAgents.length, 0)
  events.emit()
  await flush()
  harness.unmount()
  const writes = harness.writes()
  reads[2].skills.resolve([installedSkill('unmounted')])
  prompts[2].resolve([])
  await flush()
  assert.equal(harness.writes(), writes)
})

type View = { type: string; props: Record<string, unknown> }
function view(tree: unknown, type: string): View {
  if (typeof tree !== 'object' || tree === null) throw new Error(`Missing ${type}`)
  const value = tree as Record<string, unknown>
  if (value.type === type) return value as unknown as View
  for (const child of Object.values(value)) {
    try {
      return view(child, type)
    } catch {
      /* Continue through sibling props. */
    }
  }
  throw new Error(`Missing ${type}`)
}

function registry(count: number): PackageRegistryView {
  return {
    id: 'phi-packages',
    kind: 'official',
    dir: `/website-${count}`,
    trust: 'imported',
    schemaVersion: 1,
    generatedAt: '2026-10-17T00:00:00.000Z',
    packages: Array.from({ length: count }, (_unused, index) => {
      const suffix = String(index + 1).padStart(2, '0')
      return {
        id: `science-${suffix}`,
        type: 'skill',
        title: `Science ${suffix}`,
        summary: 'Scientific analysis',
        version: '1.0.0',
        archive: `science-${suffix}.tgz`,
        sha256: 'a'.repeat(64),
        size: 64,
        dependsOn: [],
        category: '分析'
      }
    })
  }
}

const unavailableOfficialCatalog: OfficialSkillCatalogState = {
  status: 'unavailable',
  groups: [],
  selectedGroupId: 'science',
  page: null,
  isLoading: false,
  markUnavailable: () => undefined
}

function dialogImports(
  officialCatalog: OfficialSkillCatalogState = unavailableOfficialCatalog
): Record<string, unknown> {
  const jsx = (type: string, props: Record<string, unknown>): View => ({ type, props })
  return {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@mui/material': Object.fromEntries(
      ['Alert', 'Button', 'CircularProgress', 'Dialog', 'Stack', 'Typography'].map((name) => [
        name,
        name
      ])
    ),
    '../../../components/ResourceIcon': { ResourceIcon: 'Icon' },
    '../../../components/catalog/CatalogBrowseLayout': { CatalogBrowseLayout: 'Browse' },
    '../../../components/catalog/CatalogAddButton': { CatalogAddButton: 'Add' },
    '../../../components/catalog/CatalogPagination': { CatalogPagination: 'Pagination' },
    '../../../components/catalog/useBusyKeys': {
      useBusyKeys: () => ({
        any: false,
        has: () => false,
        start: () => undefined,
        finish: () => undefined
      })
    },
    '../../../components/catalog/usePackageRemoval': {
      usePackageRemoval: () => ({
        error: null,
        isRemoving: () => false,
        clearError: () => undefined,
        remove: async () => undefined
      })
    },
    '../../../components/catalog/catalogPaging': { getCatalogPage },
    '../../../lib/contentCatalog': { loadContentCatalog },
    '../../../components/catalog/CatalogResultsTable': { CatalogResultsTable: 'Results' },
    '../../../components/catalog/packageSize': { formatPackageSize: () => '64 B' },
    './SkillPackageDetailPage': { SkillPackageDetailPage: 'Detail' },
    './OfficialSkillDetailPage': { OfficialSkillDetailPage: 'OfficialDetail' },
    '../hooks/useOfficialSkillCatalog': {
      useOfficialSkillCatalog: () => officialCatalog
    },
    '../lib/skillCatalogBrowser': skillCatalogBrowser,
    '../../../lib/resourceUi': resourceUi,
    '../lib/skillCopy': { skillCopy }
  }
}

const officialGroups: PhiSkillGroupsPage = {
  view: 'groups',
  items: [
    { id: 'nextflow', label: '工作流', count: 12 },
    { id: 'science', label: '科学分析', count: 18 }
  ],
  total: 2,
  page: 1,
  pageSize: 100,
  pageCount: 1
}

function officialSkill(id: string, group: 'science' | 'nextflow' = 'science'): PhiSkillCatalogItem {
  return {
    id,
    slug: id,
    kind: 'skill',
    title: `Website ${id}`,
    description: `Website description for ${id}`,
    path: `resources/skills/${id}`,
    version: '2.0.0',
    sizeBytes: 2048,
    sizeLabel: '2 KB',
    source: 'Phi Packages',
    group,
    groupLabel: group === 'science' ? '科学分析' : '工作流'
  }
}

function officialPage(
  item: PhiSkillCatalogItem,
  overrides: Partial<PhiSkillListPage> = {}
): PhiSkillListPage {
  return {
    view: 'group',
    group: item.group,
    groupLabel: item.groupLabel,
    groups: officialGroups.items,
    items: [item],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    ...overrides
  }
}

test('skill browsing uses website groups in API order and sends group, search and paging to the server', async () => {
  const groupQueries: unknown[] = []
  const listQueries: Array<Record<string, unknown>> = []
  const args = [
    {
      open: true,
      revision: 1,
      requestedGroupId: 'missing',
      query: '',
      page: 0,
      pageSize: 10
    }
  ]
  const harness = hookHarness<OfficialSkillCatalogState>(
    officialHookPath,
    'useOfficialSkillCatalog',
    {
      listOfficialSkillGroups: async (query: unknown) => {
        // Copy into this realm: the hook runs in a separate VM context.
        groupQueries.push({ ...(query as object) })
        return { status: 'available', data: officialGroups }
      },
      listOfficialSkills: async (query: Record<string, unknown>) => {
        listQueries.push({ ...query })
        const group = query.group as 'science' | 'nextflow'
        return {
          status: 'available',
          data: officialPage(officialSkill(group === 'science' ? 'science-01' : 'workflow-01', group), {
            total: 27,
            page: Number(query.page),
            pageSize: Number(query.pageSize),
            pageCount: 3
          })
        }
      }
    },
    args,
    { '../lib/skillCatalogBrowser': skillCatalogBrowser }
  )

  harness.read()
  await flush()
  harness.read()
  await flush()
  let state = harness.read()
  assert.deepEqual(groupQueries, [{ page: 1, pageSize: 100 }])
  assert.deepEqual(listQueries[0], { group: 'nextflow', page: 1, pageSize: 10 })
  assert.deepEqual(state.groups, officialGroups.items)

  args[0] = { ...args[0], requestedGroupId: 'science', query: 'single cell' }
  harness.read()
  await flush()
  state = harness.read()
  assert.deepEqual(listQueries.at(-1), {
    group: 'science',
    q: 'single cell',
    page: 1,
    pageSize: 10
  })
  assert.equal(state.page?.items[0].title, 'Website science-01')
  args[0] = { ...args[0], page: 1 }
  harness.read()
  await flush()
  state = harness.read()
  assert.deepEqual(listQueries.at(-1), {
    group: 'science',
    q: 'single cell',
    page: 2,
    pageSize: 10
  })
  assert.equal(state.page?.total, 27)
  harness.unmount()

  const websiteState: OfficialSkillCatalogState = {
    status: 'available',
    groups: officialGroups.items,
    selectedGroupId: 'nextflow',
    page: officialPage(officialSkill('workflow-01', 'nextflow'), { total: 27, pageCount: 3 }),
    isLoading: false,
    markUnavailable: () => undefined
  }
  const dialog = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      readOfficialContentCatalog: async () => registry(3),
      listPackageRegistries: async () => [],
      listPackageUpdates: async () => [],
      listInstalledPackages: async () => []
    },
    [{ open: true, skills: [], onClose: () => undefined } satisfies SkillCatalogDialogProps],
    dialogImports(websiteState)
  )
  const tree = dialog.read()
  assert.deepEqual(view(tree, 'Browse').props.groups, officialGroups.items)
  const [websiteRow] = view(tree, 'Results').props.rows as Array<{
    title: string
    metadata: string
  }>
  assert.equal(websiteRow.title, 'Website workflow-01')
  assert.equal(websiteRow.metadata, 'Phi')
  assert.equal(view(tree, 'Pagination').props.count, 27)
  dialog.unmount()
})

test('an unavailable website skill catalog falls back to one quiet flat registry list', async () => {
  const harness = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      listOfficialSkillGroups: async () => ({ status: 'unavailable' }),
      listOfficialSkills: async () => {
        throw new Error('A group list must not be requested after group discovery is unavailable')
      },
      readOfficialContentCatalog: async () => registry(2),
      listPackageRegistries: async () => [],
      listPackageUpdates: async () => [],
      listInstalledPackages: async () => []
    },
    [{ open: true, skills: [], onClose: () => undefined } satisfies SkillCatalogDialogProps],
    dialogImports()
  )

  harness.read()
  await flush()
  harness.read()
  await flush()
  const tree = harness.read()
  assert.deepEqual(view(tree, 'Browse').props.groups, [
    { id: 'all', label: 'All Skills', count: 2 }
  ])
  assert.deepEqual(
    (view(tree, 'Results').props.rows as Array<{ title: string; metadata: string }>).map(
      ({ title, metadata }) => ({ title, metadata })
    ),
    [
      { title: 'Science 01', metadata: 'Phi Packages' },
      { title: 'Science 02', metadata: 'Phi Packages' }
    ]
  )
  assert.equal(
    view(tree, 'Alert').props.children,
    'The Phi Website catalog is temporarily unavailable. Showing the flat package registry instead.'
  )
  harness.unmount()
})

test('opening an official skill loads detail by slug from the website detail endpoint', async () => {
  const detailCalls: string[] = []
  const listItem = officialSkill('science-01', 'science')
  const detail: PhiSkillCatalogDetail = {
    kind: 'skill',
    slug: listItem.slug,
    title: 'Website detail title',
    description: 'Detail description',
    path: listItem.path,
    version: '3.0.0',
    sizeBytes: 4096,
    sizeLabel: '4 KB',
    source: 'Phi Packages',
    markdown: '# Detail markdown',
    frontmatter: { name: 'science-01' }
  }
  const websiteState: OfficialSkillCatalogState = {
    status: 'available',
    groups: [officialGroups.items[1]],
    selectedGroupId: 'science',
    page: officialPage(listItem),
    isLoading: false,
    markUnavailable: () => undefined
  }
  const harness = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      getOfficialSkillDetail: async (slug: string) => {
        detailCalls.push(slug)
        return { status: 'available', data: detail }
      },
      readOfficialContentCatalog: async () => registry(2),
      listPackageRegistries: async () => [],
      listPackageUpdates: async () => [],
      listInstalledPackages: async () => []
    },
    [{ open: true, skills: [], onClose: () => undefined } satisfies SkillCatalogDialogProps],
    dialogImports(websiteState)
  )

  harness.read()
  let tree = harness.read()
  ;(view(tree, 'Results').props.onOpen as (id: string) => void)('science-01')
  harness.read()
  await flush()
  tree = harness.read()
  assert.deepEqual(detailCalls, ['science-01'])
  assert.deepEqual(view(tree, 'OfficialDetail').props.detail, detail)
  harness.unmount()
})

test('the open skill catalog forces website refresh and updates installation state without resetting search, group or page', async () => {
  const events = resourceEvents()
  const forced: Array<boolean | undefined> = []
  let generation = 25
  let installed = false
  const args: SkillCatalogDialogProps[] = [
    {
      open: true,
      skills: [],
      onClose: () => undefined,
      onInstallPackage: () => undefined,
      onApplyUpdate: () => undefined
    }
  ]
  const harness = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      ...events,
      readOfficialContentCatalog: async (force: boolean | undefined) => {
        forced.push(force)
        return registry(generation)
      },
      listPackageRegistries: async () => [],
      readPackageRegistry: async () => {
        throw new Error('Old source must not be read')
      },
      listPackageUpdates: async () => (installed ? [{ id: 'science-11', type: 'skill' }] : []),
      listInstalledPackages: async () => (installed ? [{ id: 'science-11', type: 'skill' }] : [])
    },
    args,
    dialogImports()
  )
  harness.read()
  await flush()
  let tree = harness.read()
  ;(view(tree, 'Browse').props.onQueryChange as (query: string) => void)('science')
  ;(view(tree, 'Browse').props.onGroupChange as (group: string) => void)('all')
  tree = harness.read()
  ;(view(tree, 'Pagination').props.onPageChange as (page: number) => void)(1)
  tree = harness.read()
  assert.equal(view(tree, 'Browse').props.page, 1)
  generation = 26
  installed = true
  events.emit()
  await flush()
  tree = harness.read()
  assert.deepEqual(forced, [true, true])
  assert.equal(view(tree, 'Browse').props.query, 'science')
  assert.equal(view(tree, 'Browse').props.selectedGroupId, 'all')
  assert.equal(view(tree, 'Browse').props.page, 1)
  assert.equal(view(tree, 'Pagination').props.count, 26)
  const rows = view(tree, 'Results').props.rows as Array<{ id: string; action: View }>
  assert.equal(
    rows.find((row) => row.id === 'science-11')?.action.props['aria-label'],
    'Update Science 11'
  )
  harness.unmount()
  assert.equal(events.listeners.size, 0)
})

test('closing or replacing a catalog request rejects stale website snapshots and releases the event listener', async () => {
  const events = resourceEvents()
  const reads: Array<Deferred<PackageRegistryView>> = []
  const args: SkillCatalogDialogProps[] = [{ open: true, skills: [], onClose: () => undefined }]
  const harness = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      ...events,
      readOfficialContentCatalog: () => {
        const read = deferred<PackageRegistryView>()
        reads.push(read)
        return read.promise
      },
      listPackageRegistries: async () => [],
      readPackageRegistry: async () => {
        throw new Error('Old source must not be read')
      }
    },
    args,
    dialogImports()
  )
  harness.read()
  events.emit()
  reads[1].resolve(registry(17))
  await flush()
  reads[0].resolve(registry(14))
  await flush()
  assert.equal(view(harness.read(), 'Pagination').props.count, 17)
  const queuedEvent = [...events.listeners][0]
  events.emit()
  args[0] = { ...args[0], open: false }
  harness.read()
  const writes = harness.writes()
  assert.equal(events.listeners.size, 0)
  queuedEvent()
  assert.equal(reads.length, 3)
  reads[2].resolve(registry(99))
  await flush()
  assert.equal(harness.writes(), writes)
})

test('language switching retains the open skill catalog query, group, page and loaded snapshot', async () => {
  const events = resourceEvents()
  let reads = 0
  const snapshot = registry(25)
  for (const entry of snapshot.packages) entry.category = '科学分析'
  const harness = hookHarness<View>(
    dialogPath,
    'SkillCatalogDialog',
    {
      ...events,
      readOfficialContentCatalog: async () => {
        reads += 1
        return snapshot
      },
      listPackageRegistries: async () => [],
      listPackageUpdates: async () => [],
      listInstalledPackages: async () => []
    },
    [{ open: true, skills: [], onClose: () => undefined } satisfies SkillCatalogDialogProps],
    dialogImports()
  )
  try {
    harness.read()
    await flush()
    let tree = harness.read()
    ;(view(tree, 'Browse').props.onQueryChange as (query: string) => void)('science')
    ;(view(tree, 'Browse').props.onGroupChange as (group: string) => void)('all')
    tree = harness.read()
    ;(view(tree, 'Pagination').props.onPageChange as (page: number) => void)(1)
    tree = harness.read()
    const groups = view(tree, 'Browse').props.groups as Array<{ id: string; label: string }>
    assert.equal(groups.find((group) => group.id === 'all')?.label, 'All Skills')
    for (const [language, label] of [
      ['zh-CN', '全部技能'],
      ['en', 'All Skills']
    ] as const) {
      setUiLanguage(language)
      tree = harness.read()
      assert.equal(view(tree, 'Browse').props.query, 'science')
      assert.equal(view(tree, 'Browse').props.selectedGroupId, 'all')
      assert.equal(view(tree, 'Browse').props.page, 1)
      const translated = view(tree, 'Browse').props.groups as Array<{ id: string; label: string }>
      assert.equal(translated.find((group) => group.id === 'all')?.label, label)
      const rows = view(tree, 'Results').props.rows as Array<{ id: string }>
      assert.equal(rows[0].id, 'science-11')
      assert.equal(reads, 1, 'a language change must not refetch or reset the loaded catalog')
      assert.equal(events.listeners.size, 1)
    }
  } finally {
    harness.unmount()
    setUiLanguage('en')
  }
})
