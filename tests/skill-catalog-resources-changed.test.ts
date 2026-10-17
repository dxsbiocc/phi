import assert from 'node:assert/strict'
import test from 'node:test'
import type { SkillCatalogState } from '../src/renderer/src/features/skill/hooks/useSkillCatalog'
import type { SkillCatalogDialogProps } from '../src/renderer/src/features/skill/components/SkillCatalogDialog'
import type { PromptAgentSummary, SkillSummary } from '../src/renderer/src/types'
import type { PackageRegistryView } from '../src/shared/packageManagerTypes'
import { loadContentCatalog } from '../src/renderer/src/lib/contentCatalog'
import * as skillCatalogBrowser from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'
import { getCatalogPage } from '../src/renderer/src/components/catalog/catalogPaging'
import { deferred, flush, hookHarness, type Deferred } from './helpers/resourceCatalogHarness'

const hookPath = 'src/renderer/src/features/skill/hooks/useSkillCatalog.ts'
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

function dialogImports(): Record<string, unknown> {
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
    '../lib/skillCatalogBrowser': skillCatalogBrowser
  }
}

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
  ;(view(tree, 'Browse').props.onGroupChange as (group: string) => void)('category:分析')
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
  assert.equal(view(tree, 'Browse').props.selectedGroupId, 'category:分析')
  assert.equal(view(tree, 'Browse').props.page, 1)
  assert.equal(view(tree, 'Pagination').props.count, 26)
  const rows = view(tree, 'Results').props.rows as Array<{ id: string; action: View }>
  assert.equal(
    rows.find((row) => row.id === 'science-11')?.action.props['aria-label'],
    '更新 Science 11'
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
