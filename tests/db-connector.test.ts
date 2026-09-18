import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EntrezAdapter,
  buildEntrezFetchParams,
  buildEntrezSearchParams,
  buildEntrezSummaryParams,
  entrezTermFromFilters
} from '../src/main/agent/db/adapters/entrez-adapter'
import {
  RestJsonAdapter,
  buildRestJsonRequest
} from '../src/main/agent/db/adapters/rest-json-adapter'
import { SparqlAdapter, buildSparqlQuery } from '../src/main/agent/db/adapters/sparql-adapter'
import {
  addCustomDbConnector,
  listDbConnectorCatalog,
  syncGeneratedDbConnectorDocs
} from '../src/main/agent/db/catalog'
import {
  buildGeneratedDbConnectorDocs,
  writeGeneratedDbConnectorDocs
} from '../src/main/agent/db/docs-generator'
import { parseDbConnectorManifest } from '../src/main/agent/db/manifest'
import type { DbAdapter } from '../src/main/agent/db/adapters/types'
import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbQueryToolDetails,
  DbResolvedQuery,
  DbQueryToolErrorDetails
} from '../src/main/agent/db/manifest-types'
import {
  DbHttpError,
  executeDbHttpRequest,
  isRetryableDbFailure,
  resolveDbEgressTransport,
  retryDelayMs,
  type DbEgressTransport
} from '../src/main/agent/db/policy'
import { buildDbQueryToolDetails } from '../src/main/agent/db/result-writer'
import {
  allowCustomDbConnector,
  getDbConnectorAuditLogPath,
  getDbConnectorFieldGlossaryPath,
  getDbConnectorNavigatorSkillPath
} from '../src/main/agent/db/store'
import {
  buildDbDomainTool,
  buildDbDocsSearchTool,
  buildDbQueryTool,
  buildDbSearchTool,
  buildDefaultDbCustomTools,
  isDbConnectorRuntimeEnabled
} from '../src/main/agent/db/tools'

function withHarness<T>(
  callback: (h: { root: string; agentDir: string }) => T | Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-db-connector-'))
  const agentDir = join(root, '.phi-home')
  return Promise.resolve(callback({ root, agentDir })).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

function connectorYaml(id = 'rest-json/toy'): string {
  return `phiDbConnectorVersion: 1
id: ${id}
name: Toy DB
protocolFamily: rest-json
curationTier: curated
baseUrl: https://api.example.org/v1
networkPolicy:
  allowedHosts:
    - api.example.org
  allowRedirects: false
auth:
  type: none
retryPolicy:
  maxAttempts: 3
  baseDelayMs: 500
  maxDelayMs: 5000
domains:
  - id: gene
    summary: Gene records.
    commonFields: [symbol, description]
    rest:
      request:
        path: /genes/{filter:symbol}
        queryParams:
          content-type: application/json
        filterParamMap:
          organism: species
        rawQueryParam: q
        limitParam: limit
        cursorParam: offset
      response:
        rowsPath: data
        totalRowsPath: meta.total
        nextCursorPath: meta.next
    fields:
      - name: symbol
        type: string
        description: Gene symbol.
        namespace: hgnc.symbol
`
}

function writeConnector(dir: string, yaml = connectorYaml()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'connector.yaml'), yaml, 'utf-8')
}

function fakeCtx(): never {
  return {} as never
}

function readAuditEvents(agentDir: string): Array<Record<string, unknown>> {
  const auditPath = getDbConnectorAuditLogPath(agentDir)
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('parseDbConnectorManifest validates trust source separation and required shape', () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  assert.equal(parsed.manifest?.id, 'rest-json/toy')

  const invalid = parseDbConnectorManifest(`${connectorYaml()}\ntrustTier: bundled\n`)
  assert.equal(invalid.valid, false)
  assert.match(invalid.errors.join('\n'), /trustTier/)
})

test('custom connector catalog requires digest-bound allow-list before query is enabled', async () => {
  await withHarness(({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    const entry = addCustomDbConnector(sourceDir, agentDir)
    assert.equal(entry.enabledForQuery, false)
    assert.equal(existsSync(getDbConnectorNavigatorSkillPath(agentDir)), true)
    assert.equal(existsSync(getDbConnectorFieldGlossaryPath(agentDir)), true)
    assert.match(
      readFileSync(getDbConnectorNavigatorSkillPath(agentDir), 'utf-8'),
      /rest-json\/toy/
    )
    assert.match(readFileSync(getDbConnectorFieldGlossaryPath(agentDir), 'utf-8'), /Toy DB/)

    let catalog = listDbConnectorCatalog(agentDir).filter(
      (item) => item.manifest.id === 'rest-json/toy'
    )
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].enabledForQuery, false)

    allowCustomDbConnector(entry.manifest.id, entry.digest, agentDir)
    catalog = listDbConnectorCatalog(agentDir).filter(
      (item) => item.manifest.id === 'rest-json/toy'
    )
    assert.equal(catalog[0].enabledForQuery, true)
  })
})

test('db_search and db_domain expose connector/domain metadata', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    addCustomDbConnector(sourceDir, agentDir)

    const search = await buildDbSearchTool(agentDir).execute(
      'call-1',
      { query: 'gene' },
      undefined,
      fakeCtx()
    )
    const searchDetails = search.details as {
      results: Array<{ id: string; enabledForQuery: boolean }>
    }
    assert.equal(
      searchDetails.results.some((item) => item.id === 'rest-json/toy'),
      true
    )

    const domain = await buildDbDomainTool(agentDir).execute(
      'call-2',
      { database: 'rest-json/toy', domain: 'gene' },
      undefined,
      fakeCtx()
    )
    assert.equal(domain.isError, undefined)
    const domainDetails = domain.details as { fields: Array<{ name: string }> }
    assert.deepEqual(
      domainDetails.fields.map((field) => field.name),
      ['symbol']
    )
  })
})

