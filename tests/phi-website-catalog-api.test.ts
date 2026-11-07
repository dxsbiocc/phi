import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getOfficialWebsiteSkillDetail,
  getOfficialWebsiteSkillGroups,
  getOfficialWebsiteSkills,
  getOfficialWebsiteWrapperDetail,
  getOfficialWebsiteWrapperGroups,
  getOfficialWebsiteWrapperTools
} from '../src/main/agent/packages/official-website-catalog'
import type { PhiWebsiteCatalogResult } from '../src/shared/phiWebsiteCatalogTypes'

function options(value: unknown): { fetch: typeof fetch; timeoutMs: number } {
  return {
    fetch: async () => Response.json(value),
    timeoutMs: 50
  }
}

async function data<T>(result: Promise<PhiWebsiteCatalogResult<T>>): Promise<T> {
  const resolved = await result
  assert.equal(resolved.status, 'available')
  if (resolved.status !== 'available') throw new Error('expected available catalog data')
  return resolved.data
}

async function unavailable(result: Promise<PhiWebsiteCatalogResult<unknown>>): Promise<void> {
  assert.deepEqual(await result, { status: 'unavailable' })
}

function wrapperGroups(): Record<string, unknown> {
  return {
    view: 'groups',
    items: [
      {
        suite: 'samtools',
        count: 1,
        category: 'modules',
        categories: { modules: 1 },
        categoryLabel: '模块',
        href: 'https://untrusted.example/group',
        api: 'https://untrusted.example/api'
      }
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    categories: [{ id: 'modules', label: '模块', count: 1 }],
    groupsUrl: 'https://untrusted.example/groups'
  }
}

function wrapperTools(): Record<string, unknown> {
  return {
    view: 'tools',
    group: 'samtools',
    suite: 'samtools',
    items: [
      {
        id: 'nf-core/modules/samtools-sort',
        name: 'samtools sort',
        summary: 'Sort a BAM.',
        category: 'modules',
        categoryLabel: '模块',
        path: 'resources/wrappers/modules/nf-core/samtools/sort/wrapper',
        version: '1.0.0',
        source: 'Phi Packages',
        suite: 'samtools',
        packageUrl: 'https://untrusted.example/wrapper.yaml'
      }
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    categories: [{ id: 'modules', label: '模块', count: 1 }]
  }
}

function wrapperDetail(): Record<string, unknown> {
  return {
    kind: 'wrapper',
    id: 'nf-core/modules/samtools-sort',
    name: 'samtools sort',
    summary: 'Sort a BAM.',
    category: 'modules',
    categoryLabel: '模块',
    path: 'resources/wrappers/modules/nf-core/samtools/sort/wrapper',
    version: '1.0.0',
    source: 'Phi Packages',
    suite: 'samtools',
    inputs: [{ name: 'bam', kind: 'input', type: 'file', required: true }],
    outputs: [{ name: 'sorted_bam', kind: 'output', type: 'file' }],
    structure: { inputs: ['bam'], process: 'samtools sort', outputs: ['sorted_bam'] },
    siblings: [{ id: 'nf-core/modules/samtools-sort', name: 'samtools sort', tool: 'sort' }],
    packageUrl: 'https://untrusted.example/wrapper.yaml'
  }
}

function skillGroups(): Record<string, unknown> {
  return {
    view: 'groups',
    items: [
      {
        id: 'science',
        label: '科学分析',
        count: 1,
        href: 'https://untrusted.example/skills',
        api: 'https://untrusted.example/api'
      }
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1
  }
}

function skillList(): Record<string, unknown> {
  return {
    view: 'group',
    group: 'science',
    groupLabel: '科学分析',
    items: [
      {
        id: 'scanpy',
        slug: 'scanpy',
        kind: 'skill',
        title: 'Scanpy',
        description: 'Single-cell analysis.',
        path: 'resources/skills/scanpy',
        version: '1.0.0',
        sizeBytes: 1024,
        sizeLabel: '1 KB',
        source: 'Phi Packages',
        group: 'science',
        groupLabel: '科学分析',
        iconUrl: 'https://untrusted.example/icon.svg',
        packageUrl: 'https://untrusted.example/SKILL.md'
      }
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    pageCount: 1,
    groups: [{ id: 'science', label: '科学分析', count: 1 }]
  }
}

function skillDetail(): Record<string, unknown> {
  return {
    kind: 'skill',
    slug: 'scanpy',
    title: 'Scanpy',
    description: 'Single-cell analysis.',
    path: 'resources/skills/scanpy',
    version: '1.0.0',
    sizeBytes: 1024,
    sizeLabel: '1 KB',
    source: 'Phi Packages',
    markdown: '# Scanpy\n\nSafe Markdown body.',
    frontmatter: { name: 'scanpy', metadata: { version: '1.0.0' } },
    iconUrl: 'https://untrusted.example/icon.svg',
    packageUrl: 'https://untrusted.example/SKILL.md'
  }
}

test('wrapper groups validate, cap plain text, and drop unknown URL fields', async () => {
  const good = await data(getOfficialWebsiteWrapperGroups({}, options(wrapperGroups())))
  assert.deepEqual(good.items[0].categories, { modules: 1 })
  assert.equal('href' in good.items[0], false)
  assert.equal('groupsUrl' in good, false)

  const oversized = wrapperGroups()
  ;(oversized.items as Record<string, unknown>[])[0].categoryLabel = 'x'.repeat(20_000)
  assert.equal(
    (await data(getOfficialWebsiteWrapperGroups({}, options(oversized)))).items[0].categoryLabel
      .length,
    240
  )

  const wrong = wrapperGroups()
  ;(wrong.items as Record<string, unknown>[])[0].categories = ['modules']
  await unavailable(getOfficialWebsiteWrapperGroups({}, options(wrong)))
  const missing = wrapperGroups()
  delete missing.view
  await unavailable(getOfficialWebsiteWrapperGroups({}, options(missing)))
})

test('wrapper tool lists validate, cap text, and require the requested group fields', async () => {
  const requested: URL[] = []
  const good = await data(
    getOfficialWebsiteWrapperTools(
      { group: 'samtools', q: 'sort & index', category: 'modules', page: 1, pageSize: 10 },
      {
        fetch: async (input) => {
          requested.push(new URL(String(input)))
          return Response.json(wrapperTools())
        }
      }
    )
  )
  assert.equal(good.items[0].id, 'nf-core/modules/samtools-sort')
  assert.equal('packageUrl' in good.items[0], false)
  assert.equal(requested[0].searchParams.get('category'), 'modules')
  assert.equal(requested[0].searchParams.get('q'), 'sort & index')

  const oversized = wrapperTools()
  ;(oversized.items as Record<string, unknown>[])[0].summary = 'x'.repeat(20_000)
  assert.equal(
    (await data(getOfficialWebsiteWrapperTools({ group: 'samtools' }, options(oversized)))).items[0]
      .summary?.length,
    8_000
  )
  const wrong = wrapperTools()
  ;(wrong.items as Record<string, unknown>[])[0].summary = 42
  await unavailable(getOfficialWebsiteWrapperTools({ group: 'samtools' }, options(wrong)))
  const missing = wrapperTools()
  delete (missing.items as Record<string, unknown>[])[0].source
  await unavailable(getOfficialWebsiteWrapperTools({ group: 'samtools' }, options(missing)))
})

test('wrapper detail validates, caps lists/text, and drops website URLs', async () => {
  const good = await data(
    getOfficialWebsiteWrapperDetail('nf-core/modules/samtools-sort', options(wrapperDetail()))
  )
  assert.equal(good.structure.process, 'samtools sort')
  assert.equal('packageUrl' in good, false)

  const oversized = wrapperDetail()
  oversized.summary = 'x'.repeat(20_000)
  oversized.siblings = Array.from({ length: 300 }, () => ({
    id: 'nf-core/modules/samtools-sort',
    name: 'samtools sort',
    tool: 'sort'
  }))
  const capped = await data(
    getOfficialWebsiteWrapperDetail('nf-core/modules/samtools-sort', options(oversized))
  )
  assert.equal(capped.summary?.length, 8_000)
  assert.equal(capped.siblings.length, 256)

  const wrong = wrapperDetail()
  wrong.inputs = 'bam'
  await unavailable(
    getOfficialWebsiteWrapperDetail('nf-core/modules/samtools-sort', options(wrong))
  )
  const missing = wrapperDetail()
  delete missing.structure
  await unavailable(
    getOfficialWebsiteWrapperDetail('nf-core/modules/samtools-sort', options(missing))
  )
})

test('skill groups validate, cap labels, and reject wrong or missing fields', async () => {
  const good = await data(getOfficialWebsiteSkillGroups({}, options(skillGroups())))
  assert.equal(good.items[0].id, 'science')
  assert.equal('href' in good.items[0], false)

  const oversized = skillGroups()
  ;(oversized.items as Record<string, unknown>[])[0].label = 'x'.repeat(20_000)
  assert.equal(
    (await data(getOfficialWebsiteSkillGroups({}, options(oversized)))).items[0].label.length,
    240
  )
  const wrong = skillGroups()
  ;(wrong.items as Record<string, unknown>[])[0].count = '1'
  await unavailable(getOfficialWebsiteSkillGroups({}, options(wrong)))
  const missing = skillGroups()
  delete (missing.items as Record<string, unknown>[])[0].label
  await unavailable(getOfficialWebsiteSkillGroups({}, options(missing)))
})

test('skill group lists validate, cap text, and drop remote asset URLs', async () => {
  const good = await data(getOfficialWebsiteSkills({ group: 'science' }, options(skillList())))
  assert.equal(good.items[0].slug, 'scanpy')
  assert.equal('iconUrl' in good.items[0], false)
  assert.equal('packageUrl' in good.items[0], false)

  const oversized = skillList()
  ;(oversized.items as Record<string, unknown>[])[0].description = 'x'.repeat(20_000)
  assert.equal(
    (await data(getOfficialWebsiteSkills({ group: 'science' }, options(oversized)))).items[0]
      .description?.length,
    8_000
  )
  const wrong = skillList()
  ;(wrong.items as Record<string, unknown>[])[0].kind = 'plugin'
  await unavailable(getOfficialWebsiteSkills({ group: 'science' }, options(wrong)))
  const missing = skillList()
  delete (missing.items as Record<string, unknown>[])[0].groupLabel
  await unavailable(getOfficialWebsiteSkills({ group: 'science' }, options(missing)))
})

test('skill detail validates, caps markdown/text/frontmatter, and requires promised fields', async () => {
  const good = await data(getOfficialWebsiteSkillDetail('scanpy', options(skillDetail())))
  assert.equal(good.markdown, '# Scanpy\n\nSafe Markdown body.')
  assert.equal('iconUrl' in good, false)
  assert.equal('packageUrl' in good, false)

  const oversized = skillDetail()
  oversized.description = 'x'.repeat(20_000)
  oversized.markdown = 'm'.repeat(600_000)
  oversized.frontmatter = { tags: Array.from({ length: 200 }, (_, index) => `tag-${index}`) }
  const capped = await data(getOfficialWebsiteSkillDetail('scanpy', options(oversized)))
  assert.equal(capped.description.length, 8_000)
  assert.equal(capped.markdown.length, 512 * 1024)
  assert.equal((capped.frontmatter.tags as unknown[]).length, 128)

  const wrong = skillDetail()
  wrong.markdown = 42
  await unavailable(getOfficialWebsiteSkillDetail('scanpy', options(wrong)))
  const missing = skillDetail()
  delete missing.description
  await unavailable(getOfficialWebsiteSkillDetail('scanpy', options(missing)))
  const missingSize = skillDetail()
  delete missingSize.sizeBytes
  await unavailable(getOfficialWebsiteSkillDetail('scanpy', options(missingSize)))
})

test('catalog failures, timeouts, oversized responses, invalid inputs, and inconsistent pages are unavailable', async () => {
  await unavailable(
    getOfficialWebsiteSkillGroups({}, { fetch: async () => new Response(null, { status: 503 }) })
  )
  await unavailable(
    getOfficialWebsiteSkillGroups(
      {},
      {
        fetch: async () =>
          new Response('{}', {
            headers: { 'content-length': String(2 * 1024 * 1024) }
          })
      }
    )
  )
  await unavailable(
    getOfficialWebsiteSkillGroups(
      {},
      { fetch: async () => new Promise<Response>(() => {}), timeoutMs: 5 }
    )
  )
  await unavailable(getOfficialWebsiteWrapperDetail('../escape', options(wrapperDetail())))
  await unavailable(
    getOfficialWebsiteSkills({ group: 'science', pageSize: 101 }, options(skillList()))
  )

  const inconsistent = wrapperGroups()
  inconsistent.page = 2
  await unavailable(getOfficialWebsiteWrapperGroups({}, options(inconsistent)))
})
