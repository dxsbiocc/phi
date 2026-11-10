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
import {
  loadOfficialWrapperDetail,
  loadOfficialWrapperGroups,
  officialWrapperCategoryGroups,
  officialWrapperDetailManifest,
  officialWrapperGroupsQuery,
  officialWrapperRegistryId,
  officialWrapperToolChoices,
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

function tool(): PhiWrapperCatalogTool {
  return {
    id: 'nf-core/modules/samtools-sort',
    name: 'SAMtools sort',
    summary: 'Sort a BAM file.',
    category: 'modules',
    categoryLabel: '模块',
    path: 'resources/wrappers/modules/nf-core/samtools/sort/wrapper',
    version: '1.2.0',
    source: 'Phi Packages',
    suite: 'samtools'
  }
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

function detail(): PhiWrapperCatalogDetail {
  return {
    kind: 'wrapper',
    id: tool().id,
    name: tool().name,
    summary: tool().summary,
    category: 'modules',
    categoryLabel: '模块',
    path: tool().path,
    version: tool().version,
    source: tool().source,
    suite: 'samtools',
    inputs: [
      { name: 'bam', kind: 'input', type: 'file', required: true, description: 'Input BAM.' },
      { name: 'threads', kind: 'option', type: 'integer', required: false }
    ],
    outputs: [{ name: 'sorted_bam', kind: 'output', type: 'file', required: true }],
    structure: { inputs: ['bam', 'threads'], process: 'SAMtools sort', outputs: ['sorted_bam'] },
    siblings: [{ id: tool().id, name: tool().name, tool: 'sort' }]
  }
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

test('group tools and selected detail render website metadata through existing Wrapper patterns', () => {
  const choice = officialWrapperToolChoices([tool()], [registryChoice()])
  const suiteMarkup = themed(
    createElement(OfficialWrapperSuiteView, {
      suite: 'samtools',
      page: toolsPage(),
      choices: choice,
      query: 'sort',
      loading: false,
      busy: false,
      rowsPerPage: 10,
      renderAction: () => createElement('span', { 'data-registry-action': 'true' }, 'Install'),
      onQueryChange: () => undefined,
      onPageChange: () => undefined,
      onRowsPerPageChange: () => undefined,
      onOpen: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(suiteMarkup, /data-phi-wrapper-catalog-tool="nf-core\/modules\/samtools-sort"/)
  assert.match(suiteMarkup, /Sort a BAM file/)
  assert.match(suiteMarkup, /Phi Website/)
  assert.doesNotMatch(suiteMarkup, /Phi Packages/)
  assert.match(suiteMarkup, /data-registry-action="true"/)
  assert.match(suiteMarkup, /Search tools/)

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
  assert.match(detailMarkup, /Phi Website/)
  assert.doesNotMatch(detailMarkup, /Phi Packages/)
  assert.match(detailMarkup, /Input BAM/)
  assert.match(detailMarkup, />Inputs</)
  assert.match(detailMarkup, />Outputs</)
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
      page: toolsPage(),
      choices: officialWrapperToolChoices([tool()], [registryChoice()]),
      query: '',
      loading: false,
      busy: false,
      rowsPerPage: 10,
      renderAction: () => null,
      onQueryChange: () => undefined,
      onPageChange: () => undefined,
      onRowsPerPageChange: () => undefined,
      onOpen: () => undefined,
      onBack: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(toolsMarkup, /搜索工具/)
})