test('db_docs_search returns ranked manifest docs, fields, and xref hints', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    addCustomDbConnector(sourceDir, agentDir)

    const tool = buildDbDocsSearchTool(agentDir)
    const fieldSearch = await tool.execute(
      'call-docs-1',
      { query: 'hgnc', database: 'rest-json/toy', limit: 5 },
      undefined,
      fakeCtx()
    )
    assert.equal(fieldSearch.isError, undefined)
    const fieldDetails = fieldSearch.details as {
      kind: string
      query: string
      results: Array<{
        kind: string
        database: string
        domain?: string
        field?: string
        namespace?: string
        score: number
        matchReasons: string[]
      }>
    }
    assert.equal(fieldDetails.kind, 'db_docs_search_results')
    assert.equal(fieldDetails.query, 'hgnc')
    assert.equal(fieldDetails.results[0].kind, 'field')
    assert.equal(fieldDetails.results[0].database, 'rest-json/toy')
    assert.equal(fieldDetails.results[0].domain, 'gene')
    assert.equal(fieldDetails.results[0].field, 'symbol')
    assert.equal(fieldDetails.results[0].namespace, 'hgnc.symbol')
    assert.equal(fieldDetails.results[0].score > 0, true)
    assert.equal(fieldDetails.results[0].matchReasons.length > 0, true)

    const domainSearch = await tool.execute(
      'call-docs-2',
      { keyword: 'Gene records', domain: 'gene', limit: 2 },
      undefined,
      fakeCtx()
    )
    const domainDetails = domainSearch.details as {
      results: Array<{ kind: string; domain?: string; snippet: string }>
    }
    assert.equal(domainDetails.results[0].domain, 'gene')
    assert.match(domainDetails.results[0].snippet, /Gene records/)

    const xrefSearch = await buildDbDocsSearchTool().execute(
      'call-docs-3',
      { query: 'uniprot accession', database: 'entrez/ncbi', limit: 10 },
      undefined,
      fakeCtx()
    )
    const xrefDetails = xrefSearch.details as {
      results: Array<{ kind: string; xref?: { to: { database?: string; namespace?: string } } }>
    }
    assert.equal(
      xrefDetails.results.some(
        (result) =>
          result.kind === 'xref' &&
          result.xref?.to.database === 'sparql/uniprot' &&
          result.xref.to.namespace === 'uniprot.gene_name'
      ),
      true
    )
  })
})

test('generated DB connector docs include navigator guidance and field glossary artifacts', async () => {
  await withHarness(({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    addCustomDbConnector(sourceDir, agentDir)
    const entries = listDbConnectorCatalog(agentDir)
    const generatedAt = new Date('2026-09-17T00:00:00.000Z')

    const docs = buildGeneratedDbConnectorDocs(entries, generatedAt)
    assert.match(docs.navigatorSkillMarkdown, /# DB Navigator/)
    assert.match(docs.navigatorSkillMarkdown, /db_search/)
    assert.match(docs.navigatorSkillMarkdown, /infer the database\/domain yourself/)
    assert.match(docs.navigatorSkillMarkdown, /Do not ask the user to name the tool function/)
    assert.match(docs.navigatorSkillMarkdown, /Do not make HTTP requests directly/)
    assert.match(docs.navigatorSkillMarkdown, /entrez\/ncbi/)
    assert.match(docs.fieldGlossaryMarkdown, /# DB Connector Field Glossary/)
    assert.match(docs.fieldGlossaryMarkdown, /entrez\/ncbi - NCBI Entrez/)
    assert.match(docs.fieldGlossaryMarkdown, /hgnc\.symbol/)
    assert.match(docs.fieldGlossaryMarkdown, /sparql\/uniprot\/protein\.gene_name/)

    const paths = writeGeneratedDbConnectorDocs(entries, agentDir, generatedAt)
    assert.equal(paths.navigatorSkillPath, getDbConnectorNavigatorSkillPath(agentDir))
    assert.equal(paths.fieldGlossaryPath, getDbConnectorFieldGlossaryPath(agentDir))
    assert.equal(existsSync(paths.navigatorSkillPath), true)
    assert.equal(existsSync(paths.fieldGlossaryPath), true)
    assert.match(readFileSync(paths.navigatorSkillPath, 'utf-8'), /Common Question Routing/)
    assert.match(readFileSync(paths.fieldGlossaryPath, 'utf-8'), /Clinical variant assertions/)

    const synced = syncGeneratedDbConnectorDocs(agentDir)
    assert.equal(synced.navigatorSkillPath, paths.navigatorSkillPath)
    assert.equal(synced.fieldGlossaryPath, paths.fieldGlossaryPath)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /rest-json\/toy - Toy DB/)
  })
})

test('DB connector tool descriptions steer agents to route biological database intents automatically', () => {
  const descriptions = buildDefaultDbCustomTools()
    .filter((tool) => tool.name.startsWith('db_'))
    .map((tool) => tool.description)
    .join('\n')

  assert.match(descriptions, /infer the database\/domain from the user intent/)
  assert.match(descriptions, /Prefer db_\* over general web search/)
  assert.match(descriptions, /user should not need to name tool functions/)
  assert.match(descriptions, /NCBI Entrez/)
  assert.match(descriptions, /PubMed/)
  assert.match(descriptions, /ClinVar/)
  assert.match(descriptions, /UniProt/)
})

test('result writer keeps small results inline and writes large results to artifact files', async () => {
  await withHarness(({ agentDir }) => {
    const provenance = {
      database: 'rest-json/toy',
      domain: 'gene',
      retrievedAt: '2026-09-17T00:00:00.000Z'
    }
    const resolvedQuery: DbResolvedQuery = {
      database: 'rest-json/toy',
      domain: 'gene',
      inferred: true,
      targetSource: 'heuristic',
      predicateSource: 'heuristic',
      input: { source: 'query', text: 'TP53 gene' },
      filters: [{ field: 'symbol', op: '=', value: 'TP53' }],
      reasons: ['converted query text into portable filters']
    }
    const small = buildDbQueryToolDetails(
      { rows: [{ symbol: 'TP53' }], truncated: false, provenance },
      { agentDir, resolvedQuery }
    )
    assert.equal(small.mode, 'inline')
    assert.deepEqual(small.resolvedQuery, resolvedQuery)

    const rows = Array.from({ length: 30 }, (_, index) => ({
      symbol: `GENE${index}`,
      description: 'x'.repeat(100)
    }))
    const large = buildDbQueryToolDetails(
      { rows, totalRows: rows.length, truncated: false, provenance },
      { agentDir, fileStem: 'large-result', resolvedQuery }
    )
    assert.equal(large.mode, 'artifact')
    assert.equal(existsSync(large.artifact.path), true)
    assert.equal(readFileSync(large.artifact.path, 'utf-8').split('\n').filter(Boolean).length, 30)
    assert.equal(large.artifact.format, 'jsonl')
    assert.equal(large.csvArtifact?.format, 'csv')
    assert.equal(large.metadataArtifact.format, 'metadata_json')
    assert.equal(existsSync(large.csvArtifact?.path ?? ''), true)
    assert.equal(existsSync(large.metadataArtifact.path), true)
    assert.equal(large.artifacts.length, 3)
    const csv = readFileSync(large.csvArtifact?.path ?? '', 'utf-8')
    assert.match(csv.split('\n')[0], /symbol,description/)
    const metadata = JSON.parse(readFileSync(large.metadataArtifact.path, 'utf-8')) as {
      kind: string
      summary: { rowCount: number }
      resolvedQuery: DbResolvedQuery
      schema: { fields: Array<{ name: string; types: string[]; nullable: boolean }> }
      artifacts: Array<{ format: string; path: string }>
    }
    assert.equal(metadata.kind, 'db_query_metadata')
    assert.equal(metadata.summary.rowCount, rows.length)
    assert.deepEqual(metadata.resolvedQuery, resolvedQuery)
    assert.deepEqual(
      metadata.schema.fields.map((field) => [field.name, field.types, field.nullable]),
      [
        ['symbol', ['string'], false],
        ['description', ['string'], false]
      ]
    )
    assert.deepEqual(
      metadata.artifacts.map((artifact) => artifact.format),
      ['jsonl', 'csv']
    )
    assert.equal(large.sampleRows.length, 5)

    const nested = buildDbQueryToolDetails(
      {
        rows: Array.from({ length: 30 }, (_, index) => ({
          symbol: `GENE${index}`,
          aliases: [`ALIAS${index}`]
        })),
        totalRows: 30,
        truncated: false,
        provenance
      },
      { agentDir, fileStem: 'nested-result' }
    )
    assert.equal(nested.mode, 'artifact')
    assert.equal(nested.csvArtifact, undefined)
    assert.deepEqual(
      nested.artifacts.map((artifact) => artifact.format),
      ['jsonl', 'metadata_json']
    )
  })
})

test('retry policy classifies transient and deterministic failures', () => {
  assert.equal(isRetryableDbFailure({ status: 429 }), true)
  assert.equal(isRetryableDbFailure({ status: 503 }), true)
  assert.equal(isRetryableDbFailure({ status: 401 }), false)
  assert.equal(isRetryableDbFailure({ errorName: 'TimeoutError' }), true)
  assert.equal(isRetryableDbFailure({ errorName: 'TypeError' }), true)
  assert.equal(isRetryableDbFailure({ errorName: 'AbortError' }), false)
  assert.equal(isRetryableDbFailure({ validationFailed: true }), false)
  assert.equal(retryDelayMs(3, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 1200 }), 1200)
  assert.equal(retryDelayMs(1, undefined, 10_000), 5000)
})

test('HTTP policy executor validates hosts and retries transient responses', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let calls = 0
  const transport: DbEgressTransport = {
    name: 'test-egress',
    async fetch(input) {
      calls += 1
      assert.equal(input.hostname, 'api.example.org')
      assert.equal(input.pathname, '/v1/genes')
      return new Response(JSON.stringify({ ok: true }), { status: calls === 1 ? 503 : 200 })
    }
  }

  const response = await executeDbHttpRequest({
    manifest,
    path: 'genes',
    transport,
    cacheTtlMs: 0,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    sleep: async () => {}
  })
  assert.equal(response.attempts, 2)
  assert.equal(response.retried, true)
  assert.equal(response.lastStatus, 200)
  assert.equal(calls, 2)
})

