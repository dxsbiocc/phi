import assert from 'node:assert/strict'
import test from 'node:test'

import { searchOfficialCatalog } from '../src/main/agent/packages/official-catalog-api'

function page(items: unknown[] = [], total = items.length, currentPage = 1): Response {
  return Response.json({
    items,
    total,
    page: currentPage,
    pageSize: 100,
    pageCount: Math.ceil(total / 100)
  })
}

test('official catalog searches the four fixed API routes with encoded query metadata only', async () => {
  const requests: URL[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(url)
    assert.equal(init?.redirect, 'error')
    return page([
      {
        id:
          url.pathname === '/api/wrappers'
            ? 'nf-core/modules/samtools/sort'
            : url.pathname === '/api/skills'
              ? 'anndata'
              : url.pathname === '/api/mcp'
                ? 'biorender'
                : 'visualization',
        packageUrl: 'https://untrusted.example/run.sh'
      }
    ])
  }
  const result = await searchOfficialCatalog('RNA & 中文/?', undefined, undefined, {
    fetch: fetcher
  })
  assert.equal(result.available, true)
  assert.deepEqual(requests.map((url) => url.pathname).sort(), [
    '/api/mcp',
    '/api/plugins',
    '/api/skills',
    '/api/wrappers'
  ])
  for (const url of requests) {
    assert.equal(url.origin, 'https://phi.omicsagent.cn')
    assert.equal(url.searchParams.get('q'), 'RNA & 中文/?')
    assert.equal(url.searchParams.get('page'), '1')
    assert.equal(url.searchParams.get('pageSize'), '100')
  }
  assert.deepEqual(result.matches, [
    { type: 'skill', id: 'anndata' },
    { type: 'mcp', id: 'biorender' },
    { type: 'plugin', id: 'visualization' },
    { type: 'wrapper', id: 'module-nf-core-samtools-sort' },
    { type: 'wrapper', id: 'module-nf-core-samtools' }
  ])
})

test('type filters use their own API route and reject unavailable or unsafe connector ids', async () => {
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    requests.push(new URL(String(input)).pathname)
    return page([
      { id: 'installable', catalogInstallable: true },
      { id: 'unavailable', catalogInstallable: false },
      { id: '../escape' },
      { id: 'https://example.test/connector' },
      { id: 'UPPERCASE' },
      { id: 'installable' }
    ])
  }
  assert.deepEqual(await searchOfficialCatalog('connector', 'mcp', undefined, { fetch: fetcher }), {
    available: true,
    matches: [{ type: 'mcp', id: 'installable' }]
  })
  assert.deepEqual(requests, ['/api/mcp'])
})

test('wrapper paths retain nested component names and the legacy grouped package candidate', async () => {
  const result = await searchOfficialCatalog('RNA', 'wrapper', undefined, {
    fetch: async () =>
      page([
        {
          id: 'nf-core/modules/samtools/bam_sort',
          path: 'resources/wrappers/modules/nf-core/samtools/bam_sort/wrapper'
        },
        {
          id: 'nf-core/subworkflows/rnaseq_qc/fastqc',
          path: 'resources/wrappers/subworkflows/nf-core/rnaseq_qc/fastqc/wrapper'
        },
        {
          id: 'local/workflows/rnaseq',
          path: 'resources/wrappers/workflows/rnaseq/wrapper'
        },
        { id: 'module-local-differential-expression' },
        {
          id: 'local/modules/rnaseq/deseq2',
          path: 'resources/wrappers/modules/local/rnaseq/../../deseq2/wrapper'
        },
        {
          id: 'nf-core/modules/samtools/view',
          path: 'resources/wrappers/modules/local/samtools/view/wrapper'
        }
      ])
  })
  assert.deepEqual(result.matches, [
    { type: 'wrapper', id: 'module-nf-core-samtools-bam-sort' },
    { type: 'wrapper', id: 'module-nf-core-samtools' },
    { type: 'wrapper', id: 'subworkflow-nf-core-rnaseq-qc-fastqc' },
    { type: 'wrapper', id: 'subworkflow-nf-core-rnaseq-qc' },
    { type: 'wrapper', id: 'workflow-local-rnaseq' },
    { type: 'wrapper', id: 'module-local-differential-expression' }
  ])
})

test('catalog pagination preserves every unique page match', async () => {
  const requests: number[] = []
  const result = await searchOfficialCatalog('test', 'skill', undefined, {
    fetch: async (input) => {
      const currentPage = Number(new URL(String(input)).searchParams.get('page'))
      requests.push(currentPage)
      return page([{ id: `skill-${currentPage}` }], 250, currentPage)
    }
  })
  assert.deepEqual(requests, [1, 2, 3])
  assert.deepEqual(
    result.matches,
    [1, 2, 3].map((number) => ({ type: 'skill', id: `skill-${number}` }))
  )
  assert.equal(result.notice, undefined)
})

