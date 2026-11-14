import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import type {
  PhiWrapperCatalogDetail,
  PhiWrapperCatalogTool,
  PhiWrapperGroupsPage,
  PhiWrapperToolsPage
} from '../src/shared/phiWebsiteCatalogTypes'
import type { PackageRegistryEntryView } from '../src/shared/packageManagerTypes'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { CatalogDetailFrame } from '../src/renderer/src/components/catalog/CatalogDetailFrame'
import {
  filterOfficialWrapperTools,
  loadOfficialWrapperDetail,
  loadOfficialWrapperGroups,
  loadOfficialWrapperSuiteTools,
  officialWrapperCategoryGroups,
  officialWrapperDefaultToolId,
  officialWrapperDetailManifest,
  officialWrapperGroupsQuery,
  officialWrapperRegistryId,
  officialWrapperToolChoices,
  officialWrapperToolShortName,
  officialWrapperToolsQuery,
  type OfficialWrapperCatalogApi
} from '../src/renderer/src/features/wrapper/lib/officialWrapperCatalog'
import {
  flatWrapperCatalogGroups,
  type WrapperCatalogChoice
} from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'
import {
  OfficialWrapperGroupsView,
  OfficialWrapperSuiteView
} from '../src/renderer/src/features/wrapper/components/OfficialWrapperCatalog'
import { OfficialWrapperDetailPage } from '../src/renderer/src/features/wrapper/components/OfficialWrapperDetailPage'

afterEach(() => setUiLanguage('en'))

function groupsPage(): PhiWrapperGroupsPage {
  return {
    view: 'groups',
    items: [
      {
        suite: 'samtools',
        count: 2,
        category: 'modules',
        categories: { modules: 2 },
        categoryLabel: '模块'
      }
    ],
    categories: [
      { id: 'modules', label: '模块', count: 630 },
      { id: 'workflows', label: '工作流', count: 1 }
    ],
    total: 176,
    page: 1,
    pageSize: 10,
    pageCount: 18
  }
}

function tool(overrides: Partial<PhiWrapperCatalogTool> = {}): PhiWrapperCatalogTool {
  return {
    id: 'nf-core/modules/samtools-sort',
    name: 'SAMtools sort',
    summary: 'Sort a BAM file.',
    category: 'modules',
    categoryLabel: '模块',
    path: 'resources/wrappers/modules/nf-core/samtools/sort/wrapper',
    version: '1.2.0',
    source: 'Phi Packages',
    suite: 'samtools',
    ...overrides
  }
}

function splitTool(): PhiWrapperCatalogTool {
  return tool({
    id: 'nf-core/modules/samtools-split',
    name: 'SAMtools split',
    summary: 'Split a BAM file by read group.',
    path: 'resources/wrappers/modules/nf-core/samtools/split/wrapper'
  })
}

function toolsPage(): PhiWrapperToolsPage {
  return {
    view: 'tools',
    group: 'samtools',
    suite: 'samtools',
    items: [tool()],
    categories: [{ id: 'modules', label: '模块', count: 630 }],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1
  }
}

function detailFor(current: PhiWrapperCatalogTool = tool()): PhiWrapperCatalogDetail {
  return {
    kind: 'wrapper',
    id: current.id,
    name: current.name,
    summary: current.summary,
    category: current.category,
    categoryLabel: current.categoryLabel,
    path: current.path,
    version: current.version,
    source: current.source,
    suite: current.suite,
    inputs: [
      { name: 'bam', kind: 'input', type: 'file', required: true, description: 'Input BAM.' },
      { name: 'threads', kind: 'option', type: 'integer', required: false }
    ],
    outputs: [{ name: 'sorted_bam', kind: 'output', type: 'file', required: true }],
    structure: { inputs: ['bam', 'threads'], process: current.name, outputs: ['sorted_bam'] },
    siblings: [{ id: current.id, name: current.name, tool: 'sort' }]
  }
}

function detail(): PhiWrapperCatalogDetail {
  return detailFor()
}

function registryEntry(): PackageRegistryEntryView {
  return {
    id: 'module-nf-core-samtools-sort',
    type: 'wrapper',
    version: '1.2.0',
    title: 'samtools-sort',
    summary: 'Registry summary',
    archive: 'samtools-sort.tgz',
    sha256: 'a'.repeat(64),
    size: 123,
    dependsOn: []
  }
}

function registryChoice(): WrapperCatalogChoice {
  return {
    id: registryEntry().id,
    title: 'samtools-sort',
    summary: 'Registry summary',
    metadata: 'Official registry',
    category: 'modules',
    version: '1.2.0',
    registryEntry: registryEntry(),
    registryPath: '/registry',
    installed: false,
    selected: false,
    enabled: false
  }
}