test('HTTP policy executor resolves default proxy mode before fetching', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let proxyCalls = 0
  const proxyTransport: DbEgressTransport = {
    name: 'proxy-test',
    async fetch(input) {
      proxyCalls += 1
      assert.equal(input.hostname, 'api.example.org')
      return new Response('{}', { status: 200 })
    }
  }

  const response = await executeDbHttpRequest({
    manifest,
    path: 'genes',
    defaultProxyMode: 'enabled',
    proxyTransport,
    cacheTtlMs: 0,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    sleep: async () => {}
  })
  assert.equal(response.transportName, 'proxy-test')
  assert.equal(response.defaultProxyMode, 'enabled')
  assert.equal(proxyCalls, 1)

  assert.equal(
    resolveDbEgressTransport({ defaultProxyMode: 'disabled', proxyTransport }).transportName,
    'system'
  )
  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'genes',
        defaultProxyMode: 'enabled',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: async () => {}
      }),
    (error) => error instanceof DbHttpError && error.code === 'DB_PROXY_UNAVAILABLE'
  )
})

test('HTTP policy executor caches idempotent GET responses and writes redacted audit events', async () => {
  await withHarness(async ({ agentDir }) => {
    const parsed = parseDbConnectorManifest(connectorYaml('rest-json/cache-toy'))
    assert.equal(parsed.valid, true)
    const manifest = parsed.manifest as DbConnectorManifest
    let calls = 0
    let now = Date.parse('2026-09-17T00:00:00.000Z')
    const transport: DbEgressTransport = {
      name: 'cache-test',
      async fetch(input) {
        calls += 1
        assert.equal(input.searchParams.get('access_token'), 'super-secret-token')
        return new Response(JSON.stringify({ calls }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    }

    const first = await executeDbHttpRequest({
      manifest,
      path: 'genes',
      searchParams: { q: 'BRCA1', access_token: 'super-secret-token' },
      transport,
      agentDir,
      now: () => now,
      cacheTtlMs: 60_000,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {}
    })
    assert.deepEqual(await first.response.json(), { calls: 1 })

    now += 1_000
    const second = await executeDbHttpRequest({
      manifest,
      path: 'genes',
      searchParams: { q: 'BRCA1', access_token: 'super-secret-token' },
      transport,
      agentDir,
      now: () => now,
      cacheTtlMs: 60_000,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {}
    })

    assert.deepEqual(await second.response.json(), { calls: 1 })
    assert.equal(calls, 1)
    assert.equal(second.cached, true)
    assert.equal(second.attempts, 0)

    const events = readAuditEvents(agentDir).filter(
      (event) => event.database === 'rest-json/cache-toy'
    )
    assert.deepEqual(
      events.map((event) => event.outcome),
      ['success', 'cache_hit']
    )
    for (const event of events) {
      assert.equal(typeof event.redactedUrl, 'string')
      assert.doesNotMatch(event.redactedUrl as string, /super-secret-token/)
      assert.match(event.redactedUrl as string, /access_token=REDACTED/)
    }
  })
})

test('HTTP policy executor expires GET response cache after ttl', async () => {
  await withHarness(async ({ agentDir }) => {
    const parsed = parseDbConnectorManifest(connectorYaml('rest-json/cache-expiry-toy'))
    assert.equal(parsed.valid, true)
    const manifest = parsed.manifest as DbConnectorManifest
    let calls = 0
    let now = 1_000
    const transport: DbEgressTransport = {
      name: 'cache-expiry-test',
      async fetch() {
        calls += 1
        return new Response(JSON.stringify({ calls }), { status: 200 })
      }
    }
    const options = {
      manifest,
      path: 'genes',
      transport,
      agentDir,
      now: () => now,
      cacheTtlMs: 10,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {}
    }

    const first = await executeDbHttpRequest(options)
    assert.deepEqual(await first.response.json(), { calls: 1 })
    now += 11
    const second = await executeDbHttpRequest(options)
    assert.deepEqual(await second.response.json(), { calls: 2 })
    assert.equal(calls, 2)
    assert.equal(second.cached, undefined)
  })
})

test('HTTP policy executor applies manifest rate limits before uncached requests', async () => {
  await withHarness(async ({ agentDir }) => {
    const parsed = parseDbConnectorManifest(connectorYaml('rest-json/rate-limit-toy'))
    assert.equal(parsed.valid, true)
    const manifest = {
      ...(parsed.manifest as DbConnectorManifest),
      rateLimit: {
        withoutAuth: { requestsPerSecond: 2 }
      }
    } satisfies DbConnectorManifest
    let calls = 0
    let now = 0
    const sleeps: number[] = []
    const transport: DbEgressTransport = {
      name: 'rate-limit-test',
      async fetch() {
        calls += 1
        return new Response(JSON.stringify({ calls }), { status: 200 })
      }
    }
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
      now += ms
    }

    await executeDbHttpRequest({
      manifest,
      path: 'genes',
      transport,
      agentDir,
      now: () => now,
      cacheTtlMs: 0,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep
    })
    await executeDbHttpRequest({
      manifest,
      path: 'genes',
      transport,
      agentDir,
      now: () => now,
      cacheTtlMs: 0,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep
    })

    assert.equal(calls, 2)
    assert.deepEqual(sleeps, [500])
  })
})

test('HTTP policy executor blocks disallowed hosts before transport fetch', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('{}', { status: 200 })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'https://other.example.org/v1/genes',
        transport,
        sleep: async () => {}
      }),
    (error) => error instanceof DbHttpError && error.code === 'DB_POLICY_BLOCKED'
  )
  assert.equal(calls, 0)
})