test('grouped skill identities resolve the leaf package without treating groups as packages', async () => {
  const result = await searchOfficialCatalog('single-cell', 'skill', undefined, {
    fetch: async () =>
      page([
        { id: 'biology/single-cell/scanpy', path: 'resources/skills/biology/single-cell/scanpy' },
        { id: 'pysam', path: 'resources/skills/生物信息/pysam/SKILL.md' },
        { id: 'utilities/find-skills' },
        { id: 'find-skills' },
        { id: 'biology/../escape' },
        { id: 'biology/%2e%2e/escape' },
        { id: 'biology/scanpy', path: 'resources/skills/biology/rdkit' },
        { id: 'biology/scanpy', path: 'resources/plugins/biology/scanpy' },
        { id: 'scanpy', path: 'resources/skills/biology/../scanpy' },
        { id: 'https://example.test/scanpy' }
      ])
  })
  assert.equal(result.available, true)
  assert.deepEqual(result.matches, [
    { type: 'skill', id: 'scanpy' },
    { type: 'skill', id: 'pysam' },
    { type: 'skill', id: 'find-skills' }
  ])
})

test('large catalogs stop at a bounded page budget and report truncated metadata', async () => {
  const requests: number[] = []
  const result = await searchOfficialCatalog('test', 'plugin', undefined, {
    fetch: async (input) => {
      const currentPage = Number(new URL(String(input)).searchParams.get('page'))
      requests.push(currentPage)
      return page([{ id: `plugin-${currentPage}` }], 100_000, currentPage)
    }
  })
  assert.deepEqual(requests, [1, 2, 3, 4, 5])
  assert.equal(result.available, true)
  assert.match(result.notice ?? '', /truncated/)
})

test('malformed pages and failed requests remain unavailable for local signed-catalog fallback', async () => {
  const responses = [
    Response.json({ items: [] }),
    new Response('not json'),
    page(['not an item']),
    page([], 1, 2),
    new Response(null, { status: 503 })
  ]
  for (const response of responses) {
    const result = await searchOfficialCatalog('test', 'skill', undefined, {
      fetch: async () => response
    })
    assert.equal(result.available, false)
    assert.deepEqual(result.matches, [])
    assert.ok(result.notice)
  }
})

test('one failing API route reports partial unavailability while retaining successful metadata', async () => {
  const result = await searchOfficialCatalog('test', undefined, undefined, {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname
      return path === '/api/mcp'
        ? new Response(null, { status: 502 })
        : page([{ id: 'test-skill' }])
    }
  })
  assert.equal(result.available, false)
  assert.ok(result.matches.some((match) => match.type === 'skill' && match.id === 'test-skill'))
  assert.ok(result.notice)
})

test('oversized declared and streamed responses are bounded', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    new Response(' '.repeat(1024 * 1024 + 1))
  ]) {
    const result = await searchOfficialCatalog('test', 'skill', undefined, {
      fetch: async () => response
    })
    assert.equal(result.available, false)
    assert.match(result.notice ?? '', /Phi Website/)
  }
})

test('timeouts bound fetchers that do not implement cancellation', async () => {
  const result = await searchOfficialCatalog('test', 'skill', undefined, {
    timeoutMs: 5,
    fetch: async () => new Promise<Response>(() => {})
  })
  assert.equal(result.available, false)
  assert.match(result.notice ?? '', /timed out/)
})

test('caller aborts are propagated without being mistaken for offline fallback', async () => {
  const controller = new AbortController()
  const pending = searchOfficialCatalog('test', 'skill', controller.signal, {
    fetch: async () => new Promise<Response>(() => {})
  })
  const reason = new Error('cancel user task')
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  await assert.rejects(
    searchOfficialCatalog('test', 'skill', controller.signal, {
      fetch: async () => assert.fail('already aborted requests must not fetch')
    }),
    (error) => error === reason
  )
})

test('timeouts also cancel stalled response body readers', async () => {
  let cancelled = false
  const result = await searchOfficialCatalog('test', 'skill', undefined, {
    timeoutMs: 5,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true
          }
        })
      )
  })
  assert.equal(result.available, false)
  assert.equal(cancelled, true)
})

test('test transport origins still use fixed same-origin routes without path or credential injection', async () => {
  const requests: string[] = []
  const result = await searchOfficialCatalog('test', 'skill', undefined, {
    baseUrl: 'https://catalog.example.test/',
    fetch: async (input) => {
      requests.push(String(input))
      return page([])
    }
  })
  assert.equal(result.available, true)
  assert.deepEqual(requests, ['https://catalog.example.test/api/skills?q=test&page=1&pageSize=100'])
  for (const baseUrl of [
    'https://catalog.example.test/evil/path',
    'https://user:secret@catalog.example.test/',
    'https://catalog.example.test/?redirect=evil',
    'file:///tmp/catalog'
  ]) {
    const invalid = await searchOfficialCatalog('test', 'skill', undefined, {
      baseUrl,
      fetch: async () => assert.fail('invalid API origins must not fetch')
    })
    assert.equal(invalid.available, false)
  }
})