function themed(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('official group and tool queries preserve server-side category, search, and one-based paging', () => {
  assert.deepEqual(officialWrapperGroupsQuery('  RNA seq  ', 'modules', 2, 20), {
    q: 'RNA seq',
    category: 'modules',
    page: 3,
    pageSize: 20
  })
  assert.deepEqual(officialWrapperGroupsQuery('', 'all', 0, 10), { page: 1, pageSize: 10 })
  assert.deepEqual(officialWrapperToolsQuery('samtools', '  sort ', 1, 50), {
    group: 'samtools',
    q: 'sort',
    page: 2,
    pageSize: 50
  })
})

test('website ids map to exact normalized registry package ids and actions retain registry entries', () => {
  assert.equal(officialWrapperRegistryId(tool().id), 'module-nf-core-samtools-sort')
  assert.equal(
    officialWrapperRegistryId('NF_CORE/subworkflows/BAM_Sort/nested+step'),
    'subworkflow-nf-core-bam-sort-nested-step'
  )
  assert.equal(officialWrapperRegistryId('unstructured-id'), 'unstructured-id')

  const registry = registryChoice()
  const [{ choice }] = officialWrapperToolChoices([tool()], [registry])
  assert.equal(choice.id, registry.id)
  assert.equal(choice.registryEntry, registry.registryEntry)
  assert.equal(choice.registryPath, '/registry')
  assert.equal(choice.title, 'SAMtools sort')
  assert.equal(choice.metadata, 'Phi Packages')

  const browseOnly = officialWrapperToolChoices([tool()], [])[0]!.choice
  assert.equal(browseOnly.registryEntry, undefined)
  assert.equal(browseOnly.installed, false)
})

test('category groups preserve API labels and registry fallback remains a single flat group', () => {
  assert.deepEqual(officialWrapperCategoryGroups(groupsPage()), [
    { id: 'all', label: 'All Wrapper groups', count: 176 },
    { id: 'modules', label: '模块', count: 630 },
    { id: 'workflows', label: '工作流', count: 1 }
  ])
  assert.deepEqual(flatWrapperCatalogGroups([registryChoice()]), [
    { id: 'all', label: 'All Wrappers', count: 1 }
  ])
})

test('window API stubs select official results or registry fallback without network access', async () => {
  let observed = {}
  const windowApiStub: OfficialWrapperCatalogApi = {
    listOfficialWrapperGroups: async (query) => {
      observed = query
      return { status: 'available', data: groupsPage() }
    },
    getOfficialWrapperDetail: async () => ({ status: 'unavailable' })
  }
  const available = await loadOfficialWrapperGroups(
    windowApiStub,
    officialWrapperGroupsQuery('sam', 'modules', 0, 10)
  )
  assert.equal(available.source, 'official')
  assert.deepEqual(observed, { q: 'sam', category: 'modules', page: 1, pageSize: 10 })
  assert.deepEqual(await loadOfficialWrapperDetail(windowApiStub, tool().id), {
    source: 'fallback'
  })
  assert.deepEqual(
    await loadOfficialWrapperGroups(
      { listOfficialWrapperGroups: async () => Promise.reject(new Error('offline')) },
      {}
    ),
    { source: 'fallback' }
  )
  assert.deepEqual(await loadOfficialWrapperGroups({}, {}), { source: 'fallback' })
})

test('suite rows render API category data and group tool counts', () => {
  const markup = themed(
    createElement(OfficialWrapperGroupsView, {
      page: groupsPage(),
      categoryId: 'modules',
      query: 'sam',
      loading: false,
      busy: false,
      rowsPerPage: 10,
      onCategoryChange: () => undefined,
      onQueryChange: () => undefined,
      onPageChange: () => undefined,
      onRowsPerPageChange: () => undefined,
      onOpen: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(markup, /data-phi-wrapper-catalog-group="samtools"/)
  assert.match(markup, />samtools</)
  assert.match(markup, />模块</)
  assert.match(markup, />2 tools</)
  assert.match(markup, /Search Wrapper groups/)
})

test('suite tools default to the first item and list short labels filter by name', () => {
  const split = splitTool()
  assert.equal(officialWrapperDefaultToolId([tool(), split]), tool().id)
  assert.equal(officialWrapperDefaultToolId([tool(), split], split.id), split.id)
  assert.equal(officialWrapperDefaultToolId([], tool().id), undefined)
  assert.equal(officialWrapperToolShortName('samtools', 'SAMtools sort'), 'sort')
  assert.equal(officialWrapperToolShortName('samtools', 'Split reads'), 'Split reads')
  assert.deepEqual(
    filterOfficialWrapperTools([tool(), split], 'split').map((entry) => entry.id),
    [split.id]
  )
})

test('suite tools load every service page for the split list', async () => {
  const queries: Array<{ group: string; page?: number; pageSize?: number }> = []
  const api: OfficialWrapperCatalogApi = {
    listOfficialWrapperTools: async (query) => {
      queries.push(query)
      const page = query.page ?? 1
      return {
        status: 'available',
        data: {
          ...toolsPage(),
          items: page === 1 ? [tool()] : [splitTool()],
          total: 2,
          page,
          pageSize: 100,
          pageCount: 2
        }
      }
    }
  }
  const result = await loadOfficialWrapperSuiteTools(api, 'samtools')
  assert.equal(result.source, 'official')
  if (result.source === 'official')
    assert.deepEqual(
      result.data.map((item) => item.id),
      [tool().id, splitTool().id]
    )
  assert.deepEqual(queries, [
    { group: 'samtools', page: 1, pageSize: 100 },
    { group: 'samtools', page: 2, pageSize: 100 }
  ])
})

test('suite split view renders the tool list and the first tool detail', () => {
  const choice = officialWrapperToolChoices([tool()], [registryChoice()])
  const suiteMarkup = themed(
    createElement(OfficialWrapperSuiteView, {
      suite: 'samtools',
      choices: choice,
      selectedToolId: tool().id,
      detail: detail(),
      query: '',
      loading: false,
      detailLoading: false,
      busy: false,
      renderSuiteAction: () => createElement('button', { 'data-suite-action': 'true' }, 'Install'),
      onQueryChange: () => undefined,
      onSelect: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(suiteMarkup, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-sort"/)
  assert.match(suiteMarkup, />sort</)
  assert.match(suiteMarkup, /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-sort"/)
  assert.match(suiteMarkup, /Sort a BAM file/)
  assert.match(suiteMarkup, />Phi</)
  assert.doesNotMatch(suiteMarkup, /Phi Website/)
  assert.doesNotMatch(suiteMarkup, /Phi Packages/)
  assert.match(suiteMarkup, /Search tools/)
  assert.match(suiteMarkup, /1 tool/)
  assert.doesNotMatch(suiteMarkup, /data-phi-catalog-detail-title/)
  const detailStart = suiteMarkup.indexOf('data-phi-official-wrapper-suite-detail')
  const actionStart = suiteMarkup.indexOf('data-suite-action="true"')
  assert.ok(
    actionStart >= 0 && actionStart < detailStart,
    'the group action renders in the header, not inside the tool detail'
  )
  assert.doesNotMatch(
    suiteMarkup.slice(detailStart),
    /data-suite-action="true"/,
    'the tool detail has no per-tool action'
  )

  const manifest = officialWrapperDetailManifest(detail())
  assert.equal(manifest.params.bam?.kind, 'input')
  assert.equal(manifest.params.threads?.kind, 'option')
  assert.equal(manifest.outputs.sorted_bam?.type, 'file')
  const detailMarkup = themed(
    createElement(OfficialWrapperDetailPage, {
      detail: detail(),
      choice: choice[0]!.choice,
      action: createElement('span', null, 'Install'),
      onBack: () => undefined
    })
  )
  assert.match(detailMarkup, /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-sort"/)
  assert.match(detailMarkup, /SAMtools sort/)
  assert.match(detailMarkup, />Phi</)
  assert.doesNotMatch(detailMarkup, /Phi Website/)
  assert.doesNotMatch(detailMarkup, /Phi Packages/)
  assert.match(detailMarkup, /Input BAM/)
  assert.match(detailMarkup, />Inputs</)
  assert.match(detailMarkup, />Outputs</)
})

test('suite header shows the group name, tool count and exactly one group action', () => {
  const choices = officialWrapperToolChoices([tool(), splitTool()], [])
  const markup = themed(
    createElement(OfficialWrapperSuiteView, {
      suite: 'samtools',
      choices,
      selectedToolId: tool().id,
      detail: detail(),
      query: '',
      loading: false,
      detailLoading: false,
      busy: false,
      renderSuiteAction: (suite, current) =>
        createElement('button', { 'data-suite-action': `${suite}:${current.length}` }, 'Install'),
      onQueryChange: () => undefined,
      onSelect: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(markup, /data-phi-wrapper-suite-header="true"/)
  assert.match(markup, />samtools</)
  assert.match(markup, />2 tools</)
  assert.equal(markup.match(/data-suite-action="/g)?.length, 1)
  assert.doesNotMatch(markup, /data-phi-catalog-detail-divider/)
  assert.equal(markup.match(/data-phi-wrapper-suite-divider="true"/g)?.length, 1)
  const headerStart = markup.indexOf('data-phi-wrapper-suite-header="true"')
  const actionStart = markup.indexOf('data-suite-action="')
  const detailStart = markup.indexOf('data-phi-official-wrapper-suite-detail')
  assert.ok(actionStart > headerStart && actionStart < detailStart)
  assert.doesNotMatch(markup.slice(detailStart), /data-suite-action="/)
})

test('CatalogDetailFrame renders its header divider by default and can omit it', () => {
  const frame = (headerDivider?: boolean): string => {
    const props: React.ComponentProps<typeof CatalogDetailFrame> = {
      entryId: 'suite',
      backLabel: 'Back to list',
      action: createElement('span', { 'data-frame-action': 'true' }, 'Action'),
      headerDivider,
      onBack: () => undefined,
      children: createElement('div', null, 'Content')
    }
    return themed(createElement(CatalogDetailFrame, props))
  }

  const defaultFrame = frame()
  assert.match(defaultFrame, /data-phi-catalog-detail-divider="true"/)
  assert.match(defaultFrame, /data-frame-action="true"/)
  assert.match(defaultFrame, /Content/)

  const noDivider = frame(false)
  assert.doesNotMatch(noDivider, /data-phi-catalog-detail-divider/)
  assert.match(noDivider, /Content/)
})

test('suite search filters the list and selecting another tool renders its detail', () => {
  const sort = tool()
  const split = splitTool()
  const choices = officialWrapperToolChoices([sort, split], [])
  const renderSuite = (
    query: string,
    selectedToolId: string,
    selectedDetail: PhiWrapperCatalogDetail
  ): string =>
    themed(
      createElement(OfficialWrapperSuiteView, {
        suite: 'samtools',
        choices,
        selectedToolId,
        detail: selectedDetail,
        query,
        loading: false,
        detailLoading: false,
        busy: false,
        renderSuiteAction: () => createElement('span', null, 'Install'),
        onQueryChange: () => undefined,
        onSelect: () => undefined,
        onBack: () => undefined,
        onClose: () => undefined
      })
    )

  const filtered = renderSuite('split', split.id, detailFor(split))
  assert.doesNotMatch(filtered, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-sort"/)
  assert.match(filtered, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-split"/)
  assert.match(filtered, />split</)
  assert.match(filtered, /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-split"/)
  assert.doesNotMatch(
    filtered,
    /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-sort"/
  )

  const selected = renderSuite('', split.id, detailFor(split))
  assert.match(selected, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-sort"/)
  assert.match(selected, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-split"/)
  assert.match(selected, /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-split"/)
  assert.doesNotMatch(
    selected,
    /data-phi-official-wrapper-detail="nf-core\/modules\/samtools-sort"/
  )
})

test('the wrapper detail shows the module tier once when the website category matches it', () => {
  setUiLanguage('zh-CN')
  const choice = officialWrapperToolChoices([tool()], [registryChoice()])
  const markup = themed(
    createElement(OfficialWrapperDetailPage, {
      detail: detail(),
      choice: choice[0]!.choice,
      action: createElement('span', null, 'Install'),
      onBack: () => undefined
    })
  )
  assert.equal(markup.match(/>模块</g)?.length, 1)
})

test('new Chinese Wrapper catalog copy includes the required group and tool wording', () => {
  setUiLanguage('zh-CN')
  const groupsMarkup = themed(
    createElement(OfficialWrapperGroupsView, {
      page: groupsPage(),
      categoryId: 'all',
      query: '',
      loading: false,
      busy: false,
      rowsPerPage: 10,
      onCategoryChange: () => undefined,
      onQueryChange: () => undefined,
      onPageChange: () => undefined,
      onRowsPerPageChange: () => undefined,
      onOpen: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(groupsMarkup, /工具组/)
  assert.match(groupsMarkup, /2 个工具/)

  const toolsMarkup = themed(
    createElement(OfficialWrapperSuiteView, {
      suite: 'samtools',
      choices: officialWrapperToolChoices([tool()], [registryChoice()]),
      selectedToolId: tool().id,
      detail: detail(),
      query: '',
      loading: false,
      detailLoading: false,
      busy: false,
      renderSuiteAction: () => null,
      onQueryChange: () => undefined,
      onSelect: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(toolsMarkup, /搜索工具/)
  assert.match(toolsMarkup, /1 个工具/)
})