test('HTTP policy executor blocks localhost and private literal hosts', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = {
    ...(parsed.manifest as DbConnectorManifest),
    baseUrl: 'https://127.0.0.1/v1',
    networkPolicy: { allowedHosts: ['127.0.0.1'], allowRedirects: false }
  }
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('{}', { status: 200 })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'genes',
        transport,
        sleep: async () => {}
      }),
    (error) => error instanceof DbHttpError && error.code === 'DB_POLICY_BLOCKED'
  )
  assert.equal(calls, 0)
})

test('HTTP policy executor revalidates every allowed redirect hop', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = {
    ...(parsed.manifest as DbConnectorManifest),
    networkPolicy: { allowedHosts: ['api.example.org'], allowRedirects: true }
  }
  const seen: string[] = []
  const transport: DbEgressTransport = {
    async fetch(input) {
      seen.push(input.toString())
      if (seen.length === 1) {
        return new Response('', {
          status: 302,
          headers: { location: '/v1/genes?redirected=true' }
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
  }

  const response = await executeDbHttpRequest({
    manifest,
    path: 'redirect',
    transport,
    cacheTtlMs: 0,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    sleep: async () => {}
  })

  assert.equal(response.lastStatus, 200)
  assert.equal(seen.length, 2)
  assert.equal(new URL(seen[1]).hostname, 'api.example.org')
  assert.equal(new URL(seen[1]).searchParams.get('redirected'), 'true')
})

test('HTTP policy executor blocks redirects to disallowed hosts before follow-up fetch', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = {
    ...(parsed.manifest as DbConnectorManifest),
    networkPolicy: { allowedHosts: ['api.example.org'], allowRedirects: true }
  }
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('', {
        status: 302,
        headers: { location: 'https://other.example.org/v1/genes' }
      })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'redirect',
        transport,
        cacheTtlMs: 0,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: async () => {}
      }),
    (error) => error instanceof DbHttpError && error.code === 'DB_POLICY_BLOCKED'
  )
  assert.equal(calls, 1)
})

test('HTTP policy executor does not retry deterministic auth failures', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('{}', { status: 401 })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'genes',
        transport,
        cacheTtlMs: 0,
        retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: async () => {}
      }),
    (error) =>
      error instanceof DbHttpError && error.code === 'DB_HTTP_STATUS' && error.retryable === false
  )
  assert.equal(calls, 1)
})

test('HTTP policy executor redacts query secrets in structured errors', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = {
    ...(parsed.manifest as DbConnectorManifest),
    auth: {
      type: 'api_key_query_param',
      envVar: 'PHI_TEST_DB_API_KEY',
      paramName: 'api_key'
    }
  } satisfies DbConnectorManifest
  const previousSecret = process.env.PHI_TEST_DB_API_KEY
  process.env.PHI_TEST_DB_API_KEY = 'super-secret-token'
  let observedUrl = ''
  const transport: DbEgressTransport = {
    async fetch(input) {
      observedUrl = input.toString()
      return new Response('{}', { status: 401 })
    }
  }

  try {
    await assert.rejects(
      () =>
        executeDbHttpRequest({
          manifest,
          path: 'genes',
          transport,
          cacheTtlMs: 0,
          retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
          sleep: async () => {}
        }),
      (error) => {
        assert.equal(error instanceof DbHttpError, true)
        const dbError = error as DbHttpError
        assert.equal(dbError.code, 'DB_HTTP_STATUS')
        assert.match(observedUrl, /super-secret-token/)
        assert.doesNotMatch(dbError.safeDetails.redactedUrl, /super-secret-token/)
        assert.match(dbError.safeDetails.redactedUrl, /api_key=REDACTED/)
        return true
      }
    )
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PHI_TEST_DB_API_KEY
    } else {
      process.env.PHI_TEST_DB_API_KEY = previousSecret
    }
  }
})

test('HTTP policy executor reports pre-cancelled requests without fetching', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('{}', { status: 200 })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'genes',
        transport,
        signal: controller.signal,
        cacheTtlMs: 0,
        sleep: async () => {}
      }),
    (error) =>
      error instanceof DbHttpError && error.code === 'DB_REQUEST_CANCELLED' && error.attempts === 0
  )
  assert.equal(calls, 0)
})

test('HTTP policy executor blocks oversized responses', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let calls = 0
  const transport: DbEgressTransport = {
    async fetch() {
      calls += 1
      return new Response('0123456789', { status: 200 })
    }
  }

  await assert.rejects(
    () =>
      executeDbHttpRequest({
        manifest,
        path: 'genes',
        transport,
        maxResponseBytes: 5,
        cacheTtlMs: 0,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: async () => {}
      }),
    (error) =>
      error instanceof DbHttpError &&
      error.code === 'DB_RESPONSE_TOO_LARGE' &&
      error.status === 200 &&
      error.attempts === 1
  )
  assert.equal(calls, 1)
})

test('RestJson adapter maps filter templates, query params, rows, and provenance', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const domain = manifest.domains[0]
  const request = buildRestJsonRequest(domain, {
    domain: 'gene',
    filters: [
      { field: 'symbol', op: '=', value: 'BRCA1' },
      { field: 'organism', op: '=', value: '9606' }
    ],
    limit: 1,
    cursor: '10'
  })
  assert.equal(request.path, '/genes/BRCA1')
  assert.equal(request.searchParams.get('species'), '9606')
  assert.equal(request.searchParams.get('limit'), '1')
  assert.equal(request.searchParams.get('offset'), '10')
  assert.equal(request.searchParams.get('content-type'), 'application/json')

  let calls = 0
  const adapter = new RestJsonAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-rest-json',
      async fetch(input) {
        calls += 1
        assert.equal(input.hostname, 'api.example.org')
        assert.equal(input.pathname, '/v1/genes/BRCA1')
        assert.equal(input.searchParams.get('species'), '9606')
        assert.equal(input.searchParams.get('limit'), '1')
        assert.equal(input.searchParams.get('offset'), '10')
        return new Response(
          JSON.stringify({
            data: [
              { symbol: 'BRCA1', description: 'DNA repair associated', extra: 'kept' },
              { symbol: 'BRCA1P1', description: 'Pseudogene' }
            ],
            meta: { total: 12, next: '11' }
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query(
    {
      domain: 'gene',
      filters: [
        { field: 'symbol', op: '=', value: 'BRCA1' },
        { field: 'organism', op: '=', value: '9606' }
      ],
      fields: ['symbol', 'description'],
      limit: 1,
      cursor: '10'
    },
    { defaultProxyMode: 'disabled' }
  )

  assert.equal(calls, 1)
  assert.deepEqual(result.rows, [{ symbol: 'BRCA1', description: 'DNA repair associated' }])
  assert.equal(result.totalRows, 12)
  assert.equal(result.truncated, true)
  assert.equal(result.nextCursor, '11')
  assert.equal(result.provenance.database, 'rest-json/toy')
  assert.equal(result.provenance.domain, 'gene')
  assert.equal(result.provenance.rawQueryUsed, false)
  assert.equal(result.provenance.attempts, 1)
  assert.equal(result.provenance.transportName, 'mock-rest-json')
  assert.equal(result.provenance.defaultProxyMode, 'disabled')
})

test('RestJson adapter supports rawQuery params and single-object responses', async () => {
  const yaml = connectorYaml('rest-json/rawtoy').replace(
    'path: /genes/{filter:symbol}',
    'path: /genes'
  )
  const parsed = parseDbConnectorManifest(yaml)
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new RestJsonAdapter(manifest, {
    sleep: async () => {},
    transport: {
      name: 'mock-rest-json-raw',
      async fetch(input) {
        assert.equal(input.pathname, '/v1/genes')
        assert.equal(input.searchParams.get('q'), 'TP53')
        assert.equal(input.searchParams.get('limit'), '5')
        return new Response(
          JSON.stringify({
            data: { symbol: 'TP53', description: 'Tumor protein p53' },
            meta: { total: 1 }
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query({
    domain: 'gene',
    rawQuery: 'TP53',
    limit: 5
  })

  assert.deepEqual(result.rows, [{ symbol: 'TP53', description: 'Tumor protein p53' }])
  assert.equal(result.totalRows, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.provenance.rawQueryUsed, true)
})

test('Sparql adapter renders bounded SELECT queries and parses SPARQL JSON rows', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/sparql/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const domain = manifest.domains[0]
  const rendered = buildSparqlQuery(domain, {
    domain: 'protein',
    filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
    limit: 2,
    cursor: '4'
  })
  assert.match(rendered, /UCASE\("BRCA1"\)/)
  assert.match(rendered, /LIMIT 2/)
  assert.match(rendered, /OFFSET 4/)

  let calls = 0
  const adapter = new SparqlAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-sparql',
      async fetch(input) {
        calls += 1
        assert.equal(input.hostname, 'sparql.uniprot.org')
        assert.equal(input.pathname, '/sparql')
        assert.equal(input.searchParams.get('format'), 'json')
        const query = input.searchParams.get('query') ?? ''
        assert.match(query, /gene_name/)
        assert.match(query, /LIMIT 2/)
        assert.match(query, /OFFSET 4/)
        return new Response(
          JSON.stringify({
            head: { vars: ['accession', 'mnemonic', 'protein_name', 'gene_name', 'organism'] },
            results: {
              bindings: [
                {
                  accession: { type: 'literal', value: 'P38398' },
                  mnemonic: { type: 'literal', value: 'BRCA1_HUMAN' },
                  protein_name: {
                    type: 'literal',
                    value: 'Breast cancer type 1 susceptibility protein'
                  },
                  gene_name: { type: 'literal', value: 'BRCA1' },
                  organism: { type: 'literal', value: 'Homo sapiens' }
                },
                {
                  accession: { type: 'literal', value: 'Q9BX63' },
                  mnemonic: { type: 'literal', value: 'FANCJ_HUMAN' },
                  protein_name: { type: 'literal', value: 'Fanconi anemia group J protein' },
                  gene_name: { type: 'literal', value: 'BRIP1' },
                  organism: { type: 'literal', value: 'Homo sapiens' }
                }
              ]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/sparql-results+json' } }
        )
      }
    }
  })

  const result = await adapter.query(
    {
      domain: 'protein',
      filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
      fields: ['accession', 'gene_name', 'protein_name'],
      limit: 2,
      cursor: '4'
    },
    { defaultProxyMode: 'disabled' }
  )

  assert.equal(calls, 1)
  assert.deepEqual(result.rows[0], {
    accession: 'P38398',
    gene_name: 'BRCA1',
    protein_name: 'Breast cancer type 1 susceptibility protein'
  })
  assert.equal(result.rows.length, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.nextCursor, '6')
  assert.equal(result.provenance.database, 'sparql/uniprot')
  assert.equal(result.provenance.transportName, 'mock-sparql')
  assert.equal(result.provenance.defaultProxyMode, 'disabled')
})

test('Sparql adapter clamps rawQuery with a caller-supplied limit', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/sparql/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const query = buildSparqlQuery(manifest.domains[0], {
    domain: 'protein',
    rawQuery: 'SELECT ?accession WHERE { ?s ?p ?o } LIMIT 5000',
    limit: 3
  })
  assert.doesNotMatch(query, /LIMIT 5000/)
  assert.match(query, /LIMIT 3/)
})

test('Entrez adapter translates filters into an Entrez query string', () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest)
  assert.equal(adapter instanceof EntrezAdapter, true)
  assert.equal(entrezTermFromFilters([{ field: 'gene', op: '=', value: 'BRCA1' }]), 'BRCA1[gene]')
  const params = buildEntrezSearchParams(manifest, {
    domain: 'gene',
    filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
    limit: 10
  })
  assert.equal(params.get('db'), 'gene')
  assert.equal(params.get('term'), 'BRCA1[gene]')
  assert.equal(params.get('retmax'), '10')
  const summaryParams = buildEntrezSummaryParams(manifest, { domain: 'gene' }, ['672', '675'])
  assert.equal(summaryParams.get('db'), 'gene')
  assert.equal(summaryParams.get('id'), '672,675')
  assert.equal(summaryParams.get('retmode'), 'json')
  const fetchParams = buildEntrezFetchParams(manifest, { domain: 'pubmed' }, ['40000001'])
  assert.equal(fetchParams.get('db'), 'pubmed')
  assert.equal(fetchParams.get('id'), '40000001')
  assert.equal(fetchParams.get('retmode'), 'xml')
})

test('Entrez adapter queries esearch and esummary through the DB HTTP policy executor', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  let calls = 0
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi',
      async fetch(input) {
        calls += 1
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'gene')
          assert.equal(input.searchParams.get('term'), 'BRCA1[gene]')
          if (calls === 1) return new Response('{}', { status: 503 })
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '3',
                idlist: ['672', '675']
              }
            }),
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'gene')
        assert.equal(input.searchParams.get('id'), '672,675')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['672', '675'],
              '672': {
                uid: '672',
                name: 'BRCA1',
                description: 'BRCA1 DNA repair associated',
                chromosome: '17',
                maplocation: '17q21.31',
                otheraliases: 'BRCC1, FANCS',
                organism: { scientificname: 'Homo sapiens', commonname: 'human', taxid: 9606 }
              },
              '675': {
                uid: '675',
                name: 'BRCA2',
                description: 'BRCA2 DNA repair associated',
                chromosome: '13'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query({
    domain: 'gene',
    filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
    limit: 2
  })

  assert.equal(result.rows[0].uid, '672')
  assert.equal(result.rows[0].symbol, 'BRCA1')
  assert.equal(result.rows[0].description, 'BRCA1 DNA repair associated')
  assert.deepEqual(result.rows[0].aliases, ['BRCC1', 'FANCS'])
  assert.deepEqual(result.rows[0].organism, {
    scientificName: 'Homo sapiens',
    commonName: 'human',
    taxId: 9606
  })
  assert.equal(result.rows[1].symbol, 'BRCA2')
  assert.equal(result.totalRows, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.nextCursor, '2')
  assert.equal(result.provenance.retried, true)
  assert.equal(result.provenance.attempts, 3)
  assert.equal(result.provenance.lastStatus, 200)
  assert.equal(result.provenance.transportName, 'mock-ncbi')
  assert.equal(result.provenance.defaultProxyMode, 'auto')
})

test('Entrez adapter normalizes PubMed efetch abstracts and ClinVar esummary rows', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-summary',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        const db = input.searchParams.get('db')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: db === 'pubmed' ? ['40000001'] : ['VCV000012345']
              }
            }),
            { status: 200 }
          )
        }

        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(db, 'pubmed')
          assert.equal(input.searchParams.get('id'), '40000001')
          return new Response(
            `<?xml version="1.0"?>
            <PubmedArticleSet>
              <PubmedArticle>
                <MedlineCitation>
                  <PMID>40000001</PMID>
                  <Article>
                    <Abstract>
                      <AbstractText Label="BACKGROUND">BRCA1 participates in DNA repair.</AbstractText>
                      <AbstractText Label="RESULTS">Repair signaling increased after perturbation.</AbstractText>
                    </Abstract>
                  </Article>
                </MedlineCitation>
              </PubmedArticle>
            </PubmedArticleSet>`,
            { status: 200 }
          )
        }

        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        if (db === 'pubmed') {
          assert.equal(input.searchParams.get('id'), '40000001')
          return new Response(
            JSON.stringify({
              result: {
                uids: ['40000001'],
                '40000001': {
                  uid: '40000001',
                  title: 'BRCA1 repair biology review',
                  pubdate: '2026 Sep',
                  fulljournalname: 'Nature Genetics',
                  authors: [{ name: 'Case A' }, { name: 'Smith B' }],
                  articleids: [
                    { idtype: 'pubmed', value: '40000001' },
                    { idtype: 'doi', value: '10.1234/brca1.review' }
                  ]
                }
              }
            }),
            { status: 200 }
          )
        }

        assert.equal(db, 'clinvar')
        assert.equal(input.searchParams.get('id'), 'VCV000012345')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['VCV000012345'],
              VCV000012345: {
                uid: 'VCV000012345',
                title: 'NM_007294.4(BRCA1):c.68_69del',
                accession: 'VCV000012345',
                variation_id: '12345',
                clinical_significance: { description: 'Pathogenic' },
                gene: 'BRCA1'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const pubmed = await adapter.query({
    domain: 'pubmed',
    rawQuery: 'BRCA1 repair',
    limit: 1
  })
  assert.equal(pubmed.rows[0].uid, '40000001')
  assert.equal(pubmed.rows[0].title, 'BRCA1 repair biology review')
  assert.deepEqual(pubmed.rows[0].authors, ['Case A', 'Smith B'])
  assert.equal(pubmed.rows[0].journal, 'Nature Genetics')
  assert.equal(pubmed.rows[0].pubdate, '2026 Sep')
  assert.equal(pubmed.rows[0].doi, '10.1234/brca1.review')
  assert.equal(
    pubmed.rows[0].abstract,
    'BACKGROUND: BRCA1 participates in DNA repair.\nRESULTS: Repair signaling increased after perturbation.'
  )
  assert.equal(pubmed.provenance.attempts, 3)

  const clinvar = await adapter.query({
    domain: 'clinvar',
    rawQuery: 'BRCA1[gene]',
    limit: 1
  })
  assert.equal(clinvar.rows[0].uid, 'VCV000012345')
  assert.equal(clinvar.rows[0].title, 'NM_007294.4(BRCA1):c.68_69del')
  assert.equal(clinvar.rows[0].accession, 'VCV000012345')
  assert.equal(clinvar.rows[0].variation_id, '12345')
  assert.equal(clinvar.rows[0].clinical_significance, 'Pathogenic')
  assert.equal(clinvar.rows[0].gene, 'BRCA1')
})

test('db_query infers database, domain, and filters from natural biological query text', async () => {
  await withHarness(async ({ agentDir }) => {
    let received: unknown
    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        received = params
        return {
          rows: [{ symbol: 'BRCA1', description: 'BRCA1 DNA repair associated' }],
          truncated: false,
          provenance: {
            database: 'entrez/ncbi',
            domain: params.domain,
            retrievedAt: '2026-09-18T00:00:00.000Z'
          }
        }
      }
    }

    const result = await buildDbQueryTool({ 'entrez/ncbi': adapter }, agentDir).execute(
      'call-infer-gene',
      { query: 'BRCA1 gene information', limit: 3 },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    const details = result.details as DbQueryToolDetails
    assert.equal(details.kind, 'db_query_result')
    assert.equal(details.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(details.resolvedQuery?.domain, 'gene')
    assert.equal(details.resolvedQuery?.inferred, true)
    assert.equal(details.resolvedQuery?.targetSource, 'heuristic')
    assert.equal(details.resolvedQuery?.predicateSource, 'heuristic')
    assert.deepEqual(details.resolvedQuery?.input, {
      source: 'query',
      text: 'BRCA1 gene information'
    })
    assert.deepEqual(details.resolvedQuery?.filters, [{ field: 'gene', op: '=', value: 'BRCA1' }])
    assert.equal(
      details.resolvedQuery?.reasons.some((reason) =>
        reason.includes('converted query text into portable filters')
      ),
      true
    )
    assert.deepEqual(received, {
      domain: 'gene',
      filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
      fields: undefined,
      limit: 3,
      cursor: undefined,
      rawQuery: undefined
    })
  })
})

test('db_query infers PubMed and UniProt intents without user naming db tools', async () => {
  await withHarness(async ({ agentDir }) => {
    const received: Array<{ database: string; params: unknown }> = []
    const pubmedAdapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        received.push({ database: 'entrez/ncbi', params })
        return {
          rows: [{ uid: '40000001', title: 'BRCA1 repair biology review' }],
          truncated: false,
          provenance: {
            database: 'entrez/ncbi',
            domain: params.domain,
            retrievedAt: '2026-09-18T00:00:00.000Z'
          }
        }
      }
    }
    const uniprotAdapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        received.push({ database: 'sparql/uniprot', params })
        return {
          rows: [{ accession: 'P38398', gene_name: 'BRCA1' }],
          truncated: false,
          provenance: {
            database: 'sparql/uniprot',
            domain: params.domain,
            retrievedAt: '2026-09-18T00:00:00.000Z'
          }
        }
      }
    }

    const tool = buildDbQueryTool(
      { 'entrez/ncbi': pubmedAdapter, 'sparql/uniprot': uniprotAdapter },
      agentDir
    )
    const pubmed = await tool.execute(
      'call-infer-pubmed',
      { query: 'PubMed BRCA1 DNA repair abstract', limit: 1 },
      undefined,
      fakeCtx()
    )
    const uniprot = await tool.execute(
      'call-infer-uniprot',
      { query: 'UniProt protein accession for BRCA1', limit: 2 },
      undefined,
      fakeCtx()
    )

    assert.equal(pubmed.isError, undefined)
    assert.equal(uniprot.isError, undefined)
    const pubmedDetails = pubmed.details as DbQueryToolDetails
    const uniprotDetails = uniprot.details as DbQueryToolDetails
    assert.equal(pubmedDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(pubmedDetails.resolvedQuery?.domain, 'pubmed')
    assert.equal(pubmedDetails.resolvedQuery?.rawQuery, 'PubMed BRCA1 DNA repair abstract')
    assert.equal(pubmedDetails.resolvedQuery?.predicateSource, 'heuristic')
    assert.equal(uniprotDetails.resolvedQuery?.database, 'sparql/uniprot')
    assert.equal(uniprotDetails.resolvedQuery?.domain, 'protein')
    assert.deepEqual(uniprotDetails.resolvedQuery?.filters, [
      { field: 'gene_name', op: '=', value: 'BRCA1' }
    ])
    assert.equal(uniprotDetails.resolvedQuery?.targetSource, 'heuristic')
    assert.deepEqual(received[0], {
      database: 'entrez/ncbi',
      params: {
        domain: 'pubmed',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'PubMed BRCA1 DNA repair abstract'
      }
    })
    assert.deepEqual(received[1], {
      database: 'sparql/uniprot',
      params: {
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
        fields: undefined,
        limit: 2,
        cursor: undefined,
        rawQuery: undefined
      }
    })
  })
})

test('default DB custom tools register bundled Entrez and query through the adapter', async () => {
  await withHarness(async ({ agentDir }) => {
    let calls = 0
    const tools = buildDefaultDbCustomTools(agentDir, {
      entrez: {
        now: () => new Date('2026-09-17T00:00:00.000Z'),
        sleep: async () => {},
        transport: {
          name: 'mock-default-entrez',
          async fetch(input) {
            calls += 1
            assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
            if (input.pathname.endsWith('/esearch.fcgi')) {
              assert.equal(input.searchParams.get('db'), 'gene')
              assert.equal(input.searchParams.get('term'), 'BRCA1')
              return new Response(
                JSON.stringify({
                  esearchresult: {
                    count: '2',
                    idlist: ['91001', '91002']
                  }
                }),
                { status: 200 }
              )
            }
            assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
            assert.equal(input.searchParams.get('db'), 'gene')
            assert.equal(input.searchParams.get('id'), '91001,91002')
            return new Response(
              JSON.stringify({
                result: {
                  uids: ['91001', '91002'],
                  '91001': {
                    uid: '91001',
                    name: 'BRCA1',
                    description: 'BRCA1 DNA repair associated'
                  },
                  '91002': {
                    uid: '91002',
                    name: 'BRCA2',
                    description: 'BRCA2 DNA repair associated'
                  }
                }
              }),
              { status: 200 }
            )
          }
        }
      }
    })
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.approval]),
      [
        ['db_search', 'read'],
        ['db_domain', 'read'],
        ['db_query', 'read'],
        ['db_docs_search', 'read']
      ]
    )

    const query = tools.find((tool) => tool.name === 'db_query')
    assert.ok(query)
    const result = await query.execute(
      'call-default-entrez',
      {
        database: 'entrez/ncbi',
        domain: 'gene',
        rawQuery: 'BRCA1',
        limit: 2
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    assert.equal(calls, 2)
    const details = result.details as {
      mode: string
      rows?: Array<Record<string, unknown>>
      provenance?: { transportName?: string }
    }
    assert.equal(details.mode, 'inline')
    assert.equal(details.rows?.[0]?.symbol, 'BRCA1')
    assert.equal(details.rows?.[1]?.symbol, 'BRCA2')
    assert.equal(details.provenance?.transportName, 'mock-default-entrez')
  })
})

test('DB connector runtime flag parser accepts explicit enabling values', () => {
  assert.equal(isDbConnectorRuntimeEnabled(undefined), false)
  assert.equal(isDbConnectorRuntimeEnabled('0'), false)
  assert.equal(isDbConnectorRuntimeEnabled('1'), true)
  assert.equal(isDbConnectorRuntimeEnabled('true'), true)
  assert.equal(isDbConnectorRuntimeEnabled('yes'), true)
  assert.equal(isDbConnectorRuntimeEnabled(true), true)
})

test('db_query refuses disabled custom connectors and summarizes enabled mock adapter results', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    const entry = addCustomDbConnector(sourceDir, agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProxyMode: 'disabled' }))
    let receivedDefaultProxyMode: unknown

    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(_params, context): Promise<DbAdapterQueryResult> {
        receivedDefaultProxyMode = context?.defaultProxyMode
        return {
          rows: [{ symbol: 'TP53' }],
          truncated: false,
          provenance: {
            database: 'rest-json/toy',
            domain: 'gene',
            retrievedAt: '2026-09-17T00:00:00.000Z',
            attempts: 1
          }
        }
      }
    }

    const tool = buildDbQueryTool({ 'rest-json/toy': adapter }, agentDir)
    const disabled = await tool.execute(
      'call-1',
      {
        database: 'rest-json/toy',
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'TP53' }]
      },
      undefined,
      fakeCtx()
    )
    assert.equal(disabled.isError, true)
    const disabledDetails = disabled.details as DbQueryToolErrorDetails
    assert.equal(disabledDetails.kind, 'db_query_error')
    assert.equal(disabledDetails.code, 'connector_not_enabled')
    assert.match(disabledDetails.message, /尚未启用查询/)

    allowCustomDbConnector(entry.manifest.id, entry.digest, agentDir)
    const enabled = await tool.execute(
      'call-2',
      {
        database: 'rest-json/toy',
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'TP53' }]
      },
      undefined,
      fakeCtx()
    )
    assert.equal(enabled.isError, undefined)
    const details = enabled.details as { mode: string; rows?: unknown[] }
    assert.equal(details.mode, 'inline')
    assert.deepEqual(details.rows, [{ symbol: 'TP53' }])
    assert.equal(receivedDefaultProxyMode, 'disabled')

    const proxyFailingAdapter: DbAdapter = {
      ...adapter,
      async query() {
        throw new DbHttpError(
          'DB connector proxy mode is enabled, but no proxy transport is configured',
          {
            code: 'DB_PROXY_UNAVAILABLE',
            retryable: false,
            attempts: 0,
            redactedUrl: 'https://api.example.org/v1/genes',
            transportName: 'proxy'
          }
        )
      }
    }
    const proxyFailure = await buildDbQueryTool(
      { 'rest-json/toy': proxyFailingAdapter },
      agentDir
    ).execute(
      'call-3',
      {
        database: 'rest-json/toy',
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'TP53' }]
      },
      undefined,
      fakeCtx()
    )
    assert.equal(proxyFailure.isError, true)
    assert.match(proxyFailure.content[0].text, /DB_PROXY_UNAVAILABLE/)
    const proxyFailureDetails = proxyFailure.details as DbQueryToolErrorDetails
    assert.equal(proxyFailureDetails.kind, 'db_query_error')
    assert.equal(proxyFailureDetails.code, 'DB_PROXY_UNAVAILABLE')
    assert.match(proxyFailureDetails.message, /proxy mode is enabled/)
    assert.equal(proxyFailureDetails.retryable, false)
    assert.equal(proxyFailureDetails.attempts, 0)
    assert.equal(proxyFailureDetails.safeDetails?.transportName, 'proxy')
    assert.equal(proxyFailureDetails.safeDetails?.redactedUrl, 'https://api.example.org/v1/genes')
  })
})
