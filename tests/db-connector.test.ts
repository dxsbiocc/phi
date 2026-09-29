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
  buildRestJsonRequest,
  parseTsvPayload
} from '../src/main/agent/db/adapters/rest-json-adapter'
import { OntologyAdapter } from '../src/main/agent/db/adapters/ontology-adapter'
import { KeggAdapter, buildKeggRequestPath } from '../src/main/agent/db/adapters/kegg-adapter'
import {
  keggListRowsToRecords,
  normalizeKeggCompoundRow,
  normalizeKeggGeneRow,
  parseKeggFlatRecords,
  parseKeggListText
} from '../src/main/agent/db/adapters/kegg-parser'
import { SparqlAdapter, buildSparqlQuery } from '../src/main/agent/db/adapters/sparql-adapter'
import {
  UniProtAdapter,
  buildUniProtKbSearchParams,
  directUniProtKbAccession
} from '../src/main/agent/db/adapters/uniprot-adapter'
import {
  addCustomDbConnector,
  findDbConnectorCatalogEntry,
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
  DbDownloadFileCandidate,
  DbDownloadToolDetails,
  DbQueryParams,
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
  getDbConnectorNavigatorSkillPath,
  getDbConnectorResultsDir,
  setDbConnectorQueryEnabled
} from '../src/main/agent/db/store'
import {
  buildDbDomainTool,
  buildDbDocsSearchTool,
  buildDbCustomTools,
  buildDbQueryTool,
  buildDbRoutesTool,
  buildDbSearchTool,
  buildDefaultDbAdapters,
  buildDefaultDbCustomTools
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

test('parseDbConnectorManifest validates explicit record identity contracts', () => {
  const validYaml = connectorYaml('rest-json/identity').replace(
    '    commonFields: [symbol, description]\n',
    `    commonFields: [symbol, description]\n    identity:\n      stableIdFields: [symbol]\n      namespace: hgnc.symbol\n      primaryUrlTemplate: https://example.org/gene/{stable_id}\n`
  )
  const valid = parseDbConnectorManifest(validYaml)
  assert.equal(valid.valid, true, valid.errors.join('\n'))
  assert.deepEqual(valid.manifest?.domains[0]?.identity, {
    stableIdFields: ['symbol'],
    namespace: 'hgnc.symbol',
    primaryUrlTemplate: 'https://example.org/gene/{stable_id}'
  })

  const unknownField = parseDbConnectorManifest(
    validYaml.replace('stableIdFields: [symbol]', 'stableIdFields: [missing_id]')
  )
  assert.equal(unknownField.valid, false)
  assert.match(unknownField.errors.join('\n'), /identity\.stableIdFields.*missing_id/)

  const insecureUrl = parseDbConnectorManifest(
    validYaml.replace('https://example.org/gene/{stable_id}', 'http://example.org/gene/{stable_id}')
  )
  assert.equal(insecureUrl.valid, false)
  assert.match(insecureUrl.errors.join('\n'), /identity\.primaryUrlTemplate.*https/)
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

test('connector lookup reuses unchanged manifests and refreshes one changed connector', async () => {
  await withHarness(({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    const installed = addCustomDbConnector(sourceDir, agentDir)
    const first = findDbConnectorCatalogEntry(installed.manifest.id, agentDir)
    const second = findDbConnectorCatalogEntry(installed.manifest.id, agentDir)
    assert.ok(first && second)
    assert.equal(first.manifest, second.manifest)

    writeFileSync(
      join(installed.installedPath, 'connector.yaml'),
      connectorYaml().replace('Gene records.', 'Updated gene records.'),
      'utf-8'
    )
    const changed = findDbConnectorCatalogEntry(installed.manifest.id, agentDir)
    assert.ok(changed)
    assert.notEqual(changed.manifest, first.manifest)
    assert.equal(changed.manifest.domains[0]?.summary, 'Updated gene records.')
    assert.notEqual(changed.digest, first.digest)

    allowCustomDbConnector(changed.manifest.id, changed.digest, agentDir)
    const enabled = findDbConnectorCatalogEntry(changed.manifest.id, agentDir)
    assert.ok(enabled)
    assert.equal(enabled.manifest, changed.manifest)
    assert.equal(enabled.enabledForQuery, true)
  })
})

test('db_search returns a bounded database shortlist without domain routes', async () => {
  await withHarness(async ({ agentDir }) => {
    const result = await buildDbSearchTool(agentDir).execute(
      'route-list',
      { query: 'gene' },
      undefined,
      fakeCtx()
    )
    const databases = JSON.parse(result.content[0]?.text ?? '[]') as Array<{
      id: string
    }>
    assert.ok(databases.length > 0)
    assert.ok(databases.length <= 8)
    assert.ok(databases.every((database) => !('domains' in database)))
  })
})

test('db_search and db_domain expose connector/domain metadata', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    addCustomDbConnector(sourceDir, agentDir)

    const search = await buildDbSearchTool(agentDir).execute(
      'call-1',
      { query: 'gene', limit: 50 },
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

    const ncbiDomain = await buildDbDomainTool(agentDir).execute(
      'call-3',
      { database: 'entrez/ncbi', domain: 'gene' },
      undefined,
      fakeCtx()
    )
    const ncbiDetails = ncbiDomain.details as {
      standardFields: string[]
      identity: { stableIdFields: string[]; namespace: string; primaryUrlTemplate: string }
    }
    assert.equal(ncbiDetails.standardFields.includes('stable_id'), true)
    assert.deepEqual(ncbiDetails.identity, {
      stableIdFields: ['uid'],
      namespace: 'ncbi.gene_id',
      primaryUrlTemplate: 'https://www.ncbi.nlm.nih.gov/gene/{stable_id}'
    })
  })
})

test('db_domain query examples satisfy the selected REST function input contract', async () => {
  await withHarness(async ({ agentDir }) => {
    for (const [database, domainId] of [
      ['rest-json/ensembl', 'lookup_symbol'],
      ['rest-json/mygene', 'gene']
    ]) {
      const result = await buildDbDomainTool(agentDir).execute(
        `domain-${domainId}`,
        { database, domain: domainId },
        undefined,
        fakeCtx()
      )
      const content = JSON.parse(result.content[0]?.text ?? '{}') as {
        queryInput: { example: { filters?: DbQueryParams['filters'] } }
      }
      const parsed = parseDbConnectorManifest(
        readFileSync(join('resources/db-connectors', database, 'connector.yaml'), 'utf-8')
      )
      const domain = parsed.manifest?.domains.find((candidate) => candidate.id === domainId)
      assert.ok(domain)
      assert.doesNotThrow(() =>
        buildRestJsonRequest(domain, {
          domain: domainId,
          filters: content.queryInput.example.filters,
          limit: 1
        })
      )
    }
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
      { keyword: 'Gene records', database: 'entrez/ncbi', domain: 'gene', limit: 2 },
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
      { query: 'uniprot accession', database: 'entrez/ncbi', limit: 30 },
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
          result.xref?.to.database === 'rest-json/uniprot' &&
          result.xref.to.namespace === 'hgnc.symbol'
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
    assert.match(docs.navigatorSkillMarkdown, /choose relevant databases first/)
    assert.match(docs.navigatorSkillMarkdown, /Do not ask the user to name the tool function/)
    assert.match(docs.navigatorSkillMarkdown, /Do not make HTTP requests directly/)
    assert.match(docs.navigatorSkillMarkdown, /entrez\/ncbi/)
    assert.match(docs.fieldGlossaryMarkdown, /# DB Connector Field Glossary/)
    assert.match(docs.fieldGlossaryMarkdown, /entrez\/ncbi - NCBI Entrez/)
    assert.match(docs.fieldGlossaryMarkdown, /hgnc\.symbol/)
    assert.match(docs.fieldGlossaryMarkdown, /sparql\/uniprot\/protein\.gene_name/)
    assert.match(docs.fieldGlossaryMarkdown, /Every returned record includes source metadata/)
    assert.match(docs.fieldGlossaryMarkdown, /Identity: `uid`; namespace `ncbi\.gene_id`/)

    const paths = writeGeneratedDbConnectorDocs(entries, agentDir, generatedAt)
    assert.equal(paths.navigatorSkillPath, getDbConnectorNavigatorSkillPath(agentDir))
    assert.equal(paths.fieldGlossaryPath, getDbConnectorFieldGlossaryPath(agentDir))
    assert.equal(existsSync(paths.navigatorSkillPath), true)
    assert.equal(existsSync(paths.fieldGlossaryPath), true)
    assert.match(readFileSync(paths.navigatorSkillPath, 'utf-8'), /Common Question Routing/)
    assert.match(readFileSync(paths.navigatorSkillPath, 'utf-8'), /rest-json\/uniprot\/protein/)
    assert.match(readFileSync(paths.navigatorSkillPath, 'utf-8'), /sparql\/uniprot\/protein/)
    assert.match(readFileSync(paths.navigatorSkillPath, 'utf-8'), /default UniProt route/)
    assert.match(
      readFileSync(paths.navigatorSkillPath, 'utf-8'),
      /Advanced UniProt RDF graph joins/
    )
    assert.match(readFileSync(paths.fieldGlossaryPath, 'utf-8'), /Clinical variant assertions/)

    const synced = syncGeneratedDbConnectorDocs(agentDir)
    assert.equal(synced.navigatorSkillPath, paths.navigatorSkillPath)
    assert.equal(synced.fieldGlossaryPath, paths.fieldGlossaryPath)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /rest-json\/toy - Toy DB/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI Protein records/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI Nucleotide records/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI BioSample records/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /UniProtKB REST/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /Primary\/default UniProtKB/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /UniProt SPARQL \(advanced\)/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /Advanced UniProt RDF\/SPARQL/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI Sequence Read Archive/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI Gene Expression Omnibus/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI BioProject records/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /NCBI Taxonomy organism records/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /gene_type/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /geo_loc_name/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /run_accessions/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /sample_accessions/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /download_urls/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /download_files/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /UniProtKB JSON, FASTA/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /shared download-file schema/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /SRA run browser/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /geo_accessions/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /scientific_name/)
    assert.match(readFileSync(synced.fieldGlossaryPath, 'utf-8'), /review_status/)
  })
})

test('DB connector tool descriptions steer agents to route biological database intents automatically', () => {
  const descriptions = buildDefaultDbCustomTools()
    .filter((tool) => tool.name.startsWith('db_'))
    .map((tool) => tool.description)
    .join('\n')

  assert.match(descriptions, /first choose relevant databases/)
  assert.match(descriptions, /Prefer db_\* over general web search/)
  assert.match(descriptions, /user should not need to name tool functions/)
  assert.match(descriptions, /NCBI Entrez/)
  assert.match(descriptions, /PubMed/)
  assert.match(descriptions, /ClinVar/)
  assert.match(descriptions, /UniProt/)
})

test('database discovery and function routing find UniProt protein for PDB intent', async () => {
  await withHarness(async ({ agentDir }) => {
    const result = await buildDbSearchTool(agentDir).execute(
      'call-search-pdb',
      { query: 'PDB structure' },
      undefined,
      fakeCtx()
    )
    const details = result.details as {
      kind: string
      results: Array<{ id: string }>
    }
    assert.equal(details.kind, 'db_search_results')
    assert.ok(details.results.some((entry) => entry.id === 'rest-json/uniprot'))
    const routes = await buildDbRoutesTool(agentDir).execute(
      'call-routes-pdb',
      { database: 'rest-json/uniprot', intent: 'PDB structure' },
      undefined,
      fakeCtx()
    )
    const routeContent = JSON.parse(routes.content[0]?.text ?? '{}') as {
      routes: Array<{ domain: string }>
    }
    assert.ok(routeContent.routes.some((route) => route.domain === 'protein'))
  })
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

    const typedViewers = buildDbQueryToolDetails(
      {
        rows: [
          {
            pdb_id: '1TUP',
            canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
            source_id: 'BRCA1',
            target_id: 'BARD1',
            confidence_score: 0.98
          }
        ],
        truncated: false,
        provenance
      },
      { agentDir, fileStem: 'typed-viewers' }
    )
    assert.equal(typedViewers.mode, 'inline')
    assert.deepEqual(
      typedViewers.viewerHints?.map((hint) => [hint.kind, hint.recommendedLibrary]),
      [
        ['protein_structure', 'molstar'],
        ['small_molecule', 'rdkit-js'],
        ['interaction_network', 'cytoscape-js']
      ]
    )
    assert.deepEqual(typedViewers.viewerHints?.[2]?.sampleValues, ['BRCA1 -> BARD1'])

    const geoDownloadFiles = [
      {
        kind: 'series_matrix',
        accession: 'GSE2553',
        url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/GSE2553_series_matrix.txt.gz',
        format: 'txt',
        availability: 'candidate_file',
        source: 'derived_from_gse_accession'
      }
    ] satisfies DbDownloadFileCandidate[]
    const geoInline = buildDbQueryToolDetails(
      {
        rows: [
          {
            accession: 'GSE2553',
            title: 'Breast cancer series',
            download_urls: {
              matrix:
                'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/GSE2553_series_matrix.txt.gz'
            },
            download_files: geoDownloadFiles
          }
        ],
        truncated: false,
        provenance: { ...provenance, domain: 'geo' }
      },
      { agentDir, fileStem: 'geo-inline', resolvedQuery }
    )
    assert.equal(geoInline.mode, 'inline')
    assert.deepEqual(
      geoInline.artifacts?.map((artifact) => artifact.format),
      ['download_manifest_json']
    )
    assert.ok(geoInline.downloadManifestArtifact)
    assert.equal(geoInline.downloadManifestArtifact.format, 'download_manifest_json')
    assert.deepEqual(geoInline.downloadManifestSummary, {
      rowCount: 1,
      candidateCount: 1,
      directUrlCount: 0,
      landingPageCount: 0,
      directoryCount: 0,
      candidateFileCount: 1,
      formats: ['txt'],
      kinds: ['series_matrix']
    })
    assert.equal(geoInline.downloadPlan?.status, 'needs_verification')
    assert.equal(geoInline.downloadPlan?.directUrlCount, 0)
    assert.equal(geoInline.downloadPlan?.toolName, 'db_download')
    assert.equal(
      geoInline.downloadPlan?.toolArgs.manifestPath,
      geoInline.downloadManifestArtifact.path
    )
    assert.ok(
      geoInline.downloadInstructions?.some((instruction) =>
        instruction.includes('download_manifest_json artifact')
      )
    )
    assert.ok(
      geoInline.downloadInstructions?.some((instruction) =>
        instruction.includes('series_matrix_directory')
      )
    )
    assert.equal(existsSync(geoInline.downloadManifestArtifact.path), true)
    const inlineManifest = JSON.parse(
      readFileSync(geoInline.downloadManifestArtifact.path, 'utf-8')
    ) as {
      kind: string
      rows: Array<{
        accession: string
        download_files: Array<{ kind: string; url: string }>
      }>
    }
    assert.equal(inlineManifest.kind, 'db_query_download_manifest')
    assert.equal(inlineManifest.rows[0]?.accession, 'GSE2553')
    assert.equal(inlineManifest.rows[0]?.download_files[0]?.kind, 'series_matrix')
    assert.equal(inlineManifest.rows[0]?.download_files[0]?.url, geoDownloadFiles[0].url)

    const directGeoDownloadFiles = [
      {
        kind: 'supplementary_file',
        accession: 'GSE2553',
        url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/GSE2553_processed_data_file_1.xls.gz',
        filename: 'GSE2553_processed_data_file_1.xls.gz',
        format: 'xls',
        compression: 'gzip',
        availability: 'direct_url',
        source: 'geo_directory_listing'
      }
    ] satisfies DbDownloadFileCandidate[]
    const geoDirect = buildDbQueryToolDetails(
      {
        rows: [
          {
            accession: 'GSE2553',
            title: 'Breast cancer series',
            download_files: directGeoDownloadFiles
          }
        ],
        truncated: false,
        provenance: { ...provenance, domain: 'geo' }
      },
      { agentDir, fileStem: 'geo-direct-download', resolvedQuery }
    )
    assert.equal(geoDirect.downloadManifestSummary?.directUrlCount, 1)
    assert.equal(geoDirect.downloadPlan?.status, 'ready')
    assert.equal(geoDirect.downloadPlan?.directUrlCount, 1)
    assert.equal(geoDirect.downloadPlan?.toolName, 'db_download')
    assert.equal(
      geoDirect.downloadPlan?.toolArgs.manifestPath,
      geoDirect.downloadManifestArtifact?.path
    )
    assert.equal(geoDirect.downloadPlan?.toolArgs.maxFiles, 20)
    assert.ok(
      geoDirect.downloadInstructions?.some((instruction) =>
        instruction.includes('direct_url entries suitable')
      )
    )

    const incompleteDownloadFiles = buildDbQueryToolDetails(
      {
        rows: [
          {
            accession: 'GSE2553',
            download_files: [{ url: geoDownloadFiles[0].url }]
          }
        ],
        truncated: false,
        provenance: { ...provenance, domain: 'geo' }
      },
      { agentDir, fileStem: 'geo-incomplete-download-files' }
    )
    assert.equal(incompleteDownloadFiles.mode, 'inline')
    assert.equal(incompleteDownloadFiles.downloadManifestArtifact, undefined)
    assert.equal(incompleteDownloadFiles.downloadManifestSummary, undefined)

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

    const geoLargeRows = Array.from({ length: 30 }, (_, index) => ({
      accession: `GSE${2553 + index}`,
      title: `GEO series ${index}`,
      download_files: geoDownloadFiles
    }))
    const geoLarge = buildDbQueryToolDetails(
      {
        rows: geoLargeRows,
        totalRows: geoLargeRows.length,
        truncated: false,
        provenance: { ...provenance, domain: 'geo' }
      },
      { agentDir, fileStem: 'geo-large-result', resolvedQuery }
    )
    assert.equal(geoLarge.mode, 'artifact')
    assert.ok(geoLarge.downloadManifestArtifact)
    assert.equal(geoLarge.downloadManifestArtifact.format, 'download_manifest_json')
    assert.deepEqual(geoLarge.downloadManifestSummary, {
      rowCount: 30,
      candidateCount: 30,
      directUrlCount: 0,
      landingPageCount: 0,
      directoryCount: 0,
      candidateFileCount: 30,
      formats: ['txt'],
      kinds: ['series_matrix']
    })
    assert.equal(existsSync(geoLarge.downloadManifestArtifact.path), true)
    assert.deepEqual(
      geoLarge.artifacts.map((artifact) => artifact.format),
      ['jsonl', 'download_manifest_json', 'metadata_json']
    )
    const geoMetadata = JSON.parse(readFileSync(geoLarge.metadataArtifact.path, 'utf-8')) as {
      artifacts: Array<{ format: string }>
      downloadManifestArtifact: { format: string }
      downloadManifestSummary: { candidateCount: number; candidateFileCount: number }
      downloadInstructions?: string[]
      downloadPlan?: { status: string; toolName: string; toolArgs: { manifestPath: string } }
    }
    assert.deepEqual(
      geoMetadata.artifacts.map((artifact) => artifact.format),
      ['jsonl', 'download_manifest_json']
    )
    assert.equal(geoMetadata.downloadManifestArtifact.format, 'download_manifest_json')
    assert.equal(geoMetadata.downloadManifestSummary.candidateCount, 30)
    assert.equal(geoMetadata.downloadManifestSummary.candidateFileCount, 30)
    assert.ok(
      geoMetadata.downloadInstructions?.some((instruction) =>
        instruction.includes('download_manifest_json artifact')
      )
    )
    assert.equal(geoMetadata.downloadPlan?.status, 'needs_verification')
    assert.equal(geoMetadata.downloadPlan?.toolName, 'db_download')
  })
})

test('db_query writes download manifest artifacts from adapter download_files', async () => {
  await withHarness(async ({ agentDir }) => {
    let received: unknown
    const downloadFiles = [
      {
        kind: 'sra_run_browser',
        accession: 'SRR000001',
        url: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000001',
        format: 'html',
        availability: 'landing_page',
        source: 'derived_from_run_accession'
      }
    ] satisfies DbDownloadFileCandidate[]
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
          rows: [
            {
              accession: 'SRX000001',
              title: 'RNA-seq SRA experiment',
              run_accessions: ['SRR000001'],
              download_urls: {
                run_browser: {
                  SRR000001: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000001'
                }
              },
              download_files: downloadFiles
            }
          ],
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
      'call-sra-download-manifest',
      {
        database: 'entrez/ncbi',
        domain: 'sra',
        rawQuery: 'SRX000001',
        limit: 1
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(received, {
      domain: 'sra',
      filters: undefined,
      fields: undefined,
      limit: 1,
      cursor: undefined,
      rawQuery: 'SRX000001'
    })
    const details = result.details as DbQueryToolDetails
    assert.equal(details.mode, 'inline')
    assert.equal(details.downloadManifestArtifact?.format, 'download_manifest_json')
    assert.deepEqual(details.downloadManifestSummary, {
      rowCount: 1,
      candidateCount: 1,
      directUrlCount: 0,
      landingPageCount: 1,
      directoryCount: 0,
      candidateFileCount: 0,
      formats: ['html'],
      kinds: ['sra_run_browser']
    })
    const compactContent = result.content[0]?.text ?? ''
    assert.match(compactContent, /"kind":"db_query_result_content"/)
    assert.match(compactContent, /"download":/)
    assert.match(compactContent, /"toolName":"db_download"/)
    assert.ok(compactContent.length < JSON.stringify(details, null, 2).length)
    assert.equal(existsSync(details.downloadManifestArtifact?.path ?? ''), true)
    const manifest = JSON.parse(
      readFileSync(details.downloadManifestArtifact?.path ?? '', 'utf-8')
    ) as {
      kind: string
      rows: Array<{
        accession: string
        download_files: Array<{ accession: string; kind: string; url: string }>
      }>
      resolvedQuery: DbResolvedQuery
    }
    assert.equal(manifest.kind, 'db_query_download_manifest')
    assert.equal(manifest.rows[0]?.accession, 'SRX000001')
    assert.deepEqual(manifest.rows[0]?.download_files, downloadFiles)
    assert.equal(manifest.resolvedQuery.database, 'entrez/ncbi')
    assert.equal(manifest.resolvedQuery.domain, 'sra')
  })
})

test('db_download fetches direct_url files from a db_query download manifest without bash', async () => {
  await withHarness(async ({ agentDir }) => {
    const resultDir = getDbConnectorResultsDir(agentDir)
    mkdirSync(resultDir, { recursive: true })
    const manifestPath = join(resultDir, 'geo.download-manifest.json')
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          kind: 'db_query_download_manifest',
          generatedAt: '2026-09-21T00:00:00.000Z',
          summary: {
            rowCount: 1,
            returnedRows: 1,
            truncated: false,
            fields: ['accession', 'download_files'],
            warnings: []
          },
          provenance: {
            database: 'entrez/ncbi',
            domain: 'geo',
            retrievedAt: '2026-09-21T00:00:00.000Z'
          },
          rows: [
            {
              rowIndex: 0,
              accession: 'GSE2553',
              title: 'GEO test',
              download_files: [
                {
                  kind: 'supplementary_file',
                  accession: 'GSE2553',
                  url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/GSE2553_processed_data_file_1.xls.gz',
                  filename: 'GSE2553_processed_data_file_1.xls.gz',
                  format: 'xls',
                  availability: 'direct_url',
                  source: 'geo_directory_listing'
                },
                {
                  kind: 'supplementary_directory',
                  accession: 'GSE2553',
                  url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/',
                  format: 'directory',
                  availability: 'directory',
                  source: 'derived_from_gse_accession'
                }
              ]
            }
          ]
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const payload = 'downloaded GEO supplementary data\n'
    const tools = buildDefaultDbCustomTools(agentDir, {
      download: {
        sleep: async () => {},
        transport: {
          name: 'mock-db-download',
          async fetch(input) {
            assert.equal(input.hostname, 'ftp.ncbi.nlm.nih.gov')
            assert.equal(input.pathname.endsWith('/GSE2553_processed_data_file_1.xls.gz'), true)
            return new Response(payload, {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' }
            })
          }
        }
      }
    })
    const download = tools.find((tool) => tool.name === 'db_download')
    assert.ok(download)

    const updates: string[] = []
    const result = await download.execute(
      'call-db-download',
      { manifestPath, maxFiles: 5 },
      (update) => {
        updates.push(update.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
      },
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    const details = result.details as DbDownloadToolDetails
    assert.equal(details.status, 'complete')
    assert.equal(details.downloadedCount, 1)
    assert.equal(details.failedCount, 0)
    assert.equal(details.skippedCount, 1)
    assert.equal(details.skipped[0]?.reason, 'not_direct_url')
    assert.equal(details.files[0]?.filename, 'GSE2553_processed_data_file_1.xls.gz')
    assert.equal(readFileSync(details.files[0]?.path ?? '', 'utf-8'), payload)
    assert.match(details.files[0]?.sha256 ?? '', /^sha256:[0-9a-f]{64}$/)
    assert.match(updates.at(-1) ?? '', /Downloaded 1\/1/)
  })
})

test('HTTP policy returns download bodies without buffering them', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml())
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const response = await executeDbHttpRequest({
    manifest,
    path: 'genes',
    streamResponse: true,
    cacheTtlMs: 0,
    transport: {
      async fetch() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('response body was read before the caller received it'))
            }
          }),
          { status: 200 }
        )
      }
    }
  })
  assert.equal(response.response.status, 200)
  await assert.rejects(response.response.arrayBuffer(), /response body was read/)
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

test('HTTP policy executor caches explicit idempotent POST responses by body', async () => {
  await withHarness(async ({ agentDir }) => {
    const parsed = parseDbConnectorManifest(connectorYaml('rest-json/post-cache-toy'))
    assert.equal(parsed.valid, true)
    const manifest = parsed.manifest as DbConnectorManifest
    let calls = 0
    const transport: DbEgressTransport = {
      name: 'post-cache-test',
      async fetch(_input, init) {
        calls += 1
        return new Response(
          JSON.stringify({
            calls,
            body: init.body
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    }
    const baseOptions = {
      manifest,
      path: 'genes/batch',
      method: 'POST' as const,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      transport,
      agentDir,
      cacheTtlMs: 60_000,
      idempotent: true,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {}
    }

    const first = await executeDbHttpRequest({
      ...baseOptions,
      body: JSON.stringify({ ids: ['ENSG00000012048'] })
    })
    assert.deepEqual(await first.response.json(), {
      calls: 1,
      body: '{"ids":["ENSG00000012048"]}'
    })

    const second = await executeDbHttpRequest({
      ...baseOptions,
      body: JSON.stringify({ ids: ['ENSG00000012048'] })
    })
    assert.deepEqual(await second.response.json(), {
      calls: 1,
      body: '{"ids":["ENSG00000012048"]}'
    })
    assert.equal(second.cached, true)
    assert.equal(second.attempts, 0)

    const third = await executeDbHttpRequest({
      ...baseOptions,
      body: JSON.stringify({ ids: ['ENSG00000139618'] })
    })
    assert.deepEqual(await third.response.json(), {
      calls: 2,
      body: '{"ids":["ENSG00000139618"]}'
    })
    assert.equal(third.cached, undefined)
    assert.equal(calls, 2)
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
      async fetch(input, init) {
        calls += 1
        assert.equal(input.hostname, 'api.example.org')
        assert.equal(input.pathname, '/v1/genes/BRCA1')
        assert.equal(input.searchParams.get('species'), '9606')
        assert.equal(input.searchParams.get('limit'), '1')
        assert.equal(input.searchParams.get('offset'), '10')
        assert.equal(new Headers(init.headers).get('accept'), 'application/json')
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
  assert.deepEqual(result.rows, [
    {
      symbol: 'BRCA1',
      description: 'DNA repair associated',
      source_database: 'rest-json/toy',
      source_domain: 'gene'
    }
  ])
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

  assert.deepEqual(result.rows, [
    {
      symbol: 'TP53',
      description: 'Tumor protein p53',
      source_database: 'rest-json/rawtoy',
      source_domain: 'gene'
    }
  ])
  assert.equal(result.totalRows, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.provenance.rawQueryUsed, true)
})

test('RestJson request validation rejects ambiguous or unsupported query inputs', () => {
  const parsed = parseDbConnectorManifest(connectorYaml('rest-json/validated'))
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const domain = (parsed.manifest as DbConnectorManifest).domains[0]

  assert.throws(
    () =>
      buildRestJsonRequest(domain, {
        domain: 'gene',
        filters: [
          { field: 'symbol', op: '=', value: 'BRCA1' },
          { field: 'organsim', op: '=', value: '9606' }
        ],
        limit: 10
      }),
    /does not accept filter: organsim/
  )
  assert.throws(
    () =>
      buildRestJsonRequest(domain, {
        domain: 'gene',
        filters: [
          { field: 'symbol', op: '=', value: 'BRCA1' },
          { field: 'symbol', op: '=', value: 'BRCA2' }
        ],
        limit: 10
      }),
    /duplicate filter: symbol/
  )
  assert.throws(
    () =>
      buildRestJsonRequest(domain, {
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'BRCA1' }],
        rawQuery: 'BRCA1',
        limit: 10
      }),
    /filters and rawQuery cannot be used together/
  )

  const noCursorYaml = connectorYaml('rest-json/no-cursor').replace(
    '        cursorParam: offset\n',
    ''
  )
  const noCursor = parseDbConnectorManifest(noCursorYaml)
  assert.equal(noCursor.valid, true, noCursor.errors.join('\n'))
  assert.throws(
    () =>
      buildRestJsonRequest((noCursor.manifest as DbConnectorManifest).domains[0], {
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'BRCA1' }],
        cursor: '10',
        limit: 10
      }),
    /does not support cursor pagination/
  )
})

test('database adapters reject invalid page sizes and offset cursors', () => {
  const rest = parseDbConnectorManifest(connectorYaml('rest-json/window'))
  assert.equal(rest.valid, true, rest.errors.join('\n'))
  assert.throws(
    () =>
      buildRestJsonRequest((rest.manifest as DbConnectorManifest).domains[0], {
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'BRCA1' }],
        limit: 501
      }),
    /limit must be an integer between 1 and 500/
  )

  assert.throws(
    () =>
      buildUniProtKbSearchParams({
        domain: 'protein',
        rawQuery: 'BRCA1',
        limit: 1.5
      }),
    /limit must be an integer between 1 and 500/
  )

  const entrez = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(entrez.valid, true, entrez.errors.join('\n'))
  assert.throws(
    () =>
      buildEntrezSearchParams(entrez.manifest as DbConnectorManifest, {
        domain: 'gene',
        rawQuery: 'BRCA1',
        limit: 10,
        cursor: 'not-an-offset'
      }),
    /cursor must be a non-negative integer offset/
  )

  const sparql = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/sparql/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(sparql.valid, true, sparql.errors.join('\n'))
  assert.throws(
    () =>
      buildSparqlQuery((sparql.manifest as DbConnectorManifest).domains[0], {
        domain: 'protein',
        rawQuery: 'SELECT * WHERE { ?s ?p ?o }',
        limit: 10,
        cursor: '-1'
      }),
    /cursor must be a non-negative integer offset/
  )
})

test('RestJson adapter stops pagination on a numeric final page', async () => {
  const parsed = parseDbConnectorManifest(connectorYaml('rest-json/final-page'))
  assert.equal(parsed.valid, true)
  const adapter = new RestJsonAdapter(parsed.manifest as DbConnectorManifest, {
    sleep: async () => {},
    transport: {
      name: 'mock-rest-json-final-page',
      async fetch() {
        return new Response(
          JSON.stringify({
            data: [
              { symbol: 'GENE11', description: 'Row 11' },
              { symbol: 'GENE12', description: 'Row 12' }
            ],
            meta: { total: 12 }
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query({
    domain: 'gene',
    filters: [{ field: 'symbol', op: '=', value: 'GENE' }],
    limit: 2,
    cursor: '10'
  })

  assert.equal(result.totalRows, 12)
  assert.equal(result.truncated, false)
  assert.equal(result.nextCursor, undefined)
})

test('RestJson adapter expands nested wildcard response paths', async () => {
  const yaml = connectorYaml('rest-json/nested-wildcard').replace(
    'rowsPath: data',
    'rowsPath: groups.*.items.*'
  )
  const parsed = parseDbConnectorManifest(yaml)
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const adapter = new RestJsonAdapter(parsed.manifest as DbConnectorManifest, {
    sleep: async () => {},
    transport: {
      name: 'mock-rest-json-nested-wildcard',
      async fetch() {
        return new Response(
          JSON.stringify({
            groups: {
              first: { items: [{ symbol: 'BRCA1', description: 'First' }] },
              second: { items: [{ symbol: 'BRCA2', description: 'Second' }] }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query({
    domain: 'gene',
    filters: [{ field: 'symbol', op: '=', value: 'BRCA' }],
    limit: 10
  })

  assert.deepEqual(result.rows, [
    {
      symbol: 'BRCA1',
      description: 'First',
      source_database: 'rest-json/nested-wildcard',
      source_domain: 'gene'
    },
    {
      symbol: 'BRCA2',
      description: 'Second',
      source_database: 'rest-json/nested-wildcard',
      source_domain: 'gene'
    }
  ])
  assert.equal(result.truncated, false)
})

test('RestJson adapter supports POST JSON body filters', async () => {
  const yaml = connectorYaml('rest-json/posttoy').replace(
    `path: /genes/{filter:symbol}
        queryParams:
          content-type: application/json
        filterParamMap:
          organism: species
        rawQueryParam: q
        limitParam: limit
        cursorParam: offset`,
    `path: /genes/batch
        method: POST
        idempotent: true
        jsonBodyParamMap:
          ids: ids
          includeMetadata: include_metadata
        jsonBodyArrayFields: [ids]
        jsonBodyOptionalFields: [includeMetadata]
        filterParamMap:
          organism: species`
  )
  const parsed = parseDbConnectorManifest(yaml)
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const manifest = parsed.manifest as DbConnectorManifest
  const domain = manifest.domains[0]
  const request = buildRestJsonRequest(domain, {
    domain: 'gene',
    filters: [
      { field: 'ids', op: 'in', value: ['ENSG00000012048', 'ENSG00000139618'] },
      { field: 'organism', op: '=', value: 'homo_sapiens' }
    ],
    limit: 10
  })
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/genes/batch')
  assert.equal(request.searchParams.get('species'), 'homo_sapiens')
  assert.equal(request.searchParams.has('ids'), false)
  assert.deepEqual(JSON.parse(request.body ?? '{}'), {
    ids: ['ENSG00000012048', 'ENSG00000139618']
  })
  const requestWithOptionalBody = buildRestJsonRequest(domain, {
    domain: 'gene',
    filters: [
      { field: 'ids', op: 'in', value: ['ENSG00000012048'] },
      { field: 'include_metadata', op: '=', value: true }
    ],
    limit: 10
  })
  assert.deepEqual(JSON.parse(requestWithOptionalBody.body ?? '{}'), {
    ids: ['ENSG00000012048'],
    includeMetadata: true
  })

  let calls = 0
  const adapter = new RestJsonAdapter(manifest, {
    sleep: async () => {},
    transport: {
      name: 'mock-rest-json-post',
      async fetch(input, init) {
        calls += 1
        assert.equal(input.pathname, '/v1/genes/batch')
        assert.equal(input.searchParams.get('species'), 'homo_sapiens')
        assert.equal(init.method, 'POST')
        const headers = new Headers(init.headers)
        assert.equal(headers.get('accept'), 'application/json')
        assert.equal(headers.get('content-type'), 'application/json')
        assert.deepEqual(JSON.parse(String(init.body)), {
          ids: ['ENSG00000012048', 'ENSG00000139618']
        })
        if (calls === 1) return new Response('try again', { status: 503 })
        return new Response(
          JSON.stringify({
            data: [
              { symbol: 'BRCA1', description: 'DNA repair associated' },
              { symbol: 'BRCA2', description: 'DNA repair associated' }
            ]
          }),
          { status: 200 }
        )
      }
    }
  })

  const result = await adapter.query({
    domain: 'gene',
    filters: [
      { field: 'ids', op: 'in', value: ['ENSG00000012048', 'ENSG00000139618'] },
      { field: 'organism', op: '=', value: 'homo_sapiens' }
    ],
    limit: 10
  })

  assert.equal(calls, 2)
  assert.deepEqual(result.rows, [
    {
      symbol: 'BRCA1',
      description: 'DNA repair associated',
      source_database: 'rest-json/posttoy',
      source_domain: 'gene'
    },
    {
      symbol: 'BRCA2',
      description: 'DNA repair associated',
      source_database: 'rest-json/posttoy',
      source_domain: 'gene'
    }
  ])
  assert.equal(result.provenance.attempts, 2)
  assert.equal(result.provenance.retried, true)
})

test('Ensembl REST manifest covers major GET endpoint families and renders requests', () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/ensembl/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const manifest = parsed.manifest as DbConnectorManifest
  const domainIds = manifest.domains.map((domain) => domain.id)
  assert.deepEqual(
    [
      'lookup_id',
      'lookup_id_batch',
      'lookup_symbol',
      'lookup_symbol_batch',
      'xref_id',
      'xref_name',
      'sequence_id',
      'sequence_id_batch',
      'sequence_region',
      'sequence_region_batch',
      'overlap_id',
      'overlap_region',
      'homology_id',
      'homology_symbol',
      'genetree_member_symbol',
      'genetree_id',
      'genetree_member_id',
      'cafe_genetree_id',
      'cafe_genetree_member_symbol',
      'cafe_genetree_member_id',
      'alignment_region',
      'variation',
      'variation_batch',
      'variation_pmcid',
      'variation_pmid',
      'variant_recoder',
      'variant_recoder_batch',
      'vep_hgvs',
      'vep_hgvs_batch',
      'vep_id',
      'vep_id_batch',
      'vep_region',
      'vep_region_batch',
      'phenotype_gene',
      'phenotype_accession',
      'phenotype_region',
      'phenotype_term',
      'regulation_binding_matrix',
      'map_cdna',
      'map_cds',
      'map_assembly',
      'ontology_id',
      'ontology_name',
      'ontology_ancestors',
      'ontology_ancestors_chart',
      'ontology_descendants',
      'ontology_descendants_chart',
      'taxonomy_id',
      'taxonomy_name',
      'taxonomy_classification',
      'ld_id',
      'ld_pairwise',
      'ld_region',
      'transcript_haplotypes',
      'archive_id',
      'archive_id_batch',
      'info_species',
      'info_assembly',
      'info_assembly_region',
      'info_analysis',
      'info_biotypes',
      'info_biotypes_object_type',
      'info_biotypes_group',
      'info_biotypes_name',
      'info_compara_methods',
      'info_compara_species_sets',
      'info_comparas',
      'info_external_dbs',
      'info_data',
      'info_divisions',
      'info_eg_version',
      'info_genomes',
      'info_genomes_accession',
      'info_genomes_assembly',
      'info_genomes_division',
      'info_genomes_taxonomy',
      'info_ping',
      'info_software',
      'info_variation',
      'info_variation_populations',
      'info_variation_population',
      'info_rest',
      'ga4gh_beacon',
      'ga4gh_beacon_query',
      'ga4gh_beacon_query_post',
      'ga4gh_callset',
      'ga4gh_callset_search',
      'ga4gh_dataset',
      'ga4gh_dataset_search',
      'ga4gh_feature',
      'ga4gh_feature_search',
      'ga4gh_featureset',
      'ga4gh_featureset_search',
      'ga4gh_variant',
      'ga4gh_variant_search',
      'ga4gh_variantset',
      'ga4gh_variantset_search',
      'ga4gh_reference',
      'ga4gh_reference_search',
      'ga4gh_referenceset',
      'ga4gh_referenceset_search',
      'ga4gh_variantannotationset',
      'ga4gh_variantannotationset_search'
    ].every((domainId) => domainIds.includes(domainId)),
    true
  )

  const identityCases: Record<string, { fields: string[]; namespace: string }> = {
    genetree_id: { fields: ['id'], namespace: 'ensembl.genetree_id' },
    cafe_genetree_id: { fields: ['id'], namespace: 'ensembl.genetree_id' },
    variation_pmid: { fields: ['name'], namespace: 'ensembl.variation_id' },
    vep_id_batch: { fields: ['id'], namespace: 'ensembl.variation_id' },
    regulation_binding_matrix: {
      fields: ['binding_matrix_stable_id'],
      namespace: 'ensembl.binding_matrix_id'
    },
    ontology_id: { fields: ['accession'], namespace: 'ontology.term_accession' },
    archive_id: { fields: ['id'], namespace: 'ensembl.stable_id' },
    ga4gh_variant: { fields: ['id'], namespace: 'ga4gh.variant_id' },
    ga4gh_variant_search: { fields: ['id'], namespace: 'ga4gh.variant_id' },
    ga4gh_reference: { fields: ['id'], namespace: 'ga4gh.reference_id' }
  }
  for (const [domainId, expected] of Object.entries(identityCases)) {
    const domain = manifest.domains.find((candidate) => candidate.id === domainId)
    assert.ok(domain, domainId)
    assert.deepEqual(domain.identity?.stableIdFields, expected.fields, domainId)
    assert.equal(domain.identity?.namespace, expected.namespace, domainId)
  }
  for (const domainId of [
    'overlap_region',
    'phenotype_gene',
    'map_assembly',
    'ld_region',
    'transcript_haplotypes',
    'info_ping',
    'ga4gh_beacon_query',
    'variant_recoder'
  ]) {
    assert.equal(
      manifest.domains.find((candidate) => candidate.id === domainId)?.identity,
      undefined,
      domainId
    )
  }
  assert.equal(
    manifest.domains.find((candidate) => candidate.id === 'variant_recoder')?.rest?.response
      ?.rowsPath,
    '$.*.*'
  )

  const requestCases: Array<{
    domain: string
    filters: Array<{ field: string; op: '=' | 'in'; value: string | number | boolean | string[] }>
    path: string
    method?: 'GET' | 'POST'
    query?: Record<string, string>
    body?: unknown
  }> = [
    {
      domain: 'lookup_symbol',
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'symbol', op: '=', value: 'BRCA1' },
        { field: 'expand', op: '=', value: true }
      ],
      path: '/lookup/symbol/homo_sapiens/BRCA1',
      query: { expand: 'true' }
    },
    {
      domain: 'lookup_id_batch',
      filters: [
        { field: 'ids', op: 'in', value: ['ENSG00000012048', 'ENSG00000139618'] },
        { field: 'expand', op: '=', value: true }
      ],
      path: '/lookup/id',
      method: 'POST',
      query: { expand: 'true' },
      body: { ids: ['ENSG00000012048', 'ENSG00000139618'] }
    },
    {
      domain: 'lookup_symbol_batch',
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'symbols', op: 'in', value: ['BRCA1', 'BRCA2'] },
        { field: 'expand', op: '=', value: true }
      ],
      path: '/lookup/symbol/homo_sapiens',
      method: 'POST',
      query: { expand: 'true' },
      body: { symbols: ['BRCA1', 'BRCA2'] }
    },
    {
      domain: 'sequence_id',
      filters: [
        { field: 'id', op: '=', value: 'ENSG00000012048' },
        { field: 'type', op: '=', value: 'genomic' }
      ],
      path: '/sequence/id/ENSG00000012048',
      query: { type: 'genomic' }
    },
    {
      domain: 'sequence_id_batch',
      filters: [
        { field: 'ids', op: 'in', value: ['ENSG00000012048', 'ENSG00000139618'] },
        { field: 'type', op: '=', value: 'genomic' }
      ],
      path: '/sequence/id',
      method: 'POST',
      query: { type: 'genomic' },
      body: { ids: ['ENSG00000012048', 'ENSG00000139618'] }
    },
    {
      domain: 'sequence_region_batch',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'regions', op: 'in', value: ['X:1000000..1000100:1', '13:32315086..32315100:1'] },
        { field: 'mask', op: '=', value: 'soft' }
      ],
      path: '/sequence/region/human',
      method: 'POST',
      query: { mask: 'soft' },
      body: { regions: ['X:1000000..1000100:1', '13:32315086..32315100:1'] }
    },
    {
      domain: 'overlap_region',
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'region', op: '=', value: '13:32315086-32315100' },
        { field: 'feature', op: '=', value: 'gene' }
      ],
      path: '/overlap/region/homo_sapiens/13%3A32315086-32315100',
      query: { feature: 'gene' }
    },
    {
      domain: 'genetree_member_id',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'id', op: '=', value: 'ENSG00000012048' },
        { field: 'sequence', op: '=', value: 'none' }
      ],
      path: '/genetree/member/id/human/ENSG00000012048',
      query: { sequence: 'none' }
    },
    {
      domain: 'cafe_genetree_member_symbol',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'symbol', op: '=', value: 'BRCA1' },
        { field: 'nh_format', op: '=', value: 'full' }
      ],
      path: '/cafe/genetree/member/symbol/human/BRCA1',
      query: { nh_format: 'full' }
    },
    {
      domain: 'variation_batch',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'ids', op: 'in', value: ['rs699', 'rs7412'] },
        { field: 'phenotypes', op: '=', value: true }
      ],
      path: '/variation/human',
      method: 'POST',
      query: { phenotypes: 'true' },
      body: { ids: ['rs699', 'rs7412'] }
    },
    {
      domain: 'variation_pmid',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'pmid', op: '=', value: '12345678' }
      ],
      path: '/variation/human/pmid/12345678'
    },
    {
      domain: 'vep_hgvs',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'hgvs', op: '=', value: '9:g.22125504G>C' },
        { field: 'canonical', op: '=', value: true }
      ],
      path: '/vep/human/hgvs/9%3Ag.22125504G%3EC',
      query: { canonical: 'true' }
    },
    {
      domain: 'vep_hgvs_batch',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        {
          field: 'hgvs_notations',
          op: 'in',
          value: ['ENST00000366667:c.803C>T', '9:g.22125504G>C']
        },
        { field: 'canonical', op: '=', value: true }
      ],
      path: '/vep/human/hgvs',
      method: 'POST',
      query: { canonical: 'true' },
      body: { hgvs_notations: ['ENST00000366667:c.803C>T', '9:g.22125504G>C'] }
    },
    {
      domain: 'vep_id_batch',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'ids', op: 'in', value: ['rs699'] },
        { field: 'canonical', op: '=', value: true }
      ],
      path: '/vep/human/id',
      method: 'POST',
      query: { canonical: 'true' },
      body: { ids: ['rs699'] }
    },
    {
      domain: 'vep_region',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'region', op: '=', value: '21:26960070-26960070' },
        { field: 'allele', op: '=', value: 'A' },
        { field: 'canonical', op: '=', value: true }
      ],
      path: '/vep/human/region/21%3A26960070-26960070/A',
      query: { canonical: 'true' }
    },
    {
      domain: 'vep_region_batch',
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        {
          field: 'variants',
          op: 'in',
          value: ['21 26960070 rs116645811 G A . . .', '21 26965148 rs1135638 G A . . .']
        },
        { field: 'canonical', op: '=', value: true }
      ],
      path: '/vep/homo_sapiens/region',
      method: 'POST',
      query: { canonical: 'true' },
      body: {
        variants: ['21 26960070 rs116645811 G A . . .', '21 26965148 rs1135638 G A . . .']
      }
    },
    {
      domain: 'map_translation',
      filters: [
        { field: 'id', op: '=', value: 'ENSP00000350283' },
        { field: 'region', op: '=', value: '1..10' }
      ],
      path: '/map/translation/ENSP00000350283/1..10'
    },
    {
      domain: 'map_cds',
      filters: [
        { field: 'id', op: '=', value: 'ENST00000357654' },
        { field: 'region', op: '=', value: '1..10' }
      ],
      path: '/map/cds/ENST00000357654/1..10'
    },
    {
      domain: 'map_assembly',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'source_assembly', op: '=', value: 'GRCh37' },
        { field: 'region', op: '=', value: '13:32889611..32889620:1' },
        { field: 'target_assembly', op: '=', value: 'GRCh38' }
      ],
      path: '/map/human/GRCh37/13%3A32889611..32889620%3A1/GRCh38'
    },
    {
      domain: 'phenotype_region',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'region', op: '=', value: '13:32315086-32315100' },
        { field: 'feature_type', op: '=', value: 'Gene' }
      ],
      path: '/phenotype/region/human/13%3A32315086-32315100',
      query: { feature_type: 'Gene' }
    },
    {
      domain: 'ontology_name',
      filters: [{ field: 'name', op: '=', value: 'protein_coding_gene' }],
      path: '/ontology/name/protein_coding_gene'
    },
    {
      domain: 'ontology_ancestors',
      filters: [{ field: 'id', op: '=', value: 'SO:0001217' }],
      path: '/ontology/ancestors/SO%3A0001217'
    },
    {
      domain: 'ontology_descendants_chart',
      filters: [{ field: 'id', op: '=', value: 'SO:0000704' }],
      path: '/ontology/descendants/chart/SO%3A0000704'
    },
    {
      domain: 'taxonomy_name',
      filters: [{ field: 'name', op: '=', value: 'Homo sapiens' }],
      path: '/taxonomy/name/Homo%20sapiens'
    },
    {
      domain: 'taxonomy_classification',
      filters: [{ field: 'id', op: '=', value: '9606' }],
      path: '/taxonomy/classification/9606'
    },
    {
      domain: 'ld_id',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'id', op: '=', value: 'rs699' },
        { field: 'population_name', op: '=', value: '1000GENOMES:phase_3:CEU' }
      ],
      path: '/ld/human/rs699/1000GENOMES%3Aphase_3%3ACEU'
    },
    {
      domain: 'ld_region',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'region', op: '=', value: '13:32315086-32315100' },
        { field: 'population_name', op: '=', value: '1000GENOMES:phase_3:CEU' }
      ],
      path: '/ld/human/region/13%3A32315086-32315100/1000GENOMES%3Aphase_3%3ACEU'
    },
    {
      domain: 'info_biotypes_object_type',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'object_type', op: '=', value: 'gene' }
      ],
      path: '/info/biotypes/human/gene'
    },
    {
      domain: 'info_assembly_region',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'region_name', op: '=', value: '13' }
      ],
      path: '/info/assembly/human/13'
    },
    {
      domain: 'info_compara_species_sets',
      filters: [{ field: 'method', op: '=', value: 'EPO' }],
      path: '/info/compara/species_sets/EPO'
    },
    {
      domain: 'info_external_dbs',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'feature', op: '=', value: 'gene' }
      ],
      path: '/info/external_dbs/human',
      query: { feature: 'gene' }
    },
    {
      domain: 'info_genomes_accession',
      filters: [{ field: 'accession', op: '=', value: 'CM000675.2' }],
      path: '/info/genomes/accession/CM000675.2'
    },
    {
      domain: 'info_variation_population',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'population_name', op: '=', value: '1000GENOMES:phase_3:CEU' }
      ],
      path: '/info/variation/populations/human/1000GENOMES%3Aphase_3%3ACEU'
    },
    {
      domain: 'info_data',
      filters: [],
      path: '/info/data'
    },
    {
      domain: 'archive_id_batch',
      filters: [{ field: 'ids', op: 'in', value: ['ENSG00000012048', 'ENSG00000139618'] }],
      path: '/archive/id',
      method: 'POST',
      body: { id: ['ENSG00000012048', 'ENSG00000139618'] }
    },
    {
      domain: 'ga4gh_beacon_query',
      filters: [
        { field: 'referenceName', op: '=', value: '13' },
        { field: 'start', op: '=', value: 32315086 },
        { field: 'referenceBases', op: '=', value: 'A' },
        { field: 'alternateBases', op: '=', value: 'T' },
        { field: 'assemblyId', op: '=', value: 'GRCh38' }
      ],
      path: '/ga4gh/beacon/query',
      query: {
        referenceName: '13',
        start: '32315086',
        referenceBases: 'A',
        alternateBases: 'T',
        assemblyId: 'GRCh38'
      }
    },
    {
      domain: 'ga4gh_beacon_query_post',
      filters: [
        { field: 'referenceName', op: '=', value: '13' },
        { field: 'start', op: '=', value: 32315086 },
        { field: 'referenceBases', op: '=', value: 'A' },
        { field: 'alternateBases', op: '=', value: 'T' },
        { field: 'assemblyId', op: '=', value: 'GRCh38' },
        { field: 'datasetIds', op: 'in', value: ['dataset-1'] }
      ],
      path: '/ga4gh/beacon/query',
      method: 'POST',
      body: {
        referenceName: '13',
        start: 32315086,
        referenceBases: 'A',
        alternateBases: 'T',
        assemblyId: 'GRCh38',
        datasetIds: ['dataset-1']
      }
    },
    {
      domain: 'ga4gh_variant_search',
      filters: [
        { field: 'variantSetId', op: '=', value: 'variant-set-1' },
        { field: 'referenceName', op: '=', value: '13' },
        { field: 'start', op: '=', value: 32315086 },
        { field: 'end', op: '=', value: 32315100 }
      ],
      path: '/ga4gh/variants/search',
      method: 'POST',
      body: {
        variantSetId: 'variant-set-1',
        referenceName: '13',
        start: 32315086,
        end: 32315100
      }
    },
    {
      domain: 'ga4gh_feature_search',
      filters: [
        { field: 'featureSetId', op: '=', value: 'Ensembl' },
        { field: 'featureTypes', op: 'in', value: ['transcript'] },
        { field: 'referenceName', op: '=', value: '6' },
        { field: 'start', op: '=', value: 1080164 },
        { field: 'end', op: '=', value: 1200164 }
      ],
      path: '/ga4gh/features/search',
      method: 'POST',
      body: {
        featureSetId: 'Ensembl',
        featureTypes: ['transcript'],
        referenceName: '6',
        start: 1080164,
        end: 1200164
      }
    },
    {
      domain: 'ga4gh_callset_search',
      filters: [{ field: 'variantSetId', op: '=', value: '1' }],
      path: '/ga4gh/callsets/search',
      method: 'POST',
      body: { variantSetId: '1' }
    },
    {
      domain: 'ga4gh_featureset_search',
      filters: [{ field: 'datasetId', op: '=', value: 'Ensembl' }],
      path: '/ga4gh/featuresets/search',
      method: 'POST',
      body: { datasetId: 'Ensembl' }
    },
    {
      domain: 'ga4gh_variantset_search',
      filters: [{ field: 'datasetId', op: '=', value: '6e340c4d1e333c7a676b1710d2e3953c' }],
      path: '/ga4gh/variantsets/search',
      method: 'POST',
      body: { datasetId: '6e340c4d1e333c7a676b1710d2e3953c' }
    },
    {
      domain: 'ga4gh_variantannotationset_search',
      filters: [{ field: 'datasetId', op: '=', value: 'Ensembl' }],
      path: '/ga4gh/variantannotationsets/search',
      method: 'POST',
      body: { datasetId: 'Ensembl' }
    },
    {
      domain: 'ga4gh_reference_search',
      filters: [
        { field: 'referenceSetId', op: '=', value: 'GRCh38' },
        { field: 'accession', op: '=', value: 'CM000675.2' }
      ],
      path: '/ga4gh/references/search',
      method: 'POST',
      body: { referenceSetId: 'GRCh38', accession: 'CM000675.2' }
    }
  ]

  for (const item of requestCases) {
    const domain = manifest.domains.find((candidate) => candidate.id === item.domain)
    assert.ok(domain, item.domain)
    const request = buildRestJsonRequest(domain, {
      domain: item.domain,
      filters: item.filters,
      limit: 1
    })
    assert.equal(request.method, item.method ?? 'GET')
    assert.equal(request.path, item.path)
    if (item.method === 'POST') {
      assert.equal(domain.rest?.request.idempotent, true)
    }
    for (const [key, value] of Object.entries(item.query ?? {})) {
      assert.equal(request.searchParams.get(key), value)
    }
    if (item.body !== undefined) {
      assert.deepEqual(JSON.parse(request.body ?? '{}'), item.body)
    } else {
      assert.equal(request.body, undefined)
    }
  }
})

test('Ensembl identity audit normalizes entities without inventing relationship identities', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/ensembl/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const adapter = new RestJsonAdapter(parsed.manifest as DbConnectorManifest, {
    transport: {
      name: 'mock-ensembl-identity-audit',
      async fetch(input) {
        if (input.pathname === '/genetree/id/ENSGT00390000003602') {
          return new Response(
            JSON.stringify({ id: 'ENSGT00390000003602', type: 'gene tree', tree: {} }),
            { status: 200 }
          )
        }
        if (input.pathname === '/variant_recoder/human/rs699') {
          return new Response(
            JSON.stringify([
              {
                G: {
                  input: 'rs699',
                  id: ['rs699', 'COSV64184214'],
                  hgvsg: ['NC_000001.11:g.230710048A>G']
                }
              }
            ]),
            { status: 200 }
          )
        }
        assert.equal(input.pathname, '/overlap/id/ENSG00000012048')
        return new Response(
          JSON.stringify([
            {
              id: 'ENST00000357654',
              feature_type: 'transcript',
              start: 43044295,
              end: 43125482
            }
          ]),
          { status: 200 }
        )
      }
    }
  })

  const geneTree = await adapter.query({
    domain: 'genetree_id',
    filters: [{ field: 'id', op: '=', value: 'ENSGT00390000003602' }],
    fields: ['id'],
    limit: 1
  })
  assert.deepEqual(geneTree.rows[0], {
    id: 'ENSGT00390000003602',
    source_database: 'rest-json/ensembl',
    source_domain: 'genetree_id',
    stable_id: 'ENSGT00390000003602',
    stable_id_namespace: 'ensembl.genetree_id'
  })

  const recoded = await adapter.query({
    domain: 'variant_recoder',
    filters: [
      { field: 'species', op: '=', value: 'human' },
      { field: 'id', op: '=', value: 'rs699' }
    ],
    fields: ['input', 'id'],
    limit: 5
  })
  assert.deepEqual(recoded.rows[0], {
    input: 'rs699',
    id: ['rs699', 'COSV64184214'],
    source_database: 'rest-json/ensembl',
    source_domain: 'variant_recoder'
  })
  assert.equal(recoded.rows[0]?.stable_id, undefined)

  const overlap = await adapter.query({
    domain: 'overlap_id',
    filters: [
      { field: 'id', op: '=', value: 'ENSG00000012048' },
      { field: 'feature', op: '=', value: 'transcript' }
    ],
    fields: ['id', 'feature_type'],
    limit: 5
  })
  assert.equal(overlap.rows[0]?.id, 'ENST00000357654')
  assert.equal(overlap.rows[0]?.stable_id, undefined)
  assert.equal(overlap.rows[0]?.source_domain, 'overlap_id')
})

test('UniProt adapter queries UniProtKB REST and normalizes protein records', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const searchParams = buildUniProtKbSearchParams({
    domain: 'protein',
    filters: [
      { field: 'gene_name', op: '=', value: 'BRCA1' },
      { field: 'organism_id', op: '=', value: '9606' },
      { field: 'reviewed', op: '=', value: true }
    ],
    limit: 2,
    cursor: 'abc'
  })
  assert.equal(searchParams.get('query'), 'gene_exact:BRCA1 AND organism_id:9606 AND reviewed:true')
  assert.equal(searchParams.get('size'), '2')
  assert.equal(searchParams.get('cursor'), 'abc')
  assert.match(searchParams.get('fields') ?? '', /cc_function/)
  assert.match(searchParams.get('fields') ?? '', /cc_disease/)
  assert.match(searchParams.get('fields') ?? '', /protein_existence/)
  assert.match(searchParams.get('fields') ?? '', /lineage/)
  assert.match(searchParams.get('fields') ?? '', /date_created/)
  assert.match(searchParams.get('fields') ?? '', /date_modified/)
  assert.match(searchParams.get('fields') ?? '', /date_sequence_modified/)
  assert.match(searchParams.get('fields') ?? '', /version/)
  assert.match(searchParams.get('fields') ?? '', /ec/)
  assert.match(searchParams.get('fields') ?? '', /keyword/)
  assert.match(searchParams.get('fields') ?? '', /cc_catalytic_activity/)
  assert.match(searchParams.get('fields') ?? '', /cc_cofactor/)
  assert.match(searchParams.get('fields') ?? '', /cc_pathway/)
  assert.match(searchParams.get('fields') ?? '', /cc_interaction/)
  assert.match(searchParams.get('fields') ?? '', /cc_alternative_products/)
  assert.match(searchParams.get('fields') ?? '', /lit_pubmed_id/)
  assert.match(searchParams.get('fields') ?? '', /ft_domain/)
  assert.match(searchParams.get('fields') ?? '', /ft_act_site/)
  assert.match(searchParams.get('fields') ?? '', /ft_variant/)
  assert.match(searchParams.get('fields') ?? '', /ft_signal/)
  assert.match(searchParams.get('fields') ?? '', /ft_transmem/)
  assert.match(searchParams.get('fields') ?? '', /ft_topo_dom/)
  assert.match(searchParams.get('fields') ?? '', /ft_chain/)
  assert.match(searchParams.get('fields') ?? '', /ft_motif/)
  assert.match(searchParams.get('fields') ?? '', /ft_mutagen/)
  assert.match(searchParams.get('fields') ?? '', /xref_refseq/)
  assert.match(searchParams.get('fields') ?? '', /xref_embl/)
  assert.doesNotMatch(searchParams.get('fields') ?? '', /xref_uniparc/)
  assert.match(searchParams.get('fields') ?? '', /xref_alphafolddb/)
  assert.match(searchParams.get('fields') ?? '', /xref_interpro/)
  assert.match(searchParams.get('fields') ?? '', /xref_pfam/)
  assert.match(searchParams.get('fields') ?? '', /xref_string/)
  assert.match(searchParams.get('fields') ?? '', /xref_chembl/)
  assert.match(searchParams.get('fields') ?? '', /xref_drugbank/)
  assert.match(searchParams.get('fields') ?? '', /xref_proteomes/)
  const filteredSearchParams = buildUniProtKbSearchParams({
    domain: 'protein',
    filters: [
      { field: 'protein_name', op: 'like', value: 'DNA repair protein' },
      { field: 'ec_number', op: 'in', value: ['2.3.2.27', '3.4.21.4'] },
      { field: 'go_id', op: '=', value: 'GO:0005634' },
      { field: 'keyword', op: '=', value: 'DNA damage' },
      { field: 'xref', op: '=', value: 'pdb-1jm7' },
      { field: 'database', op: '=', value: 'pdb' },
      { field: 'sequence_length', op: 'between', value: [100, 200] },
      { field: 'date_modified', op: '>=', value: '2020-01-01' }
    ],
    limit: 5
  })
  assert.equal(
    filteredSearchParams.get('query'),
    'protein_name:"DNA repair protein" AND (ec:2.3.2.27 OR ec:3.4.21.4) AND keyword:"DNA damage" AND go:GO:0005634 AND xref:pdb-1jm7 AND database:pdb AND length:[100 TO 200] AND date_modified:[2020-01-01 TO *]'
  )
  assert.equal(
    directUniProtKbAccession({
      domain: 'protein',
      filters: [{ field: 'accession', op: '=', value: 'p38398' }],
      limit: 1
    }),
    'P38398'
  )
  assert.equal(
    directUniProtKbAccession({
      domain: 'protein',
      filters: [{ field: 'accession', op: '=', value: 'BRCA1' }],
      limit: 1
    }),
    undefined
  )
  assert.equal(
    directUniProtKbAccession({
      domain: 'protein',
      filters: [
        { field: 'accession', op: '=', value: 'P38398' },
        { field: 'organism_id', op: '=', value: '9606' }
      ],
      limit: 1
    }),
    undefined
  )

  let calls = 0
  const adapter = new UniProtAdapter(manifest, {
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-uniprot-rest',
      async fetch(input) {
        calls += 1
        assert.equal(input.hostname, 'rest.uniprot.org')
        assert.equal(input.search, '')
        if (input.pathname === '/uniprotkb/P38398.fasta') {
          return new Response(
            `>sp|P38398|BRCA1_HUMAN Breast cancer type 1 susceptibility protein OS=Homo sapiens
MDLSALRVEEVQNVINAMQKILECPICLELIKE`,
            {
              status: 200,
              headers: {
                'content-type': 'text/x-fasta',
                'x-uniprot-release': '2026_04'
              }
            }
          )
        }
        if (input.pathname === '/uniprotkb/P38398.txt') {
          return new Response(
            `ID   BRCA1_HUMAN
AC   P38398;
DE   RecName: Full=Breast cancer type 1 susceptibility protein;`,
            {
              status: 200,
              headers: {
                'content-type': 'text/plain',
                'x-uniprot-release': '2026_04'
              }
            }
          )
        }
        assert.equal(input.pathname, '/uniprotkb/P38398.json')
        return new Response(
          JSON.stringify({
            primaryAccession: 'P38398',
            secondaryAccessions: ['A0A024RBG1'],
            uniProtkbId: 'BRCA1_HUMAN',
            entryType: 'UniProtKB reviewed (Swiss-Prot)',
            proteinExistence: 'Evidence at protein level',
            annotationScore: 5,
            entryAudit: {
              firstPublicDate: '1986-07-21',
              lastAnnotationUpdateDate: '2026-04-08',
              lastSequenceUpdateDate: '2001-11-01',
              entryVersion: 309,
              sequenceVersion: 3
            },
            proteinDescription: {
              recommendedName: {
                fullName: { value: 'Breast cancer type 1 susceptibility protein' },
                ecNumbers: [{ value: '2.3.2.27' }]
              },
              alternativeNames: [
                {
                  fullName: { value: 'RING-type E3 ubiquitin transferase' },
                  shortNames: [{ value: 'RING E3 ligase BRCA1' }]
                }
              ]
            },
            genes: [
              {
                geneName: { value: 'BRCA1' },
                synonyms: [{ value: 'RNF53' }],
                orderedLocusNames: [{ value: 'RP11-242D8.1' }],
                orfNames: [{ value: 'HSPC029' }]
              }
            ],
            organism: {
              scientificName: 'Homo sapiens',
              taxonId: 9606,
              lineage: ['Eukaryota', 'Metazoa', 'Chordata', 'Mammalia']
            },
            sequence: {
              value: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
              length: 1863,
              molWeight: 207721
            },
            comments: [
              {
                commentType: 'FUNCTION',
                texts: [{ value: 'E3 ubiquitin-protein ligase.' }]
              },
              {
                commentType: 'CATALYTIC ACTIVITY',
                reaction: {
                  name: 'S-ubiquitinyl-[E2 ubiquitin-conjugating enzyme] + [acceptor protein]-L-lysine = [E2 ubiquitin-conjugating enzyme]-L-cysteine + N(6)-ubiquitinyl-[acceptor protein]-L-lysine.',
                  ecNumber: '2.3.2.27',
                  reactionCrossReferences: [{ database: 'Rhea', id: 'RHEA:10000' }]
                },
                texts: [{ value: 'Requires BARD1 for efficient activity.' }]
              },
              {
                commentType: 'COFACTOR',
                cofactors: [
                  {
                    name: 'Zn(2+)',
                    cofactorCrossReference: { database: 'ChEBI', id: 'CHEBI:29105' }
                  }
                ],
                texts: [{ value: 'Binds zinc through the RING domain.' }]
              },
              {
                commentType: 'DISEASE',
                texts: [{ value: 'Variants are associated with breast cancer.' }]
              },
              {
                commentType: 'PATHWAY',
                texts: [{ value: 'Protein modification; protein ubiquitination.' }]
              },
              {
                commentType: 'SUBCELLULAR LOCATION',
                subcellularLocations: [{ location: { value: 'Nucleus' } }]
              },
              {
                commentType: 'INTERACTION',
                interactions: [
                  {
                    interactantOne: {
                      uniProtKBAccession: 'P38398',
                      geneName: 'BRCA1'
                    },
                    interactantTwo: {
                      uniProtKBAccession: 'Q99728',
                      geneName: 'BARD1'
                    },
                    numberOfExperiments: 12
                  }
                ]
              },
              {
                commentType: 'ALTERNATIVE PRODUCTS',
                isoforms: [
                  {
                    isoformIds: ['P38398-1'],
                    name: { value: 'Isoform 1' },
                    sequenceStatus: 'Displayed',
                    sequenceIds: ['VSP_000001'],
                    note: { value: 'Canonical sequence.' }
                  },
                  {
                    isoformIds: ['P38398-2'],
                    name: { value: 'Isoform 2' },
                    sequenceStatus: 'Described',
                    sequenceIds: ['VSP_000002'],
                    note: { value: 'Alternative splicing removes an internal segment.' }
                  }
                ]
              }
            ],
            references: [
              {
                citation: {
                  citationType: 'journal article',
                  title:
                    'A strong candidate for the breast and ovarian cancer susceptibility gene BRCA1.',
                  journal: 'Science',
                  publicationDate: '1994',
                  volume: '266',
                  firstPage: '66',
                  lastPage: '71',
                  citationCrossReferences: [
                    { database: 'PubMed', id: '7545954' },
                    { database: 'DOI', id: '10.1126/science.7545954' }
                  ]
                }
              }
            ],
            keywords: [{ name: 'DNA damage' }, { name: 'Tumor suppressor' }],
            features: [
              {
                type: 'Domain',
                description: 'RING-type zinc finger',
                featureId: 'PRO_0000055732',
                location: { start: { value: 24 }, end: { value: 64 } }
              },
              {
                type: 'Region',
                description: 'Interaction with BARD1',
                location: { start: { value: 1 }, end: { value: 100 } }
              },
              {
                type: 'Active site',
                description: 'Cysteine radical intermediate',
                location: { start: { value: 61 }, end: { value: 61 } }
              },
              {
                type: 'Binding site',
                description: 'Zinc 1',
                location: { start: { value: 39 }, end: { value: 39 } }
              },
              {
                type: 'Modified residue',
                description: 'Phosphoserine',
                location: { start: { value: 1524 }, end: { value: 1524 } }
              },
              {
                type: 'Natural variant',
                description: 'Breast cancer-associated variant',
                featureId: 'VAR_007766',
                location: { start: { value: 1699 }, end: { value: 1699 } }
              },
              {
                type: 'Signal peptide',
                description: 'Predicted signal peptide',
                location: { start: { value: 1 }, end: { value: 22 } }
              },
              {
                type: 'Transmembrane',
                description: 'Helical',
                location: { start: { value: 23 }, end: { value: 45 } }
              },
              {
                type: 'Topological domain',
                description: 'Cytoplasmic',
                location: { start: { value: 46 }, end: { value: 80 } }
              },
              {
                type: 'Chain',
                description: 'Mature protein',
                featureId: 'PRO_000000001',
                location: { start: { value: 23 }, end: { value: 1863 } }
              },
              {
                type: 'Peptide',
                description: 'Processed peptide',
                location: { start: { value: 100 }, end: { value: 120 } }
              },
              {
                type: 'Propeptide',
                description: 'Activation peptide',
                location: { start: { value: 121 }, end: { value: 140 } }
              },
              {
                type: 'Repeat',
                description: 'BRCT repeat 1',
                location: { start: { value: 1646 }, end: { value: 1736 } }
              },
              {
                type: 'Motif',
                description: 'Nuclear localization signal',
                location: { start: { value: 503 }, end: { value: 508 } }
              },
              {
                type: 'Coiled coil',
                description: 'Coiled coil region',
                location: { start: { value: 1364 }, end: { value: 1437 } }
              },
              {
                type: 'Zinc finger',
                description: 'RING-type',
                location: { start: { value: 24 }, end: { value: 64 } }
              },
              {
                type: 'Disulfide bond',
                description: 'Interchain',
                location: { start: { value: 61 }, end: { value: 64 } }
              },
              {
                type: 'Mutagenesis',
                description: 'C61G disrupts ligase activity',
                location: { start: { value: 61 }, end: { value: 61 } }
              }
            ],
            uniProtKBCrossReferences: [
              { database: 'GO', id: 'GO:0005634' },
              { database: 'PDB', id: '1JM7' },
              { database: 'Ensembl', id: 'ENSG00000012048' },
              { database: 'RefSeq', id: 'NP_009225.1' },
              { database: 'GeneID', id: '672' },
              { database: 'EMBL', id: 'U14680' },
              { database: 'UniParc', id: 'UPI0000001B66' },
              { database: 'CCDS', id: 'CCDS11453.1' },
              { database: 'AlphaFoldDB', id: 'P38398' },
              { database: 'InterPro', id: 'IPR001841' },
              { database: 'Pfam', id: 'PF00533' },
              { database: 'PROSITE', id: 'PS50089' },
              { database: 'SMART', id: 'SM00184' },
              { database: 'SUPFAM', id: 'SSF57903' },
              { database: 'STRING', id: '9606.ENSP00000350283' },
              { database: 'Reactome', id: 'R-HSA-5685938' },
              { database: 'KEGG', id: 'hsa:672' },
              { database: 'ChEMBL', id: 'CHEMBL5990' },
              { database: 'DrugBank', id: 'DB12345' },
              { database: 'Proteomes', id: 'UP000005640' }
            ]
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-uniprot-release': '2026_04'
            }
          }
        )
      }
    }
  })

  const result = await adapter.query(
    {
      domain: 'protein',
      filters: [{ field: 'accession', op: '=', value: 'P38398' }],
      fields: [
        'accession',
        'entry_name',
        'reviewed',
        'protein_name',
        'alternative_protein_names',
        'protein_existence',
        'gene_name',
        'gene_synonyms',
        'ordered_locus_names',
        'orf_names',
        'organism_lineage',
        'sequence',
        'fasta',
        'flat_file',
        'date_created',
        'date_modified',
        'date_sequence_modified',
        'entry_version',
        'sequence_version',
        'pubmed_ids',
        'references',
        'catalytic_activities',
        'cofactors',
        'pathways',
        'interactions',
        'isoforms',
        'isoform_ids',
        'ec_numbers',
        'keywords',
        'disease_comments',
        'subcellular_locations',
        'domains',
        'regions',
        'active_sites',
        'binding_sites',
        'modified_residues',
        'variants',
        'signal_peptides',
        'transmembrane_regions',
        'topological_domains',
        'chains',
        'peptides',
        'propeptides',
        'repeats',
        'motifs',
        'coiled_coils',
        'zinc_fingers',
        'disulfide_bonds',
        'mutagenesis_sites',
        'refseq_ids',
        'gene_ids',
        'embl_ids',
        'uniparc_ids',
        'ccds_ids',
        'alphafold_ids',
        'interpro_ids',
        'pfam_ids',
        'prosite_ids',
        'smart_ids',
        'supfam_ids',
        'string_ids',
        'reactome_ids',
        'kegg_ids',
        'chembl_ids',
        'drugbank_ids',
        'proteome_ids',
        'url',
        'download_urls',
        'download_files'
      ],
      limit: 1
    },
    { defaultProxyMode: 'disabled' }
  )

  assert.equal(calls, 3)
  assert.deepEqual(result.rows[0], {
    accession: 'P38398',
    entry_name: 'BRCA1_HUMAN',
    reviewed: true,
    protein_name: 'Breast cancer type 1 susceptibility protein',
    alternative_protein_names: ['RING-type E3 ubiquitin transferase', 'RING E3 ligase BRCA1'],
    protein_existence: 'Evidence at protein level',
    gene_name: 'BRCA1',
    gene_synonyms: ['RNF53'],
    ordered_locus_names: ['RP11-242D8.1'],
    orf_names: ['HSPC029'],
    organism_lineage: ['Eukaryota', 'Metazoa', 'Chordata', 'Mammalia'],
    sequence: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
    fasta:
      '>sp|P38398|BRCA1_HUMAN Breast cancer type 1 susceptibility protein OS=Homo sapiens\nMDLSALRVEEVQNVINAMQKILECPICLELIKE',
    flat_file:
      'ID   BRCA1_HUMAN\nAC   P38398;\nDE   RecName: Full=Breast cancer type 1 susceptibility protein;',
    date_created: '1986-07-21',
    date_modified: '2026-04-08',
    date_sequence_modified: '2001-11-01',
    entry_version: 309,
    sequence_version: 3,
    pubmed_ids: ['7545954'],
    references: [
      {
        title: 'A strong candidate for the breast and ovarian cancer susceptibility gene BRCA1.',
        citation_type: 'journal article',
        journal: 'Science',
        publication_date: '1994',
        volume: '266',
        first_page: '66',
        last_page: '71',
        pubmed_id: '7545954',
        doi: '10.1126/science.7545954'
      }
    ],
    catalytic_activities: [
      {
        reaction:
          'S-ubiquitinyl-[E2 ubiquitin-conjugating enzyme] + [acceptor protein]-L-lysine = [E2 ubiquitin-conjugating enzyme]-L-cysteine + N(6)-ubiquitinyl-[acceptor protein]-L-lysine.',
        ec_number: '2.3.2.27',
        reaction_cross_references: [{ database: 'Rhea', id: 'RHEA:10000' }],
        notes: ['Requires BARD1 for efficient activity.']
      }
    ],
    cofactors: [
      {
        name: 'Zn(2+)',
        database: 'ChEBI',
        id: 'CHEBI:29105',
        notes: ['Binds zinc through the RING domain.']
      }
    ],
    pathways: ['Protein modification; protein ubiquitination.'],
    interactions: [
      {
        interactant_one: {
          accession: 'P38398',
          gene_name: 'BRCA1'
        },
        interactant_two: {
          accession: 'Q99728',
          gene_name: 'BARD1'
        },
        experiments: 12
      }
    ],
    isoforms: [
      {
        ids: ['P38398-1'],
        name: 'Isoform 1',
        sequence_status: 'Displayed',
        sequence_ids: ['VSP_000001'],
        note: 'Canonical sequence.',
        urls: {
          'P38398-1': 'https://rest.uniprot.org/uniprotkb/P38398-1.fasta'
        }
      },
      {
        ids: ['P38398-2'],
        name: 'Isoform 2',
        sequence_status: 'Described',
        sequence_ids: ['VSP_000002'],
        note: 'Alternative splicing removes an internal segment.',
        urls: {
          'P38398-2': 'https://rest.uniprot.org/uniprotkb/P38398-2.fasta'
        }
      }
    ],
    isoform_ids: ['P38398-1', 'P38398-2'],
    ec_numbers: ['2.3.2.27'],
    keywords: ['DNA damage', 'Tumor suppressor'],
    disease_comments: ['Variants are associated with breast cancer.'],
    subcellular_locations: ['Nucleus'],
    domains: [
      {
        type: 'Domain',
        description: 'RING-type zinc finger',
        feature_id: 'PRO_0000055732',
        start: 24,
        end: 64
      }
    ],
    regions: [
      {
        type: 'Region',
        description: 'Interaction with BARD1',
        start: 1,
        end: 100
      }
    ],
    active_sites: [
      {
        type: 'Active site',
        description: 'Cysteine radical intermediate',
        start: 61,
        end: 61
      }
    ],
    binding_sites: [
      {
        type: 'Binding site',
        description: 'Zinc 1',
        start: 39,
        end: 39
      }
    ],
    modified_residues: [
      {
        type: 'Modified residue',
        description: 'Phosphoserine',
        start: 1524,
        end: 1524
      }
    ],
    variants: [
      {
        type: 'Natural variant',
        description: 'Breast cancer-associated variant',
        feature_id: 'VAR_007766',
        start: 1699,
        end: 1699
      }
    ],
    signal_peptides: [
      {
        type: 'Signal peptide',
        description: 'Predicted signal peptide',
        start: 1,
        end: 22
      }
    ],
    transmembrane_regions: [
      {
        type: 'Transmembrane',
        description: 'Helical',
        start: 23,
        end: 45
      }
    ],
    topological_domains: [
      {
        type: 'Topological domain',
        description: 'Cytoplasmic',
        start: 46,
        end: 80
      }
    ],
    chains: [
      {
        type: 'Chain',
        description: 'Mature protein',
        feature_id: 'PRO_000000001',
        start: 23,
        end: 1863
      }
    ],
    peptides: [
      {
        type: 'Peptide',
        description: 'Processed peptide',
        start: 100,
        end: 120
      }
    ],
    propeptides: [
      {
        type: 'Propeptide',
        description: 'Activation peptide',
        start: 121,
        end: 140
      }
    ],
    repeats: [
      {
        type: 'Repeat',
        description: 'BRCT repeat 1',
        start: 1646,
        end: 1736
      }
    ],
    motifs: [
      {
        type: 'Motif',
        description: 'Nuclear localization signal',
        start: 503,
        end: 508
      }
    ],
    coiled_coils: [
      {
        type: 'Coiled coil',
        description: 'Coiled coil region',
        start: 1364,
        end: 1437
      }
    ],
    zinc_fingers: [
      {
        type: 'Zinc finger',
        description: 'RING-type',
        start: 24,
        end: 64
      }
    ],
    disulfide_bonds: [
      {
        type: 'Disulfide bond',
        description: 'Interchain',
        start: 61,
        end: 64
      }
    ],
    mutagenesis_sites: [
      {
        type: 'Mutagenesis',
        description: 'C61G disrupts ligase activity',
        start: 61,
        end: 61
      }
    ],
    refseq_ids: ['NP_009225.1'],
    gene_ids: ['672'],
    embl_ids: ['U14680'],
    uniparc_ids: ['UPI0000001B66'],
    ccds_ids: ['CCDS11453.1'],
    alphafold_ids: ['P38398'],
    interpro_ids: ['IPR001841'],
    pfam_ids: ['PF00533'],
    prosite_ids: ['PS50089'],
    smart_ids: ['SM00184'],
    supfam_ids: ['SSF57903'],
    string_ids: ['9606.ENSP00000350283'],
    reactome_ids: ['R-HSA-5685938'],
    kegg_ids: ['hsa:672'],
    chembl_ids: ['CHEMBL5990'],
    drugbank_ids: ['DB12345'],
    proteome_ids: ['UP000005640'],
    url: 'https://www.uniprot.org/uniprotkb/P38398/entry',
    download_urls: {
      entry: 'https://www.uniprot.org/uniprotkb/P38398/entry',
      json: 'https://rest.uniprot.org/uniprotkb/P38398.json',
      fasta: 'https://rest.uniprot.org/uniprotkb/P38398.fasta',
      txt: 'https://rest.uniprot.org/uniprotkb/P38398.txt'
    },
    download_files: [
      {
        kind: 'uniprot_json',
        accession: 'P38398',
        label: 'UniProtKB JSON record',
        url: 'https://rest.uniprot.org/uniprotkb/P38398.json',
        format: 'json',
        availability: 'direct_url',
        source: 'derived_from_uniprot_accession'
      },
      {
        kind: 'uniprot_fasta',
        accession: 'P38398',
        label: 'UniProtKB FASTA sequence',
        url: 'https://rest.uniprot.org/uniprotkb/P38398.fasta',
        format: 'fasta',
        availability: 'direct_url',
        source: 'derived_from_uniprot_accession'
      },
      {
        kind: 'uniprot_txt',
        accession: 'P38398',
        label: 'UniProtKB flat-file record',
        url: 'https://rest.uniprot.org/uniprotkb/P38398.txt',
        format: 'txt',
        availability: 'direct_url',
        source: 'derived_from_uniprot_accession'
      }
    ],
    source_database: 'rest-json/uniprot',
    source_domain: 'protein',
    stable_id: 'P38398',
    stable_id_namespace: 'uniprot.accession',
    primary_url: 'https://www.uniprot.org/uniprotkb/P38398/entry'
  })
  assert.equal(result.totalRows, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.nextCursor, undefined)
  assert.equal(result.provenance.database, 'rest-json/uniprot')
  assert.equal(result.provenance.sourceVersion, '2026_04')
  assert.equal(result.provenance.transportName, 'mock-uniprot-rest')
  assert.equal(result.provenance.defaultProxyMode, 'disabled')
})

test('UniProt adapter rejects filters that cannot be translated before network access', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  let calls = 0
  const adapter = new UniProtAdapter(parsed.manifest as DbConnectorManifest, {
    transport: {
      name: 'unexpected-uniprot-network',
      async fetch() {
        calls += 1
        return new Response('{}', { status: 200 })
      }
    }
  })

  await assert.rejects(
    () =>
      adapter.query({
        domain: 'protein',
        filters: [{ field: 'gene_nam', op: '=', value: 'BRCA1' }],
        limit: 10
      }),
    /does not accept filter: gene_nam/
  )
  await assert.rejects(
    () =>
      adapter.query({
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '>', value: 'BRCA1' }],
        limit: 10
      }),
    /does not support op > for filter: gene_name/
  )
  await assert.rejects(
    () =>
      adapter.query({
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
        rawQuery: 'gene_exact:BRCA1',
        limit: 10
      }),
    /filters and rawQuery cannot be used together/
  )
  await assert.rejects(
    () =>
      adapter.query({
        domain: 'id_mapping',
        filters: [
          { field: 'to', op: '=', value: 'Ensembl' },
          { field: 'ids', op: 'in', value: ['P38398'] },
          { field: 'extra', op: '=', value: 'ignored' }
        ],
        limit: 10
      }),
    /does not accept filter: extra/
  )
  await assert.rejects(
    () =>
      adapter.query({
        domain: 'uniref',
        filters: [{ field: 'identity', op: '>', value: 0.9 }],
        limit: 10
      }),
    /does not support op > for filter: identity/
  )
  assert.equal(calls, 0)
})

test('UniProt adapter queries UniRef, UniParc, and Proteomes REST collections', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  assert.equal(
    ['uniref', 'uniparc', 'proteome'].every((domain) =>
      manifest.domains.some((candidate) => candidate.id === domain)
    ),
    true
  )

  const seenPaths: string[] = []
  const adapter = new UniProtAdapter(manifest, {
    now: () => new Date('2026-09-19T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-uniprot-collections',
      async fetch(input) {
        seenPaths.push(`${input.pathname}${input.search}`)
        assert.equal(input.hostname, 'rest.uniprot.org')
        assert.equal(input.searchParams.get('format'), 'json')
        assert.equal(input.searchParams.get('size'), '1')

        if (input.pathname === '/uniref/search') {
          assert.equal(input.searchParams.get('query'), 'UniRef50_P38398')
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'UniRef50_P38398',
                  name: 'Cluster: Breast cancer type 1 susceptibility protein',
                  entryType: 'UniRef50',
                  updated: '2026-09-02',
                  commonTaxon: { scientificName: 'Eukaryota', taxonId: 2759 },
                  memberCount: 42,
                  organismCount: 12,
                  seedId: 'P38398',
                  memberIdTypes: ['UniProtKB ID'],
                  members: ['P38398', 'A0A024RBG1'],
                  organisms: [
                    { scientificName: 'Homo sapiens', commonName: 'Human', taxonId: 9606 }
                  ],
                  goTerms: [{ goId: 'GO:0005634', aspect: 'Cellular component' }, {}],
                  representativeMember: {
                    memberId: 'P38398',
                    memberIdType: 'UniProtKB ID',
                    proteinName: 'Breast cancer type 1 susceptibility protein',
                    organismName: 'Homo sapiens',
                    organismTaxId: 9606,
                    accessions: ['P38398'],
                    uniref90Id: 'UniRef90_P38398',
                    uniref100Id: 'UniRef100_P38398',
                    uniparcId: 'UPI0000126AC8',
                    sequence: {
                      value: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
                      length: 1863,
                      molWeight: 207721,
                      crc64: 'ABCDEF0123456789',
                      md5: '0123456789abcdef0123456789abcdef'
                    }
                  }
                }
              ]
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-total-results': '1',
                'x-uniprot-release': '2026_04'
              }
            }
          )
        }

        if (input.pathname === '/uniparc/search') {
          assert.equal(input.searchParams.get('query'), 'P38398')
          return new Response(
            JSON.stringify({
              results: [
                {
                  uniParcId: 'UPI0000126AC8',
                  crossReferenceCount: 88,
                  uniProtKBAccessions: ['P38398'],
                  commonTaxons: [
                    { topLevel: 'Eukaryota', commonTaxon: 'Homo sapiens', commonTaxonId: 9606 },
                    {}
                  ],
                  sequence: {
                    value: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
                    length: 1863,
                    molWeight: 207721,
                    crc64: 'ABCDEF0123456789',
                    md5: '0123456789abcdef0123456789abcdef'
                  },
                  sequenceFeatures: [
                    {
                      database: 'InterPro',
                      databaseId: 'IPR001841',
                      interproGroup: { id: 'IPR001841', name: 'Zinc finger, RING-type' },
                      locations: [{ start: 24, end: 64, alignment: '24..64' }, {}]
                    },
                    {}
                  ],
                  oldestCrossRefCreated: '1995-11-01',
                  mostRecentCrossRefUpdated: '2026-04-08'
                }
              ]
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-total-results': '1',
                'x-uniprot-release': '2026_04'
              }
            }
          )
        }

        assert.equal(input.pathname, '/proteomes/search')
        assert.equal(input.searchParams.get('query'), 'UP000005640')
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'UP000005640',
                description: 'Homo sapiens reference proteome',
                taxonomy: {
                  scientificName: 'Homo sapiens',
                  commonName: 'Human',
                  taxonId: 9606,
                  mnemonic: 'HUMAN'
                },
                modified: '2026-04-22',
                proteomeType: 'Reference proteome',
                superkingdom: 'Eukaryota',
                geneCount: 20642,
                proteinCount: 81653,
                annotationScore: 4.2,
                proteomeStatistics: {
                  reviewedProteinCount: 20419,
                  unreviewedProteinCount: 61234,
                  isoformProteinCount: 42120
                },
                genomeAssembly: {
                  assemblyId: 'GCA_000001405.29',
                  genomeAssemblyUrl: 'https://www.ncbi.nlm.nih.gov/assembly/GCA_000001405.29',
                  level: 'Chromosome',
                  source: 'Genome assembly'
                },
                genomeAnnotation: {
                  source: 'Ensembl',
                  url: 'https://www.ensembl.org/Homo_sapiens'
                },
                components: [
                  {
                    name: 'Chromosome 17',
                    proteinCount: 3300,
                    genomeAnnotation: { source: 'Ensembl' },
                    proteomeCrossReferences: [{ id: 'CM000679.2' }]
                  }
                ],
                citations: [
                  {
                    citationCrossReferences: [{ database: 'PubMed', id: '30357393' }]
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-total-results': '1',
              'x-uniprot-release': '2026_04'
            }
          }
        )
      }
    }
  })

  const uniref = await adapter.query({
    domain: 'uniref',
    rawQuery: 'UniRef50_P38398',
    fields: ['id', 'representative_member_id', 'sequence_length', 'go_terms', 'url'],
    limit: 1
  })
  assert.deepEqual(uniref.rows[0], {
    id: 'UniRef50_P38398',
    representative_member_id: 'P38398',
    sequence_length: 1863,
    go_terms: [{ go_id: 'GO:0005634', aspect: 'Cellular component' }],
    url: 'https://www.uniprot.org/uniref/UniRef50_P38398',
    source_database: 'rest-json/uniprot',
    source_domain: 'uniref',
    stable_id: 'UniRef50_P38398',
    stable_id_namespace: 'uniprot.uniref_id',
    primary_url: 'https://www.uniprot.org/uniref/UniRef50_P38398'
  })
  assert.equal(uniref.provenance.domain, 'uniref')
  assert.equal(uniref.provenance.sourceVersion, '2026_04')
  assert.equal(uniref.truncated, false)
  assert.equal(uniref.nextCursor, undefined)

  const uniparc = await adapter.query({
    domain: 'uniparc',
    rawQuery: 'P38398',
    fields: ['uniparc_id', 'uniprotkb_accessions', 'common_taxons', 'sequence_features', 'url'],
    limit: 1
  })
  assert.deepEqual(uniparc.rows[0], {
    uniparc_id: 'UPI0000126AC8',
    uniprotkb_accessions: ['P38398'],
    common_taxons: [{ top_level: 'Eukaryota', common_taxon: 'Homo sapiens', tax_id: 9606 }],
    sequence_features: [
      {
        database: 'InterPro',
        database_id: 'IPR001841',
        interpro_id: 'IPR001841',
        interpro_name: 'Zinc finger, RING-type',
        locations: [{ start: 24, end: 64, alignment: '24..64' }]
      }
    ],
    url: 'https://www.uniprot.org/uniparc/UPI0000126AC8',
    source_database: 'rest-json/uniprot',
    source_domain: 'uniparc',
    stable_id: 'UPI0000126AC8',
    stable_id_namespace: 'uniprot.uniparc_id',
    primary_url: 'https://www.uniprot.org/uniparc/UPI0000126AC8'
  })
  assert.equal(uniparc.provenance.domain, 'uniparc')
  assert.equal(uniparc.truncated, false)
  assert.equal(uniparc.nextCursor, undefined)

  const proteome = await adapter.query({
    domain: 'proteome',
    rawQuery: 'UP000005640',
    fields: ['id', 'organism', 'tax_id', 'protein_count', 'components', 'pubmed_ids', 'url'],
    limit: 1
  })
  assert.deepEqual(proteome.rows[0], {
    id: 'UP000005640',
    organism: 'Homo sapiens',
    tax_id: 9606,
    protein_count: 81653,
    components: [
      {
        name: 'Chromosome 17',
        protein_count: 3300,
        genome_annotation_source: 'Ensembl',
        genome_accessions: ['CM000679.2']
      }
    ],
    pubmed_ids: ['30357393'],
    url: 'https://www.uniprot.org/proteomes/UP000005640',
    source_database: 'rest-json/uniprot',
    source_domain: 'proteome',
    stable_id: 'UP000005640',
    stable_id_namespace: 'uniprot.proteome_id',
    primary_url: 'https://www.uniprot.org/proteomes/UP000005640'
  })
  assert.equal(proteome.provenance.domain, 'proteome')
  assert.equal(proteome.truncated, false)
  assert.equal(proteome.nextCursor, undefined)
  assert.deepEqual(
    seenPaths.map((path) => path.split('?')[0]),
    ['/uniref/search', '/uniparc/search', '/proteomes/search']
  )
})

test('UniProt adapter runs ID mapping jobs and normalizes mapping results', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/uniprot/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  assert.equal(
    manifest.domains.some((domain) => domain.id === 'id_mapping'),
    true
  )

  const calls: Array<{ path: string; method?: string; body?: string }> = []
  const adapter = new UniProtAdapter(manifest, {
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-uniprot-id-mapping',
      async fetch(input, init) {
        calls.push({
          path: `${input.pathname}${input.search}`,
          method: init.method,
          body: typeof init.body === 'string' ? init.body : undefined
        })
        assert.equal(input.hostname, 'rest.uniprot.org')
        if (input.pathname === '/idmapping/run') {
          assert.equal(init.method, 'POST')
          assert.equal(init.headers instanceof Headers, true)
          const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
          assert.equal(body.get('from'), 'UniProtKB_AC-ID')
          assert.equal(body.get('to'), 'Ensembl')
          assert.equal(body.get('ids'), 'P38398,Q9Y261')
          return new Response(JSON.stringify({ jobId: 'JOB-123' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (input.pathname === '/idmapping/status/JOB-123') {
          const statusCalls = calls.filter((call) =>
            call.path.startsWith('/idmapping/status/JOB-123')
          ).length
          return new Response(
            JSON.stringify({ jobStatus: statusCalls === 1 ? 'RUNNING' : 'FINISHED' }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-uniprot-release': '2026_04'
              }
            }
          )
        }
        assert.equal(input.pathname, '/idmapping/results/JOB-123')
        assert.equal(input.searchParams.get('format'), 'json')
        assert.equal(input.searchParams.get('size'), '2')
        assert.equal(input.searchParams.get('cursor'), 'next-page')
        return new Response(
          JSON.stringify({
            results: [
              { from: 'P38398', to: 'ENSG00000012048' },
              {
                from: 'Q9Y261',
                to: {
                  id: 'ENSG00000141510',
                  name: 'TP53'
                }
              }
            ],
            failedIds: ['BAD_ID']
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-total-results': '2',
              link: '<https://rest.uniprot.org/idmapping/results/JOB-123?cursor=after>; rel="next"'
            }
          }
        )
      }
    }
  })

  const result = await adapter.query(
    {
      domain: 'id_mapping',
      filters: [
        { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
        { field: 'to', op: '=', value: 'Ensembl' },
        { field: 'ids', op: 'in', value: ['P38398', 'Q9Y261'] }
      ],
      fields: ['from', 'to', 'from_db', 'to_db', 'job_id', 'target', 'failed', 'failure'],
      limit: 2,
      cursor: 'next-page'
    },
    { defaultProxyMode: 'disabled' }
  )

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/idmapping/run',
      '/idmapping/status/JOB-123',
      '/idmapping/status/JOB-123',
      '/idmapping/results/JOB-123?format=json&size=2&cursor=next-page'
    ]
  )
  assert.deepEqual(result.rows, [
    {
      from: 'P38398',
      to: 'ENSG00000012048',
      from_db: 'UniProtKB_AC-ID',
      to_db: 'Ensembl',
      job_id: 'JOB-123',
      failed: false,
      source_database: 'rest-json/uniprot',
      source_domain: 'id_mapping'
    },
    {
      from: 'Q9Y261',
      to: 'ENSG00000141510',
      from_db: 'UniProtKB_AC-ID',
      to_db: 'Ensembl',
      job_id: 'JOB-123',
      target: {
        id: 'ENSG00000141510',
        name: 'TP53'
      },
      failed: false,
      source_database: 'rest-json/uniprot',
      source_domain: 'id_mapping'
    },
    {
      from: 'BAD_ID',
      from_db: 'UniProtKB_AC-ID',
      to_db: 'Ensembl',
      job_id: 'JOB-123',
      failed: true,
      source_database: 'rest-json/uniprot',
      source_domain: 'id_mapping'
    }
  ])
  assert.equal(result.totalRows, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.nextCursor, 'after')
  assert.equal(result.provenance.database, 'rest-json/uniprot')
  assert.equal(result.provenance.domain, 'id_mapping')
  assert.equal(result.provenance.sourceVersion, '2026_04')
  assert.equal(result.provenance.attempts, 4)
  assert.equal(result.provenance.defaultProxyMode, 'disabled')
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
  assert.match(rendered, /up:sequence\/rdf:value \?sequence/)
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
        assert.match(query, /sequence/)
        assert.match(query, /LIMIT 2/)
        assert.match(query, /OFFSET 4/)
        return new Response(
          JSON.stringify({
            head: {
              vars: ['accession', 'mnemonic', 'protein_name', 'gene_name', 'organism', 'sequence']
            },
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
                  organism: { type: 'literal', value: 'Homo sapiens' },
                  sequence: { type: 'literal', value: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE' }
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
      fields: ['accession', 'gene_name', 'protein_name', 'sequence'],
      limit: 2,
      cursor: '4'
    },
    { defaultProxyMode: 'disabled' }
  )

  assert.equal(calls, 1)
  assert.deepEqual(result.rows[0], {
    accession: 'P38398',
    gene_name: 'BRCA1',
    protein_name: 'Breast cancer type 1 susceptibility protein',
    sequence: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
    source_database: 'sparql/uniprot',
    source_domain: 'protein',
    stable_id: 'P38398',
    stable_id_namespace: 'uniprot.accession',
    primary_url: 'https://www.uniprot.org/uniprotkb/P38398/entry'
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
  const geneFetchParams = buildEntrezFetchParams(manifest, { domain: 'gene' }, ['672', '675'])
  assert.equal(geneFetchParams.get('db'), 'gene')
  assert.equal(geneFetchParams.get('id'), '672,675')
  assert.equal(geneFetchParams.get('retmode'), 'xml')
  const fetchParams = buildEntrezFetchParams(manifest, { domain: 'pubmed' }, ['40000001'])
  assert.equal(fetchParams.get('db'), 'pubmed')
  assert.equal(fetchParams.get('id'), '40000001')
  assert.equal(fetchParams.get('retmode'), 'xml')
  const clinvarFetchParams = buildEntrezFetchParams(manifest, { domain: 'clinvar' }, [
    'VCV000012345'
  ])
  assert.equal(clinvarFetchParams.get('db'), 'clinvar')
  assert.equal(clinvarFetchParams.get('id'), 'VCV000012345')
  assert.equal(clinvarFetchParams.get('retmode'), 'xml')
  const proteinFetchParams = buildEntrezFetchParams(manifest, { domain: 'protein' }, ['4557601'])
  assert.equal(proteinFetchParams.get('db'), 'protein')
  assert.equal(proteinFetchParams.get('id'), '4557601')
  assert.equal(proteinFetchParams.get('rettype'), 'fasta')
  assert.equal(proteinFetchParams.get('retmode'), 'text')
  const nucleotideFetchParams = buildEntrezFetchParams(manifest, { domain: 'nucleotide' }, [
    '555931'
  ])
  assert.equal(nucleotideFetchParams.get('db'), 'nuccore')
  assert.equal(nucleotideFetchParams.get('id'), '555931')
  assert.equal(nucleotideFetchParams.get('rettype'), 'fasta')
  assert.equal(nucleotideFetchParams.get('retmode'), 'text')
  const biosampleFetchParams = buildEntrezFetchParams(manifest, { domain: 'biosample' }, ['123456'])
  assert.equal(biosampleFetchParams.get('db'), 'biosample')
  assert.equal(biosampleFetchParams.get('id'), '123456')
  assert.equal(biosampleFetchParams.get('retmode'), 'xml')
  const sraFetchParams = buildEntrezFetchParams(manifest, { domain: 'sra' }, ['100001'])
  assert.equal(sraFetchParams.get('db'), 'sra')
  assert.equal(sraFetchParams.get('id'), '100001')
  assert.equal(sraFetchParams.get('retmode'), 'xml')
  const geoFetchParams = buildEntrezFetchParams(manifest, { domain: 'geo' }, ['200002553'])
  assert.equal(geoFetchParams.get('db'), 'gds')
  assert.equal(geoFetchParams.get('id'), '200002553')
  assert.equal(geoFetchParams.get('retmode'), 'text')
  const bioProjectFetchParams = buildEntrezFetchParams(manifest, { domain: 'bioproject' }, [
    '92161'
  ])
  assert.equal(bioProjectFetchParams.get('db'), 'bioproject')
  assert.equal(bioProjectFetchParams.get('id'), '92161')
  assert.equal(bioProjectFetchParams.get('retmode'), 'xml')
  const taxonomyFetchParams = buildEntrezFetchParams(manifest, { domain: 'taxonomy' }, ['9606'])
  assert.equal(taxonomyFetchParams.get('db'), 'taxonomy')
  assert.equal(taxonomyFetchParams.get('id'), '9606')
  assert.equal(taxonomyFetchParams.get('retmode'), 'xml')
})

test('Entrez request validation rejects ambiguous filters and rawQuery', () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const manifest = parsed.manifest as DbConnectorManifest

  assert.throws(
    () =>
      buildEntrezSearchParams(manifest, {
        domain: 'gene',
        filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
        rawQuery: 'BRCA1[gene]',
        limit: 10
      }),
    /filters and rawQuery cannot be used together/
  )
  assert.throws(
    () =>
      buildEntrezSearchParams(manifest, {
        domain: 'gene',
        filters: [
          { field: 'gene', op: '=', value: 'BRCA1' },
          { field: 'gene', op: '=', value: 'BRCA2' }
        ],
        limit: 10
      }),
    /duplicate filter: gene/
  )
})

test('Entrez adapter queries esearch, esummary, and gene efetch through the DB HTTP policy executor', async () => {
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
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'gene')
          assert.equal(input.searchParams.get('id'), '672,675')
          assert.equal(input.searchParams.get('retmode'), 'xml')
          return new Response(
            `<?xml version="1.0"?>
            <Entrezgene-Set>
              <Entrezgene>
                <Entrezgene_track-info>
                  <Gene-track>
                    <Gene-track_geneid>672</Gene-track_geneid>
                  </Gene-track>
                </Entrezgene_track-info>
                <Entrezgene_type value="protein-coding">6</Entrezgene_type>
                <Entrezgene_source>
                  <BioSource>
                    <BioSource_org>
                      <Org-ref>
                        <Org-ref_taxname>Homo sapiens</Org-ref_taxname>
                        <Org-ref_db>
                          <Dbtag>
                            <Dbtag_db>taxon</Dbtag_db>
                            <Dbtag_tag>
                              <Object-id>
                                <Object-id_id>9606</Object-id_id>
                              </Object-id>
                            </Dbtag_tag>
                          </Dbtag>
                        </Org-ref_db>
                      </Org-ref>
                    </BioSource_org>
                  </BioSource>
                </Entrezgene_source>
                <Entrezgene_gene>
                  <Gene-ref>
                    <Gene-ref_locus>BRCA1</Gene-ref_locus>
                    <Gene-ref_desc>BRCA1 DNA repair associated</Gene-ref_desc>
                    <Gene-ref_maploc>17q21.31</Gene-ref_maploc>
                    <Gene-ref_syn>
                      <Gene-ref_syn_E>BRCC1</Gene-ref_syn_E>
                      <Gene-ref_syn_E>FANCS</Gene-ref_syn_E>
                      <Gene-ref_syn_E>RNF53</Gene-ref_syn_E>
                    </Gene-ref_syn>
                  </Gene-ref>
                </Entrezgene_gene>
                <Entrezgene_summary>BRCA1 is involved in DNA repair and transcriptional regulation.</Entrezgene_summary>
                <Entrezgene_location>
                  <Maps>
                    <Maps_display-str>17q21.31</Maps_display-str>
                  </Maps>
                </Entrezgene_location>
              </Entrezgene>
              <Entrezgene>
                <Entrezgene_track-info>
                  <Gene-track>
                    <Gene-track_geneid>675</Gene-track_geneid>
                  </Gene-track>
                </Entrezgene_track-info>
                <Entrezgene_type value="protein-coding">6</Entrezgene_type>
                <Entrezgene_gene>
                  <Gene-ref>
                    <Gene-ref_locus>BRCA2</Gene-ref_locus>
                    <Gene-ref_desc>BRCA2 DNA repair associated</Gene-ref_desc>
                    <Gene-ref_syn>
                      <Gene-ref_syn_E>FAD1</Gene-ref_syn_E>
                    </Gene-ref_syn>
                  </Gene-ref>
                </Entrezgene_gene>
                <Entrezgene_summary>BRCA2 is involved in homologous recombination repair.</Entrezgene_summary>
              </Entrezgene>
            </Entrezgene-Set>`,
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
  assert.equal(
    result.rows[0].summary,
    'BRCA1 is involved in DNA repair and transcriptional regulation.'
  )
  assert.deepEqual(result.rows[0].aliases, ['BRCC1', 'FANCS', 'RNF53'])
  assert.equal(result.rows[0].mapLocation, '17q21.31')
  assert.equal(result.rows[0].gene_type, 'protein-coding')
  assert.equal(result.rows[0].tax_id, 9606)
  assert.deepEqual(result.rows[0].organism, {
    scientificName: 'Homo sapiens',
    commonName: 'human',
    taxId: 9606
  })
  assert.equal(result.rows[1].symbol, 'BRCA2')
  assert.equal(result.rows[1].summary, 'BRCA2 is involved in homologous recombination repair.')
  assert.deepEqual(result.rows[1].aliases, ['FAD1'])
  assert.equal(result.rows[1].gene_type, 'protein-coding')
  assert.equal(result.totalRows, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.nextCursor, '2')
  assert.equal(result.provenance.retried, true)
  assert.equal(result.provenance.attempts, 4)
  assert.equal(result.provenance.lastStatus, 200)
  assert.equal(result.provenance.transportName, 'mock-ncbi')
  assert.equal(result.provenance.defaultProxyMode, 'auto')

  const projected = await adapter.query({
    domain: 'gene',
    filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
    fields: ['uid', 'symbol'],
    limit: 2
  })
  assert.deepEqual(projected.rows, [
    {
      uid: '672',
      symbol: 'BRCA1',
      source_database: 'entrez/ncbi',
      source_domain: 'gene',
      stable_id: '672',
      stable_id_namespace: 'ncbi.gene_id',
      primary_url: 'https://www.ncbi.nlm.nih.gov/gene/672'
    },
    {
      uid: '675',
      symbol: 'BRCA2',
      source_database: 'entrez/ncbi',
      source_domain: 'gene',
      stable_id: '675',
      stable_id_namespace: 'ncbi.gene_id',
      primary_url: 'https://www.ncbi.nlm.nih.gov/gene/675'
    }
  ])

  const callsBeforeInvalidProjection = calls
  await assert.rejects(
    () =>
      adapter.query({
        domain: 'gene',
        filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
        fields: ['symbl'],
        limit: 2
      }),
    /does not expose field: symbl/
  )
  assert.equal(calls, callsBeforeInvalidProjection)

  await assert.rejects(
    () =>
      adapter.query({
        domain: 'gene',
        filters: [{ field: 'gene', op: '=', value: 'BRCA1' }],
        fields: ['uid', 'uid'],
        limit: 2
      }),
    /duplicate field: uid/
  )
  assert.equal(calls, callsBeforeInvalidProjection)
})

test('Entrez adapter fetches NCBI BioSample XML attributes through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-biosample',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'biosample')
          assert.equal(input.searchParams.get('term'), 'SAMN00000001')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['123456']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'biosample')
          assert.equal(input.searchParams.get('id'), '123456')
          assert.equal(input.searchParams.get('retmode'), 'xml')
          return new Response(
            `<?xml version="1.0"?>
            <BioSampleSet>
              <BioSample access="SAMN00000001" id="123456" submission_date="2024-01-02">
                <Ids>
                  <Id db="BioSample" is_primary="1">SAMN00000001</Id>
                  <Id db_label="Sample name">BRCA1_sample_1</Id>
                </Ids>
                <Description>
                  <Title>Human breast tumor sample</Title>
                  <Organism taxonomy_id="9606" taxonomy_name="Homo sapiens">Homo sapiens</Organism>
                </Description>
                <Owner>
                  <Name>Example Genome Center</Name>
                </Owner>
                <Models>
                  <Model>Generic</Model>
                </Models>
                <Package display_name="Human">Human.1.0</Package>
                <Attributes>
                  <Attribute attribute_name="collection date">2024-01-01</Attribute>
                  <Attribute attribute_name="geo_loc_name">USA: California</Attribute>
                  <Attribute attribute_name="tissue">breast tumor</Attribute>
                  <Attribute attribute_name="isolation-source">primary tumor</Attribute>
                </Attributes>
              </BioSample>
            </BioSampleSet>`,
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'biosample')
        assert.equal(input.searchParams.get('id'), '123456')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['123456'],
              '123456': {
                uid: '123456',
                accession: 'SAMN00000001',
                title: 'Human breast tumor sample',
                organism: 'Homo sapiens',
                taxid: 9606
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const biosample = await adapter.query({
    domain: 'biosample',
    rawQuery: 'SAMN00000001',
    limit: 1
  })

  assert.equal(biosample.rows[0].uid, '123456')
  assert.equal(biosample.rows[0].accession, 'SAMN00000001')
  assert.equal(biosample.rows[0].title, 'Human breast tumor sample')
  assert.equal(biosample.rows[0].organism, 'Homo sapiens')
  assert.equal(biosample.rows[0].tax_id, 9606)
  assert.equal(biosample.rows[0].sample_name, 'BRCA1_sample_1')
  assert.equal(biosample.rows[0].owner, 'Example Genome Center')
  assert.equal(biosample.rows[0].package, 'Human')
  assert.equal(biosample.rows[0].model, 'Generic')
  assert.equal(biosample.rows[0].collection_date, '2024-01-01')
  assert.equal(biosample.rows[0].geo_loc_name, 'USA: California')
  assert.equal(biosample.rows[0].tissue, 'breast tumor')
  assert.equal(biosample.rows[0].isolation_source, 'primary tumor')
  assert.deepEqual(biosample.rows[0].attributes, {
    collection_date: '2024-01-01',
    geo_loc_name: 'USA: California',
    tissue: 'breast tumor',
    isolation_source: 'primary tumor'
  })
  assert.equal(biosample.provenance.attempts, 3)
  assert.equal(biosample.provenance.transportName, 'mock-ncbi-biosample')
})

test('Entrez adapter fetches NCBI SRA experiment and run XML details through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-sra',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'sra')
          assert.equal(input.searchParams.get('term'), 'SRX000001')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['100001']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'sra')
          assert.equal(input.searchParams.get('id'), '100001')
          assert.equal(input.searchParams.get('retmode'), 'xml')
          return new Response(
            `<?xml version="1.0"?>
            <EXPERIMENT_PACKAGE_SET>
              <EXPERIMENT_PACKAGE>
                <STUDY>
                  <IDENTIFIERS>
                    <EXTERNAL_ID namespace="BioProject">PRJNA000001</EXTERNAL_ID>
                  </IDENTIFIERS>
                </STUDY>
                <EXPERIMENT accession="SRX000001">
                  <TITLE>RNA-seq of human breast tumor sample</TITLE>
                  <STUDY_REF accession="SRP000001"/>
                  <DESIGN>
                    <SAMPLE_DESCRIPTOR accession="SRS000001"/>
                    <LIBRARY_DESCRIPTOR>
                      <LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY>
                      <LIBRARY_SOURCE>TRANSCRIPTOMIC</LIBRARY_SOURCE>
                      <LIBRARY_SELECTION>cDNA</LIBRARY_SELECTION>
                      <LIBRARY_LAYOUT>
                        <PAIRED/>
                      </LIBRARY_LAYOUT>
                    </LIBRARY_DESCRIPTOR>
                  </DESIGN>
                  <PLATFORM>
                    <ILLUMINA>
                      <INSTRUMENT_MODEL>Illumina HiSeq 2000</INSTRUMENT_MODEL>
                    </ILLUMINA>
                  </PLATFORM>
                </EXPERIMENT>
                <SAMPLE accession="SRS000001">
                  <SAMPLE_NAME>
                    <TAXON_ID>9606</TAXON_ID>
                    <SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME>
                  </SAMPLE_NAME>
                  <IDENTIFIERS>
                    <EXTERNAL_ID namespace="BioSample">SAMN00000001</EXTERNAL_ID>
                  </IDENTIFIERS>
                </SAMPLE>
                <RUN_SET>
                  <RUN accession="SRR000001" total_spots="1000" total_bases="150000" size="12345" published="2024-01-03">
                    <SRAFiles>
                      <SRAFile cluster="public" filename="SRR000001" url="https://sra-pub-run-odp.s3.amazonaws.com/sra/SRR000001/SRR000001" size="12345" md5="abc123" semantic_name="SRA Normalized" supertype="Original"/>
                    </SRAFiles>
                  </RUN>
                  <RUN accession="SRR000002" total_spots="2000" total_bases="300000" size="23456"/>
                </RUN_SET>
              </EXPERIMENT_PACKAGE>
            </EXPERIMENT_PACKAGE_SET>`,
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'sra')
        assert.equal(input.searchParams.get('id'), '100001')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['100001'],
              '100001': {
                uid: '100001',
                expxml:
                  '<Summary><Title>RNA-seq of human breast tumor sample</Title></Summary><Experiment acc="SRX000001"/><Study acc="SRP000001"/><Organism taxid="9606" ScientificName="Homo sapiens"/><Sample acc="SRS000001"/><Platform instrument_model="Illumina HiSeq 2000">ILLUMINA</Platform><Bioproject>PRJNA000001</Bioproject><Biosample>SAMN00000001</Biosample>',
                runs: '<Run acc="SRR000001" total_spots="1000"/><Run acc="SRR000002" total_spots="2000"/>'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const sra = await adapter.query({
    domain: 'sra',
    rawQuery: 'SRX000001',
    limit: 1
  })

  assert.equal(sra.rows[0].uid, '100001')
  assert.equal(sra.rows[0].accession, 'SRX000001')
  assert.equal(sra.rows[0].title, 'RNA-seq of human breast tumor sample')
  assert.equal(sra.rows[0].study_accession, 'SRP000001')
  assert.equal(sra.rows[0].experiment_accession, 'SRX000001')
  assert.equal(sra.rows[0].sample_accession, 'SRS000001')
  assert.equal(sra.rows[0].biosample_accession, 'SAMN00000001')
  assert.equal(sra.rows[0].bioproject_accession, 'PRJNA000001')
  assert.equal(sra.rows[0].organism, 'Homo sapiens')
  assert.equal(sra.rows[0].tax_id, 9606)
  assert.equal(sra.rows[0].platform, 'ILLUMINA')
  assert.equal(sra.rows[0].instrument_model, 'Illumina HiSeq 2000')
  assert.equal(sra.rows[0].library_strategy, 'RNA-Seq')
  assert.equal(sra.rows[0].library_source, 'TRANSCRIPTOMIC')
  assert.equal(sra.rows[0].library_selection, 'cDNA')
  assert.equal(sra.rows[0].library_layout, 'PAIRED')
  assert.deepEqual(sra.rows[0].run_accessions, ['SRR000001', 'SRR000002'])
  assert.deepEqual(sra.rows[0].runs, [
    {
      accession: 'SRR000001',
      total_spots: 1000,
      total_bases: 150000,
      size: 12345,
      published: '2024-01-03'
    },
    {
      accession: 'SRR000002',
      total_spots: 2000,
      total_bases: 300000,
      size: 23456,
      published: undefined
    }
  ])
  assert.deepEqual(sra.rows[0].download_urls, {
    run_browser: {
      SRR000001: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000001',
      SRR000002: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000002'
    },
    sra_record: {
      SRR000001: 'https://www.ncbi.nlm.nih.gov/sra/SRR000001',
      SRR000002: 'https://www.ncbi.nlm.nih.gov/sra/SRR000002'
    }
  })
  assert.deepEqual(sra.rows[0].download_files, [
    {
      kind: 'sra_file',
      accession: 'SRR000001',
      url: 'https://sra-pub-run-odp.s3.amazonaws.com/sra/SRR000001/SRR000001',
      format: 'sra',
      filename: 'SRR000001',
      size: 12345,
      md5: 'abc123',
      semantic_name: 'SRA Normalized',
      supertype: 'Original',
      cluster: 'public',
      availability: 'direct_url',
      source: 'sra_efetch_xml'
    },
    {
      kind: 'sra_run_browser',
      accession: 'SRR000001',
      url: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000001',
      format: 'html',
      availability: 'landing_page',
      source: 'derived_from_run_accession'
    },
    {
      kind: 'sra_run_browser',
      accession: 'SRR000002',
      url: 'https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=SRR000002',
      format: 'html',
      availability: 'landing_page',
      source: 'derived_from_run_accession'
    }
  ])
  assert.equal(sra.provenance.attempts, 3)
  assert.equal(sra.provenance.transportName, 'mock-ncbi-sra')
})

test('Entrez adapter fetches NCBI GEO DataSets text details through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-geo',
      async fetch(input) {
        if (input.hostname === 'ftp.ncbi.nlm.nih.gov') {
          if (input.pathname.endsWith('/matrix/')) {
            return new Response(
              `<!DOCTYPE HTML>
<html><body><pre>Name Last modified Size <hr>
<a href="GSE2553-GPL1977_series_matrix.txt.gz">GSE2553-GPL1977_series_matrix.txt.gz</a> 2026-07-07 00:52 4.1K
<a href="GSE2553-GPL2019_series_matrix.txt.gz">GSE2553-GPL2019_series_matrix.txt.gz</a> 2026-07-07 00:52 2.7K
</pre></body></html>`,
              { status: 200 }
            )
          }
          if (input.pathname.endsWith('/soft/')) {
            return new Response(
              `<!DOCTYPE HTML>
<html><body><pre>Name Last modified Size <hr>
<a href="GSE2553_family.soft.gz">GSE2553_family.soft.gz</a> 2026-07-07 00:52 24M
</pre></body></html>`,
              { status: 200 }
            )
          }
          if (input.pathname.endsWith('/miniml/')) {
            return new Response(
              `<!DOCTYPE HTML>
<html><body><pre>Name Last modified Size <hr>
<a href="GSE2553_family.xml.tgz">GSE2553_family.xml.tgz</a> 2026-07-07 00:52 18M
</pre></body></html>`,
              { status: 200 }
            )
          }
          if (input.pathname.endsWith('/suppl/')) {
            return new Response(
              `<!DOCTYPE HTML>
<html><body><pre>Name Last modified Size <hr>
<a href="GSE2553_processed_data_file_1.xls.gz">GSE2553_processed_data_file_1.xls.gz</a> 2021-07-13 12:17 8.3M
<a href="GSE2553_processed_data_file_2.xls.gz">GSE2553_processed_data_file_2.xls.gz</a> 2021-07-13 12:17 12M
</pre></body></html>`,
              { status: 200 }
            )
          }
          throw new Error(`Unexpected GEO FTP listing path: ${input.pathname}`)
        }
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'gds')
          assert.equal(input.searchParams.get('term'), 'GSE2553')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['200002553']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'gds')
          assert.equal(input.searchParams.get('id'), '200002553')
          assert.equal(input.searchParams.get('retmode'), 'text')
          return new Response(
            `1. NHGRI_Sarcoma_Baird
(Submitter supplied) Sarcomas are a biologically complex group of tumors of mesenchymal origin.
Organism:\tHomo sapiens
Type:\t\tExpression profiling by array
Platform: GPL1977 2 Samples
FTP download: GEO ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/
Series\t\tAccession: GSE2553\tID: 200002553`,
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'gds')
        assert.equal(input.searchParams.get('id'), '200002553')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['200002553'],
              '200002553': {
                uid: '200002553',
                accession: 'GSE2553',
                title: 'NHGRI_Sarcoma_Baird',
                summary:
                  'Sarcomas are a biologically complex group of tumors of mesenchymal origin.',
                gpl: '1977',
                gse: '2553',
                taxon: 'Homo sapiens',
                entrytype: 'GSE',
                gdstype: 'Expression profiling by array',
                pdat: '2005/10/11',
                samples: [
                  { accession: 'GSM48846', title: 'Patient sample ST248, Liposarcoma' },
                  { accession: 'GSM48763', title: 'Patient sample ST357, Liposarcoma' }
                ],
                n_samples: 2,
                pubmedids: ['16230383'],
                ftplink: 'ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/',
                geo2r: 'yes',
                bioproject: 'PRJNA92161'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const geo = await adapter.query({
    domain: 'geo',
    rawQuery: 'GSE2553',
    limit: 1
  })

  assert.equal(geo.rows[0].uid, '200002553')
  assert.equal(geo.rows[0].accession, 'GSE2553')
  assert.equal(geo.rows[0].title, 'NHGRI_Sarcoma_Baird')
  assert.equal(
    geo.rows[0].summary,
    'Sarcomas are a biologically complex group of tumors of mesenchymal origin.'
  )
  assert.equal(
    geo.rows[0].fetch_summary,
    '(Submitter supplied) Sarcomas are a biologically complex group of tumors of mesenchymal origin.'
  )
  assert.equal(geo.rows[0].organism, 'Homo sapiens')
  assert.equal(geo.rows[0].entry_type, 'GSE')
  assert.equal(geo.rows[0].gds_type, 'Expression profiling by array')
  assert.equal(geo.rows[0].series_accession, 'GSE2553')
  assert.equal(geo.rows[0].platform_accession, 'GPL1977')
  assert.deepEqual(geo.rows[0].sample_accessions, ['GSM48846', 'GSM48763'])
  assert.deepEqual(geo.rows[0].samples, [
    { accession: 'GSM48846', title: 'Patient sample ST248, Liposarcoma' },
    { accession: 'GSM48763', title: 'Patient sample ST357, Liposarcoma' }
  ])
  assert.equal(geo.rows[0].sample_count, 2)
  assert.deepEqual(geo.rows[0].pubmed_ids, ['16230383'])
  assert.equal(geo.rows[0].bioproject_accession, 'PRJNA92161')
  assert.equal(geo.rows[0].ftp_link, 'ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/')
  assert.deepEqual(geo.rows[0].download_urls, {
    series_ftp: 'ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/',
    series_https: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/',
    matrix_dir: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/',
    matrix:
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/GSE2553_series_matrix.txt.gz',
    soft_dir: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/soft/',
    soft_family:
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/soft/GSE2553_family.soft.gz',
    miniml_dir: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/miniml/',
    miniml_family:
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/miniml/GSE2553_family.xml.tgz',
    supplementary_dir: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/',
    raw_tar: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/GSE2553_RAW.tar'
  })
  const geoDownloadFiles = geo.rows[0].download_files as DbDownloadFileCandidate[]
  assert.ok(Array.isArray(geoDownloadFiles))
  assert.deepEqual(geoDownloadFiles.slice(0, 6), [
    {
      kind: 'series_matrix',
      label: 'Series Matrix',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/GSE2553_series_matrix.txt.gz',
      format: 'txt',
      compression: 'gzip',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'series_matrix_directory',
      label: 'Series Matrix Directory',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/',
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'soft_family',
      label: 'SOFT Family',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/soft/GSE2553_family.soft.gz',
      filename: 'GSE2553_family.soft.gz',
      format: 'soft',
      compression: 'gzip',
      size: 25165824,
      availability: 'direct_url',
      source: 'geo_directory_listing'
    },
    {
      kind: 'miniml_family',
      label: 'MINiML Family',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/miniml/GSE2553_family.xml.tgz',
      filename: 'GSE2553_family.xml.tgz',
      format: 'xml',
      compression: 'tgz',
      size: 18874368,
      availability: 'direct_url',
      source: 'geo_directory_listing'
    },
    {
      kind: 'supplementary_directory',
      label: 'Supplementary Directory',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/',
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'raw_tar',
      label: 'Raw Supplementary Archive',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/GSE2553_RAW.tar',
      format: 'tar',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    }
  ])
  assert.deepEqual(
    geoDownloadFiles.find((file) => file.filename === 'GSE2553-GPL1977_series_matrix.txt.gz'),
    {
      kind: 'series_matrix',
      label: 'Series Matrix',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/matrix/GSE2553-GPL1977_series_matrix.txt.gz',
      filename: 'GSE2553-GPL1977_series_matrix.txt.gz',
      format: 'txt',
      compression: 'gzip',
      size: 4198,
      availability: 'direct_url',
      source: 'geo_directory_listing'
    }
  )
  assert.deepEqual(
    geoDownloadFiles.find((file) => file.filename === 'GSE2553_processed_data_file_1.xls.gz'),
    {
      kind: 'supplementary_file',
      label: 'Supplementary File',
      accession: 'GSE2553',
      url: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE2nnn/GSE2553/suppl/GSE2553_processed_data_file_1.xls.gz',
      filename: 'GSE2553_processed_data_file_1.xls.gz',
      format: 'xls',
      compression: 'gzip',
      size: 8703181,
      availability: 'direct_url',
      source: 'geo_directory_listing'
    }
  )
  assert.deepEqual(
    geoDownloadFiles
      .filter((file) => file.source === 'geo_directory_listing')
      .map((file) => [file.kind, file.filename]),
    [
      ['soft_family', 'GSE2553_family.soft.gz'],
      ['miniml_family', 'GSE2553_family.xml.tgz'],
      ['series_matrix', 'GSE2553-GPL1977_series_matrix.txt.gz'],
      ['series_matrix', 'GSE2553-GPL2019_series_matrix.txt.gz'],
      ['supplementary_file', 'GSE2553_processed_data_file_1.xls.gz'],
      ['supplementary_file', 'GSE2553_processed_data_file_2.xls.gz']
    ]
  )
  assert.equal(geo.rows[0].geo2r_available, true)
  assert.equal(geo.rows[0].published_date, '2005/10/11')
  assert.equal(geo.provenance.attempts, 7)
  assert.equal(geo.provenance.transportName, 'mock-ncbi-geo')
})

test('Entrez adapter fetches NCBI BioProject XML details through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-bioproject',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'bioproject')
          assert.equal(input.searchParams.get('term'), 'PRJNA92161')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['92161']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'bioproject')
          assert.equal(input.searchParams.get('id'), '92161')
          assert.equal(input.searchParams.get('retmode'), 'xml')
          return new Response(
            `<?xml version="1.0" ?>
            <RecordSet>
              <DocumentSummary uid="92161">
                <Project>
                  <ProjectID>
                    <ArchiveID accession="PRJNA92161" archive="NCBI" id="92161"/>
                  </ProjectID>
                  <ProjectDescr>
                    <Name>Homo sapiens</Name>
                    <Title>NHGRI_Sarcoma_Baird</Title>
                    <Description>Sarcoma expression profiling project.</Description>
                    <ExternalLink label="">
                      <dbXREF db="GEO">
                        <ID>GSE2553</ID>
                      </dbXREF>
                    </ExternalLink>
                    <Publication date="2005-10-19T00:00:00Z" id="16230383" status="ePublished">
                      <Reference>16230383</Reference>
                      <DbType>ePubmed</DbType>
                    </Publication>
                    <ProjectReleaseDate>2005-10-11T00:00:00Z</ProjectReleaseDate>
                    <Relevance>
                      <Medical>Yes</Medical>
                    </Relevance>
                  </ProjectDescr>
                  <ProjectType>
                    <ProjectTypeSubmission>
                      <Target capture="eWhole" material="eTranscriptome" sample_scope="eMultiisolate">
                        <Organism species="9606" taxID="9606">
                          <OrganismName>Homo sapiens</OrganismName>
                          <Supergroup>eEukaryotes</Supergroup>
                        </Organism>
                      </Target>
                      <Method method_type="eArray"/>
                      <Objectives>
                        <Data data_type="eExpression"/>
                      </Objectives>
                      <ProjectDataTypeSet>
                        <DataType>Transcriptome or Gene expression</DataType>
                      </ProjectDataTypeSet>
                    </ProjectTypeSubmission>
                  </ProjectType>
                </Project>
                <Submission last_update="2013-01-17" submitted="2005-04-21" submission_id="SUB159169">
                  <Description>
                    <Organization role="owner" type="institute">
                      <Name>Genetics Branch, National Cancer Institute</Name>
                    </Organization>
                    <Access>public</Access>
                  </Description>
                  <Action action_id="SUB159169-1"/>
                </Submission>
              </DocumentSummary>
            </RecordSet>`,
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'bioproject')
        assert.equal(input.searchParams.get('id'), '92161')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['92161'],
              '92161': {
                uid: '92161',
                taxid: 9606,
                project_id: 92161,
                project_acc: 'PRJNA92161',
                project_type: 'Primary submission',
                project_data_type: 'Transcriptome or Gene expression',
                project_target_scope: 'Multiisolate',
                project_target_material: 'Transcriptome',
                project_target_capture: 'Whole',
                project_methodtype: 'Array',
                project_objectives_list: [{ project_objectivestype: 'Expression' }],
                registration_date: '2005/10/11 00:00',
                project_name: 'Homo sapiens',
                project_title: 'NHGRI_Sarcoma_Baird',
                project_description: 'Sarcoma expression profiling project.',
                relevance_medical: 'Yes',
                organism_name: 'Homo sapiens',
                sequencing_status: 'Unknown',
                submitter_organization: 'Genetics Branch, National Cancer Institute',
                supergroup: 'Eukaryotes'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const bioProject = await adapter.query({
    domain: 'bioproject',
    rawQuery: 'PRJNA92161',
    limit: 1
  })

  assert.equal(bioProject.rows[0].uid, '92161')
  assert.equal(bioProject.rows[0].accession, 'PRJNA92161')
  assert.equal(bioProject.rows[0].project_id, 92161)
  assert.equal(bioProject.rows[0].title, 'NHGRI_Sarcoma_Baird')
  assert.equal(bioProject.rows[0].name, 'Homo sapiens')
  assert.equal(bioProject.rows[0].description, 'Sarcoma expression profiling project.')
  assert.equal(bioProject.rows[0].organism, 'Homo sapiens')
  assert.equal(bioProject.rows[0].tax_id, 9606)
  assert.equal(bioProject.rows[0].project_type, 'Primary submission')
  assert.equal(bioProject.rows[0].data_type, 'Transcriptome or Gene expression')
  assert.equal(bioProject.rows[0].target_scope, 'Multiisolate')
  assert.equal(bioProject.rows[0].target_material, 'Transcriptome')
  assert.equal(bioProject.rows[0].target_capture, 'Whole')
  assert.equal(bioProject.rows[0].method_type, 'Array')
  assert.deepEqual(bioProject.rows[0].objectives, ['Expression'])
  assert.deepEqual(bioProject.rows[0].relevance, { medical: 'Yes' })
  assert.equal(
    bioProject.rows[0].submitter_organization,
    'Genetics Branch, National Cancer Institute'
  )
  assert.equal(bioProject.rows[0].registration_date, '2005/10/11 00:00')
  assert.equal(bioProject.rows[0].release_date, '2005-10-11T00:00:00Z')
  assert.equal(bioProject.rows[0].submitted_date, '2005-04-21')
  assert.equal(bioProject.rows[0].last_update, '2013-01-17')
  assert.equal(bioProject.rows[0].submission_id, 'SUB159169')
  assert.equal(bioProject.rows[0].access, 'public')
  assert.deepEqual(bioProject.rows[0].geo_accessions, ['GSE2553'])
  assert.deepEqual(bioProject.rows[0].pubmed_ids, ['16230383'])
  assert.equal(bioProject.rows[0].supergroup, 'Eukaryotes')
  assert.equal(bioProject.rows[0].sequencing_status, 'Unknown')
  assert.equal(bioProject.provenance.attempts, 3)
  assert.equal(bioProject.provenance.transportName, 'mock-ncbi-bioproject')
})

test('Entrez adapter fetches NCBI Taxonomy XML details through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-taxonomy',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'taxonomy')
          assert.equal(input.searchParams.get('term'), '9606[uid]')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['9606']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/efetch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'taxonomy')
          assert.equal(input.searchParams.get('id'), '9606')
          assert.equal(input.searchParams.get('retmode'), 'xml')
          return new Response(
            `<?xml version="1.0"?>
            <TaxaSet>
              <Taxon>
                <TaxId>9606</TaxId>
                <ScientificName>Homo sapiens</ScientificName>
                <OtherNames>
                  <GenbankCommonName>human</GenbankCommonName>
                  <Synonym>man</Synonym>
                  <EquivalentName>humans</EquivalentName>
                </OtherNames>
                <Rank>species</Rank>
                <Division>Mammals</Division>
                <Lineage>cellular organisms; Eukaryota; Metazoa; Chordata; Mammalia; Primates; Hominidae; Homo</Lineage>
                <LineageEx>
                  <Taxon>
                    <TaxId>9605</TaxId>
                    <ScientificName>Homo</ScientificName>
                    <Rank>genus</Rank>
                  </Taxon>
                </LineageEx>
                <ParentTaxId>9605</ParentTaxId>
                <GeneticCode>
                  <GCId>1</GCId>
                  <GCName>Standard</GCName>
                </GeneticCode>
                <MitoGeneticCode>
                  <GCId>2</GCId>
                  <GCName>Vertebrate Mitochondrial</GCName>
                </MitoGeneticCode>
              </Taxon>
            </TaxaSet>`,
            { status: 200 }
          )
        }
        assert.equal(input.pathname.endsWith('/esummary.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'taxonomy')
        assert.equal(input.searchParams.get('id'), '9606')
        return new Response(
          JSON.stringify({
            result: {
              uids: ['9606'],
              '9606': {
                uid: '9606',
                scientificname: 'Homo sapiens',
                commonname: 'human',
                rank: 'species',
                division: 'Primates',
                parentid: '9605'
              }
            }
          }),
          { status: 200 }
        )
      }
    }
  })

  const taxonomy = await adapter.query({
    domain: 'taxonomy',
    rawQuery: '9606[uid]',
    limit: 1
  })

  assert.equal(taxonomy.rows[0].uid, '9606')
  assert.equal(taxonomy.rows[0].tax_id, 9606)
  assert.equal(taxonomy.rows[0].scientific_name, 'Homo sapiens')
  assert.equal(taxonomy.rows[0].common_name, 'human')
  assert.equal(taxonomy.rows[0].rank, 'species')
  assert.equal(taxonomy.rows[0].division, 'Primates')
  assert.equal(taxonomy.rows[0].parent_tax_id, 9605)
  assert.deepEqual(taxonomy.rows[0].synonyms, ['man', 'humans'])
  assert.equal(
    taxonomy.rows[0].lineage,
    'cellular organisms; Eukaryota; Metazoa; Chordata; Mammalia; Primates; Hominidae; Homo'
  )
  assert.deepEqual(taxonomy.rows[0].genetic_code, { id: 1, name: 'Standard' })
  assert.deepEqual(taxonomy.rows[0].mitochondrial_genetic_code, {
    id: 2,
    name: 'Vertebrate Mitochondrial'
  })
  assert.equal(taxonomy.provenance.attempts, 3)
  assert.equal(taxonomy.provenance.transportName, 'mock-ncbi-taxonomy')
})

test('Entrez adapter normalizes PubMed abstracts and ClinVar efetch XML details', async () => {
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
          if (db === 'pubmed') {
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
                      <PublicationTypeList>
                        <PublicationType UI="D016428">Journal Article</PublicationType>
                        <PublicationType UI="D016454">Review</PublicationType>
                      </PublicationTypeList>
                    </Article>
                    <MeshHeadingList>
                      <MeshHeading>
                        <DescriptorName UI="D001943" MajorTopicYN="Y">Breast Neoplasms</DescriptorName>
                      </MeshHeading>
                      <MeshHeading>
                        <DescriptorName UI="D053842" MajorTopicYN="N">DNA Repair</DescriptorName>
                      </MeshHeading>
                    </MeshHeadingList>
                    <KeywordList>
                      <Keyword MajorTopicYN="N">BRCA1</Keyword>
                      <Keyword MajorTopicYN="N">DNA repair</Keyword>
                    </KeywordList>
                  </MedlineCitation>
                </PubmedArticle>
              </PubmedArticleSet>`,
              { status: 200 }
            )
          }
          assert.equal(db, 'clinvar')
          assert.equal(input.searchParams.get('id'), 'VCV000012345')
          return new Response(
            `<?xml version="1.0"?>
            <ClinVarResult-Set>
              <VariationArchive VariationID="12345" Accession="VCV000012345" Version="1" VariationType="Deletion">
                <ClassifiedRecord>
                  <Classifications>
                    <GermlineClassification DateLastEvaluated="2025-04-01">
                      <Description>Pathogenic</Description>
                      <ReviewStatus>criteria provided, multiple submitters, no conflicts</ReviewStatus>
                    </GermlineClassification>
                  </Classifications>
                  <SimpleAllele>
                    <MolecularConsequenceList>
                      <MolecularConsequence Type="frameshift variant"/>
                    </MolecularConsequenceList>
                  </SimpleAllele>
                  <TraitSet>
                    <Trait Type="Disease">
                      <Name>
                        <ElementValue Type="Preferred">Hereditary breast ovarian cancer syndrome</ElementValue>
                      </Name>
                    </Trait>
                  </TraitSet>
                </ClassifiedRecord>
              </VariationArchive>
            </ClinVarResult-Set>`,
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
  assert.deepEqual(pubmed.rows[0].mesh_terms, ['Breast Neoplasms', 'DNA Repair'])
  assert.deepEqual(pubmed.rows[0].keywords, ['BRCA1', 'DNA repair'])
  assert.deepEqual(pubmed.rows[0].publication_types, ['Journal Article', 'Review'])
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
  assert.deepEqual(clinvar.rows[0].condition, ['Hereditary breast ovarian cancer syndrome'])
  assert.equal(
    clinvar.rows[0].review_status,
    'criteria provided, multiple submitters, no conflicts'
  )
  assert.equal(clinvar.rows[0].last_evaluated, '2025-04-01')
  assert.deepEqual(clinvar.rows[0].molecular_consequence, ['frameshift variant'])
  assert.equal(clinvar.rows[0].variant_type, 'Deletion')
  assert.equal(clinvar.provenance.attempts, 3)
})

test('Entrez adapter fetches NCBI Protein FASTA sequences through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-protein',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'protein')
          assert.equal(input.searchParams.get('term'), 'BRCA1')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['4557601']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/esummary.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'protein')
          assert.equal(input.searchParams.get('id'), '4557601')
          return new Response(
            JSON.stringify({
              result: {
                uids: ['4557601'],
                '4557601': {
                  uid: '4557601',
                  accessionversion: 'NP_009225.1',
                  title: 'breast cancer type 1 susceptibility protein isoform 1',
                  taxname: 'Homo sapiens'
                }
              }
            }),
            { status: 200 }
          )
        }

        assert.equal(input.pathname.endsWith('/efetch.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'protein')
        assert.equal(input.searchParams.get('id'), '4557601')
        assert.equal(input.searchParams.get('rettype'), 'fasta')
        assert.equal(input.searchParams.get('retmode'), 'text')
        return new Response(
          `>NP_009225.1 breast cancer type 1 susceptibility protein isoform 1 [Homo sapiens]
MDLSALRVEEVQNVINAMQKILECPICLELIKE
PVSTKCDHIFCKFCMLKLLNQKKGPSQCPLCKNDITKRSLQ`,
          { status: 200 }
        )
      }
    }
  })

  const protein = await adapter.query({
    domain: 'protein',
    rawQuery: 'BRCA1',
    limit: 1
  })

  assert.equal(protein.rows[0].uid, '4557601')
  assert.equal(protein.rows[0].accession, 'NP_009225.1')
  assert.equal(protein.rows[0].title, 'breast cancer type 1 susceptibility protein isoform 1')
  assert.equal(protein.rows[0].organism, 'Homo sapiens')
  assert.equal(
    protein.rows[0].sequence,
    'MDLSALRVEEVQNVINAMQKILECPICLELIKEPVSTKCDHIFCKFCMLKLLNQKKGPSQCPLCKNDITKRSLQ'
  )
  assert.equal(protein.provenance.attempts, 3)
  assert.equal(protein.provenance.transportName, 'mock-ncbi-protein')
})

test('Entrez adapter fetches NCBI Nucleotide FASTA sequences through efetch', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/entrez/ncbi/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true)
  const manifest = parsed.manifest as DbConnectorManifest
  const adapter = new EntrezAdapter(manifest, {
    now: () => new Date('2026-09-17T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-ncbi-nucleotide',
      async fetch(input) {
        assert.equal(input.hostname, 'eutils.ncbi.nlm.nih.gov')
        if (input.pathname.endsWith('/esearch.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'nuccore')
          assert.equal(input.searchParams.get('term'), 'NM_007294.4')
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['555931']
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.endsWith('/esummary.fcgi')) {
          assert.equal(input.searchParams.get('db'), 'nuccore')
          assert.equal(input.searchParams.get('id'), '555931')
          return new Response(
            JSON.stringify({
              result: {
                uids: ['555931'],
                '555931': {
                  uid: '555931',
                  accessionversion: 'NM_007294.4',
                  title: 'Homo sapiens BRCA1 DNA repair associated (BRCA1), mRNA',
                  taxname: 'Homo sapiens',
                  slen: 7088,
                  biomol: 'mRNA'
                }
              }
            }),
            { status: 200 }
          )
        }

        assert.equal(input.pathname.endsWith('/efetch.fcgi'), true)
        assert.equal(input.searchParams.get('db'), 'nuccore')
        assert.equal(input.searchParams.get('id'), '555931')
        assert.equal(input.searchParams.get('rettype'), 'fasta')
        assert.equal(input.searchParams.get('retmode'), 'text')
        return new Response(
          `>NM_007294.4 Homo sapiens BRCA1 DNA repair associated (BRCA1), mRNA
ACAGCTGCTGGGCTCCATGGTGATGGCTGAA
CTCCCAGCACAGAAAATGGCAGCTCAGTGTT`,
          { status: 200 }
        )
      }
    }
  })

  const nucleotide = await adapter.query({
    domain: 'nucleotide',
    rawQuery: 'NM_007294.4',
    limit: 1
  })

  assert.equal(nucleotide.rows[0].uid, '555931')
  assert.equal(nucleotide.rows[0].accession, 'NM_007294.4')
  assert.equal(nucleotide.rows[0].title, 'Homo sapiens BRCA1 DNA repair associated (BRCA1), mRNA')
  assert.equal(nucleotide.rows[0].organism, 'Homo sapiens')
  assert.equal(nucleotide.rows[0].sequence_length, 7088)
  assert.equal(nucleotide.rows[0].molecule_type, 'mRNA')
  assert.equal(
    nucleotide.rows[0].sequence,
    'ACAGCTGCTGGGCTCCATGGTGATGGCTGAACTCCCAGCACAGAAAATGGCAGCTCAGTGTT'
  )
  assert.equal(nucleotide.provenance.attempts, 3)
  assert.equal(nucleotide.provenance.transportName, 'mock-ncbi-nucleotide')
})

test('db_query routes protein structure intent to UniProt protein fields, not ID mapping', async () => {
  await withHarness(async ({ agentDir }) => {
    let received: DbQueryParams | undefined
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
          rows: [
            {
              accession: 'Q92748',
              gene_name: 'THRSP',
              pdb_ids: [],
              alphafold_ids: ['Q92748']
            }
          ],
          truncated: false,
          provenance: {
            database: 'rest-json/uniprot',
            domain: params.domain,
            retrievedAt: '2026-09-20T00:00:00.000Z'
          }
        }
      }
    }
    const tool = buildDbQueryTool({ 'rest-json/uniprot': adapter }, agentDir)
    const result = await tool.execute(
      'call-thrsp-structure',
      {
        query: 'human THRSP protein structure PDB AlphaFold',
        fields: ['accession', 'gene_name', 'protein_name', 'pdb_ids', 'alphafold_ids'],
        limit: 1
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    const details = result.details as DbQueryToolDetails
    assert.equal(details.resolvedQuery?.database, 'rest-json/uniprot')
    assert.equal(details.resolvedQuery?.domain, 'protein')
    assert.deepEqual(details.resolvedQuery?.filters, [
      { field: 'gene_name', op: '=', value: 'THRSP' },
      { field: 'organism_id', op: '=', value: '9606' }
    ])
    assert.deepEqual(received, {
      domain: 'protein',
      filters: [
        { field: 'gene_name', op: '=', value: 'THRSP' },
        { field: 'organism_id', op: '=', value: '9606' }
      ],
      fields: ['accession', 'gene_name', 'protein_name', 'pdb_ids', 'alphafold_ids'],
      limit: 1,
      cursor: undefined,
      rawQuery: undefined
    })
  })
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
        received.push({ database: 'rest-json/uniprot', params })
        return {
          rows: [{ accession: 'P38398', gene_name: 'BRCA1' }],
          truncated: false,
          provenance: {
            database: 'rest-json/uniprot',
            domain: params.domain,
            retrievedAt: '2026-09-18T00:00:00.000Z'
          }
        }
      }
    }

    const tool = buildDbQueryTool(
      { 'entrez/ncbi': pubmedAdapter, 'rest-json/uniprot': uniprotAdapter },
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
    const sequence = await tool.execute(
      'call-infer-uniprot-sequence',
      { query: 'BRCA1 sequence', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiProtein = await tool.execute(
      'call-infer-ncbi-protein',
      { query: 'NCBI BRCA1 protein sequence', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiNucleotide = await tool.execute(
      'call-infer-ncbi-nucleotide',
      { query: 'NCBI NM_007294.4 nucleotide FASTA', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiBioSample = await tool.execute(
      'call-infer-ncbi-biosample',
      { query: 'NCBI BioSample SAMN00000001 sample metadata', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiSra = await tool.execute(
      'call-infer-ncbi-sra',
      { query: 'NCBI SRA SRX000001 sequencing run metadata', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiGeo = await tool.execute(
      'call-infer-ncbi-geo',
      { query: 'NCBI GEO GSE2553 expression profiling dataset', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiBioProject = await tool.execute(
      'call-infer-ncbi-bioproject',
      { query: 'NCBI BioProject PRJNA92161 project metadata', limit: 1 },
      undefined,
      fakeCtx()
    )
    const ncbiTaxonomy = await tool.execute(
      'call-infer-ncbi-taxonomy',
      { query: 'NCBI taxonomy taxid 9606', limit: 1 },
      undefined,
      fakeCtx()
    )
    const uniprotMapping = await tool.execute(
      'call-infer-uniprot-id-mapping',
      { query: 'Map UniProt P38398 to Ensembl', limit: 5 },
      undefined,
      fakeCtx()
    )

    assert.equal(pubmed.isError, undefined)
    assert.equal(uniprot.isError, undefined)
    assert.equal(sequence.isError, undefined)
    assert.equal(ncbiProtein.isError, undefined)
    assert.equal(ncbiNucleotide.isError, undefined)
    assert.equal(ncbiBioSample.isError, undefined)
    assert.equal(ncbiSra.isError, undefined)
    assert.equal(ncbiGeo.isError, undefined)
    assert.equal(ncbiBioProject.isError, undefined)
    assert.equal(ncbiTaxonomy.isError, undefined)
    assert.equal(uniprotMapping.isError, undefined)
    const pubmedDetails = pubmed.details as DbQueryToolDetails
    const uniprotDetails = uniprot.details as DbQueryToolDetails
    const sequenceDetails = sequence.details as DbQueryToolDetails
    const ncbiProteinDetails = ncbiProtein.details as DbQueryToolDetails
    const ncbiNucleotideDetails = ncbiNucleotide.details as DbQueryToolDetails
    const ncbiBioSampleDetails = ncbiBioSample.details as DbQueryToolDetails
    const ncbiSraDetails = ncbiSra.details as DbQueryToolDetails
    const ncbiGeoDetails = ncbiGeo.details as DbQueryToolDetails
    const ncbiBioProjectDetails = ncbiBioProject.details as DbQueryToolDetails
    const ncbiTaxonomyDetails = ncbiTaxonomy.details as DbQueryToolDetails
    const uniprotMappingDetails = uniprotMapping.details as DbQueryToolDetails
    assert.equal(pubmedDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(pubmedDetails.resolvedQuery?.domain, 'pubmed')
    assert.equal(pubmedDetails.resolvedQuery?.rawQuery, 'PubMed BRCA1 DNA repair abstract')
    assert.equal(pubmedDetails.resolvedQuery?.predicateSource, 'heuristic')
    assert.equal(uniprotDetails.resolvedQuery?.database, 'rest-json/uniprot')
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
      database: 'rest-json/uniprot',
      params: {
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
        fields: undefined,
        limit: 2,
        cursor: undefined,
        rawQuery: undefined
      }
    })
    assert.equal(sequenceDetails.resolvedQuery?.database, 'rest-json/uniprot')
    assert.equal(sequenceDetails.resolvedQuery?.domain, 'protein')
    assert.deepEqual(sequenceDetails.resolvedQuery?.filters, [
      { field: 'gene_name', op: '=', value: 'BRCA1' }
    ])
    assert.deepEqual(received[2], {
      database: 'rest-json/uniprot',
      params: {
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: undefined
      }
    })
    assert.equal(ncbiProteinDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiProteinDetails.resolvedQuery?.domain, 'protein')
    assert.equal(ncbiProteinDetails.resolvedQuery?.rawQuery, 'BRCA1')
    assert.deepEqual(received[3], {
      database: 'entrez/ncbi',
      params: {
        domain: 'protein',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'BRCA1'
      }
    })
    assert.equal(ncbiNucleotideDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiNucleotideDetails.resolvedQuery?.domain, 'nucleotide')
    assert.equal(ncbiNucleotideDetails.resolvedQuery?.rawQuery, 'NM_007294.4')
    assert.deepEqual(received[4], {
      database: 'entrez/ncbi',
      params: {
        domain: 'nucleotide',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'NM_007294.4'
      }
    })
    assert.equal(ncbiBioSampleDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiBioSampleDetails.resolvedQuery?.domain, 'biosample')
    assert.equal(ncbiBioSampleDetails.resolvedQuery?.rawQuery, 'SAMN00000001')
    assert.deepEqual(received[5], {
      database: 'entrez/ncbi',
      params: {
        domain: 'biosample',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'SAMN00000001'
      }
    })
    assert.equal(ncbiSraDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiSraDetails.resolvedQuery?.domain, 'sra')
    assert.equal(ncbiSraDetails.resolvedQuery?.rawQuery, 'SRX000001')
    assert.deepEqual(received[6], {
      database: 'entrez/ncbi',
      params: {
        domain: 'sra',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'SRX000001'
      }
    })
    assert.equal(ncbiGeoDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiGeoDetails.resolvedQuery?.domain, 'geo')
    assert.equal(ncbiGeoDetails.resolvedQuery?.rawQuery, 'GSE2553')
    assert.deepEqual(received[7], {
      database: 'entrez/ncbi',
      params: {
        domain: 'geo',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'GSE2553'
      }
    })
    assert.equal(ncbiBioProjectDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiBioProjectDetails.resolvedQuery?.domain, 'bioproject')
    assert.equal(ncbiBioProjectDetails.resolvedQuery?.rawQuery, 'PRJNA92161')
    assert.deepEqual(received[8], {
      database: 'entrez/ncbi',
      params: {
        domain: 'bioproject',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: 'PRJNA92161'
      }
    })
    assert.equal(ncbiTaxonomyDetails.resolvedQuery?.database, 'entrez/ncbi')
    assert.equal(ncbiTaxonomyDetails.resolvedQuery?.domain, 'taxonomy')
    assert.equal(ncbiTaxonomyDetails.resolvedQuery?.rawQuery, '9606[uid]')
    assert.deepEqual(received[9], {
      database: 'entrez/ncbi',
      params: {
        domain: 'taxonomy',
        filters: undefined,
        fields: undefined,
        limit: 1,
        cursor: undefined,
        rawQuery: '9606[uid]'
      }
    })
    assert.equal(uniprotMappingDetails.resolvedQuery?.database, 'rest-json/uniprot')
    assert.equal(uniprotMappingDetails.resolvedQuery?.domain, 'id_mapping')
    assert.deepEqual(uniprotMappingDetails.resolvedQuery?.filters, [
      { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
      { field: 'to', op: '=', value: 'Ensembl' },
      { field: 'ids', op: 'in', value: ['P38398'] }
    ])
    assert.deepEqual(received[10], {
      database: 'rest-json/uniprot',
      params: {
        domain: 'id_mapping',
        filters: [
          { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
          { field: 'to', op: '=', value: 'Ensembl' },
          { field: 'ids', op: 'in', value: ['P38398'] }
        ],
        fields: undefined,
        limit: 5,
        cursor: undefined,
        rawQuery: undefined
      }
    })
  })
})

test('db_query routes core Ensembl identifier, sequence, variation, and VEP intents', async () => {
  await withHarness(async ({ agentDir }) => {
    const received: unknown[] = []
    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        received.push(params)
        return {
          rows: [{ ok: true }],
          truncated: false,
          provenance: {
            database: 'rest-json/ensembl',
            domain: params.domain,
            retrievedAt: '2026-09-19T00:00:00.000Z'
          }
        }
      }
    }
    const tool = buildDbQueryTool({ 'rest-json/ensembl': adapter }, agentDir)

    const lookup = await tool.execute(
      'call-ensembl-lookup',
      { query: 'Ensembl lookup ENSG00000012048' },
      undefined,
      fakeCtx()
    )
    const sequence = await tool.execute(
      'call-ensembl-sequence',
      { query: 'Ensembl sequence for ENSG00000012048' },
      undefined,
      fakeCtx()
    )
    const variation = await tool.execute(
      'call-ensembl-variation',
      { query: 'Ensembl variation details for rs699' },
      undefined,
      fakeCtx()
    )
    const vep = await tool.execute(
      'call-ensembl-vep',
      { query: 'Ensembl VEP consequences for rs699' },
      undefined,
      fakeCtx()
    )

    assert.equal((lookup.details as DbQueryToolDetails).resolvedQuery?.domain, 'lookup_id')
    assert.equal((sequence.details as DbQueryToolDetails).resolvedQuery?.domain, 'sequence_id')
    assert.equal((variation.details as DbQueryToolDetails).resolvedQuery?.domain, 'variation')
    assert.equal((vep.details as DbQueryToolDetails).resolvedQuery?.domain, 'vep_id')
    assert.deepEqual(received, [
      {
        domain: 'lookup_id',
        filters: [{ field: 'id', op: '=', value: 'ENSG00000012048' }],
        fields: undefined,
        limit: 50,
        cursor: undefined,
        rawQuery: undefined
      },
      {
        domain: 'sequence_id',
        filters: [{ field: 'id', op: '=', value: 'ENSG00000012048' }],
        fields: undefined,
        limit: 50,
        cursor: undefined,
        rawQuery: undefined
      },
      {
        domain: 'variation',
        filters: [
          { field: 'species', op: '=', value: 'homo_sapiens' },
          { field: 'id', op: '=', value: 'rs699' }
        ],
        fields: undefined,
        limit: 50,
        cursor: undefined,
        rawQuery: undefined
      },
      {
        domain: 'vep_id',
        filters: [
          { field: 'species', op: '=', value: 'homo_sapiens' },
          { field: 'id', op: '=', value: 'rs699' }
        ],
        fields: undefined,
        limit: 50,
        cursor: undefined,
        rawQuery: undefined
      }
    ])
  })
})

test('db_query fetches bounded pages and aggregates provenance', async () => {
  await withHarness(async ({ agentDir }) => {
    const cursors: Array<string | undefined> = []
    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        cursors.push(params.cursor)
        const page = params.cursor === undefined ? 0 : Number(params.cursor) / 2
        const rows =
          page === 0
            ? [{ uid: '1' }, { uid: '2' }]
            : page === 1
              ? [{ uid: '3' }, { uid: '4' }]
              : [{ uid: '5' }]
        const nextCursor = page < 2 ? String((page + 1) * 2) : undefined
        return {
          rows,
          totalRows: 5,
          truncated: Boolean(nextCursor),
          ...(nextCursor ? { nextCursor } : {}),
          provenance: {
            database: 'entrez/ncbi',
            domain: params.domain,
            retrievedAt: `2026-09-20T00:00:0${page}.000Z`,
            attempts: page === 1 ? 2 : 1,
            retried: page === 1,
            lastStatus: 200,
            transportName: 'mock-paged',
            defaultProxyMode: 'disabled'
          }
        }
      }
    }

    const tool = buildDbQueryTool({ 'entrez/ncbi': adapter }, agentDir)
    const bounded = await tool.execute(
      'call-paged-bounded',
      {
        database: 'entrez/ncbi',
        domain: 'gene',
        rawQuery: 'BRCA1',
        limit: 2,
        maxPages: 2
      },
      undefined,
      fakeCtx()
    )
    assert.equal(bounded.isError, undefined)
    const boundedDetails = bounded.details as DbQueryToolDetails
    assert.equal(boundedDetails.mode, 'inline')
    if (boundedDetails.mode !== 'inline') assert.fail('expected inline DB result')
    assert.equal(boundedDetails.summary.returnedRows, 4)
    assert.equal(boundedDetails.summary.truncated, true)
    assert.equal(boundedDetails.summary.nextCursor, '4')
    assert.equal(boundedDetails.provenance.pagesFetched, 2)
    assert.deepEqual(cursors, [undefined, '2'])

    cursors.length = 0
    const result = await tool.execute(
      'call-paged',
      {
        database: 'entrez/ncbi',
        domain: 'gene',
        rawQuery: 'BRCA1',
        limit: 2,
        maxPages: 3
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    const details = result.details as DbQueryToolDetails
    assert.equal(details.mode, 'inline')
    if (details.mode !== 'inline') assert.fail('expected inline DB result')
    assert.deepEqual(details.rows, [
      { uid: '1' },
      { uid: '2' },
      { uid: '3' },
      { uid: '4' },
      { uid: '5' }
    ])
    assert.deepEqual(cursors, [undefined, '2', '4'])
    assert.equal(details.summary.returnedRows, 5)
    assert.equal(details.summary.truncated, false)
    assert.equal(details.provenance.attempts, 4)
    assert.equal(details.provenance.retried, true)
    assert.equal(details.provenance.pagesFetched, 3)
  })
})

test('db_query stops when an adapter repeats a pagination cursor', async () => {
  await withHarness(async ({ agentDir }) => {
    let calls = 0
    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        calls += 1
        return {
          rows: [{ uid: String(calls) }],
          truncated: true,
          nextCursor: params.cursor ?? 'same',
          provenance: {
            database: 'entrez/ncbi',
            domain: params.domain,
            retrievedAt: '2026-09-20T00:00:00.000Z'
          }
        }
      }
    }

    const result = await buildDbQueryTool({ 'entrez/ncbi': adapter }, agentDir).execute(
      'call-repeated-cursor',
      {
        database: 'entrez/ncbi',
        domain: 'gene',
        rawQuery: 'BRCA1',
        limit: 1,
        maxPages: 3
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, true)
    assert.match(result.content[0]?.text ?? '', /repeated pagination cursor/)
    assert.equal(calls, 2)
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
            if (input.pathname.endsWith('/efetch.fcgi')) {
              assert.equal(input.searchParams.get('db'), 'gene')
              assert.equal(input.searchParams.get('id'), '91001,91002')
              assert.equal(input.searchParams.get('retmode'), 'xml')
              return new Response(
                `<?xml version="1.0"?>
                <Entrezgene-Set>
                  <Entrezgene>
                    <Entrezgene_track-info>
                      <Gene-track>
                        <Gene-track_geneid>91001</Gene-track_geneid>
                      </Gene-track>
                    </Entrezgene_track-info>
                    <Entrezgene_gene>
                      <Gene-ref>
                        <Gene-ref_locus>BRCA1</Gene-ref_locus>
                      </Gene-ref>
                    </Entrezgene_gene>
                    <Entrezgene_summary>BRCA1 participates in DNA repair.</Entrezgene_summary>
                  </Entrezgene>
                  <Entrezgene>
                    <Entrezgene_track-info>
                      <Gene-track>
                        <Gene-track_geneid>91002</Gene-track_geneid>
                      </Gene-track>
                    </Entrezgene_track-info>
                    <Entrezgene_gene>
                      <Gene-ref>
                        <Gene-ref_locus>BRCA2</Gene-ref_locus>
                      </Gene-ref>
                    </Entrezgene_gene>
                    <Entrezgene_summary>BRCA2 participates in DNA repair.</Entrezgene_summary>
                  </Entrezgene>
                </Entrezgene-Set>`,
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
        ['db_resolve', 'read'],
        ['db_routes', 'read'],
        ['db_domain', 'read'],
        ['db_query', 'read'],
        ['db_download', 'read'],
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
    assert.equal(calls, 3)
    const details = result.details as {
      mode: string
      rows?: Array<Record<string, unknown>>
      provenance?: { transportName?: string }
    }
    assert.equal(details.mode, 'inline')
    assert.equal(details.rows?.[0]?.symbol, 'BRCA1')
    assert.equal(details.rows?.[0]?.summary, 'BRCA1 participates in DNA repair.')
    assert.equal(details.rows?.[1]?.symbol, 'BRCA2')
    assert.equal(details.rows?.[1]?.summary, 'BRCA2 participates in DNA repair.')
    assert.equal(details.provenance?.transportName, 'mock-default-entrez')
  })
})

test('default DB custom tools register bundled UniProt REST and query through the adapter', async () => {
  await withHarness(async ({ agentDir }) => {
    let calls = 0
    const tools = buildDefaultDbCustomTools(agentDir, {
      restJson: {
        now: () => new Date('2026-09-18T00:00:00.000Z'),
        sleep: async () => {},
        transport: {
          name: 'mock-default-uniprot-rest',
          async fetch(input) {
            calls += 1
            assert.equal(input.hostname, 'rest.uniprot.org')
            assert.equal(input.pathname, '/uniprotkb/search')
            assert.equal(input.searchParams.get('query'), 'gene_exact:BRCA1')
            return new Response(
              JSON.stringify({
                results: [
                  {
                    primaryAccession: 'P38398',
                    uniProtkbId: 'BRCA1_HUMAN',
                    entryType: 'UniProtKB reviewed (Swiss-Prot)',
                    proteinDescription: {
                      recommendedName: {
                        fullName: { value: 'Breast cancer type 1 susceptibility protein' }
                      }
                    },
                    genes: [{ geneName: { value: 'BRCA1' } }],
                    organism: { scientificName: 'Homo sapiens', taxonId: 9606 },
                    sequence: {
                      value: 'MDLSALRVEEVQNVINAMQKILECPICLELIKE',
                      length: 1863,
                      molWeight: 207721
                    }
                  }
                ]
              }),
              {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'x-total-results': '1',
                  'x-uniprot-release': '2026_04'
                }
              }
            )
          }
        }
      }
    })

    const query = tools.find((tool) => tool.name === 'db_query')
    assert.ok(query)
    const result = await query.execute(
      'call-default-uniprot',
      {
        database: 'rest-json/uniprot',
        domain: 'protein',
        filters: [{ field: 'gene_name', op: '=', value: 'BRCA1' }],
        limit: 1
      },
      undefined,
      fakeCtx()
    )

    assert.equal(result.isError, undefined)
    assert.equal(calls, 1)
    const details = result.details as {
      mode: string
      downloadManifestArtifact?: { path: string; format: string }
      downloadManifestSummary?: {
        rowCount: number
        candidateCount: number
        directUrlCount: number
        landingPageCount: number
        directoryCount: number
        candidateFileCount: number
        formats: string[]
        kinds: string[]
      }
      rows?: Array<Record<string, unknown>>
      provenance?: { database?: string; sourceVersion?: string; transportName?: string }
    }
    assert.equal(details.mode, 'inline')
    assert.equal(details.provenance?.database, 'rest-json/uniprot')
    assert.equal(details.provenance?.sourceVersion, '2026_04')
    assert.equal(details.provenance?.transportName, 'mock-default-uniprot-rest')
    assert.equal(details.rows?.[0]?.accession, 'P38398')
    assert.equal(details.rows?.[0]?.entry_name, 'BRCA1_HUMAN')
    assert.equal(details.rows?.[0]?.reviewed, true)
    assert.equal(details.rows?.[0]?.protein_name, 'Breast cancer type 1 susceptibility protein')
    assert.equal(details.rows?.[0]?.gene_name, 'BRCA1')
    assert.equal(details.rows?.[0]?.url, 'https://www.uniprot.org/uniprotkb/P38398/entry')
    assert.equal(
      (details.rows?.[0]?.download_urls as { fasta?: string } | undefined)?.fasta,
      'https://rest.uniprot.org/uniprotkb/P38398.fasta'
    )
    assert.equal(details.downloadManifestArtifact?.format, 'download_manifest_json')
    assert.deepEqual(details.downloadManifestSummary, {
      rowCount: 1,
      candidateCount: 3,
      directUrlCount: 3,
      landingPageCount: 0,
      directoryCount: 0,
      candidateFileCount: 0,
      formats: ['fasta', 'json', 'txt'],
      kinds: ['uniprot_fasta', 'uniprot_json', 'uniprot_txt']
    })
    assert.equal(existsSync(details.downloadManifestArtifact?.path ?? ''), true)
    const manifest = JSON.parse(
      readFileSync(details.downloadManifestArtifact?.path ?? '', 'utf-8')
    ) as {
      rows: Array<{
        download_files: Array<{ accession: string; kind: string; url: string }>
      }>
    }
    assert.equal(manifest.rows[0]?.download_files[1]?.kind, 'uniprot_fasta')
    assert.equal(
      manifest.rows[0]?.download_files[1]?.url,
      'https://rest.uniprot.org/uniprotkb/P38398.fasta'
    )
  })
})

test('bundled catalog includes Phase 1 expansion connectors and default adapters', async () => {
  await withHarness(({ agentDir }) => {
    const expectedIds = [
      'entrez/ncbi',
      'ontology/chebi',
      'ontology/doid',
      'ontology/go',
      'ontology/hpo',
      'ontology/mesh',
      'rest-json/alphafold',
      'rest-json/bindingdb',
      'rest-json/biogrid',
      'rest-json/cbioportal',
      'rest-json/chembl',
      'rest-json/clinicaltrials',
      'rest-json/clinpgx',
      'rest-json/ensembl',
      'rest-json/europepmc',
      'rest-json/gdc',
      'rest-json/gnomad',
      'rest-json/gtex',
      'rest-json/gwas-catalog',
      'rest-json/hpa',
      'rest-json/interpro',
      'rest-json/jaspar',
      'rest-json/kegg',
      'rest-json/monarch',
      'rest-json/mygene',
      'rest-json/myvariant',
      'rest-json/omnipath',
      'rest-json/openfda',
      'rest-json/opentargets',
      'rest-json/pdbe',
      'rest-json/pubchem',
      'rest-json/reactome',
      'rest-json/string',
      'rest-json/uniprot',
      'rest-json/zinc',
      'sparql/uniprot',
      'sparql/wikipathways'
    ]
    const catalog = listDbConnectorCatalog(agentDir)
    const ids = catalog.map((entry) => entry.manifest.id).sort()
    for (const id of expectedIds) {
      assert.ok(ids.includes(id), `missing bundled connector ${id}`)
      const entry = catalog.find((candidate) => candidate.manifest.id === id)
      assert.equal(entry?.trustTier, 'bundled')
      assert.equal(entry?.enabledForQuery, true)
      assert.ok((entry?.manifest.domains.length ?? 0) > 0)
    }

    const adapters = buildDefaultDbAdapters(agentDir)
    for (const id of expectedIds) {
      assert.ok(adapters[id], `missing default adapter for ${id}`)
    }
    assert.equal(adapters['rest-json/cbioportal']?.constructor.name, 'RestJsonAdapter')
    assert.equal(adapters['sparql/wikipathways']?.constructor.name, 'SparqlAdapter')
    assert.equal(adapters['rest-json/uniprot']?.constructor.name, 'UniProtAdapter')
    assert.equal(adapters['ontology/go']?.constructor.name, 'OntologyAdapter')
    assert.equal(adapters['rest-json/kegg']?.constructor.name, 'KeggAdapter')

    const docs = buildGeneratedDbConnectorDocs(catalog, new Date('2026-09-20T00:00:00.000Z'))
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/cbioportal/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/pdbe/)
    assert.match(docs.navigatorSkillMarkdown, /ontology\/go/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/kegg/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/opentargets/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/gnomad/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/biogrid/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/monarch/)
    assert.match(docs.navigatorSkillMarkdown, /rest-json\/clinicaltrials/)
    assert.match(docs.navigatorSkillMarkdown, /ontology\/chebi/)
    assert.match(docs.navigatorSkillMarkdown, /Recommended Entity Query Paths/)
    assert.match(docs.navigatorSkillMarkdown, /Ensembl Navigation/)
    assert.match(docs.navigatorSkillMarkdown, /drug_label_by_name/)
    assert.match(
      docs.navigatorSkillMarkdown,
      /Pathway\/Interaction|Cancer\/Expression|Compound\/Drug|Ontology|Variation\/Clinical/
    )
    assert.match(docs.navigatorSkillMarkdown, /sparql\/wikipathways\/pathway_by_gene/)
  })
})

test('KEGG parser structures Biopython-style flat files and find list rows', () => {
  const geneText = [
    'ENTRY       hsa:7157            CDS       T01001',
    'NAME        TP53, BCC7, LFS1, P53, TRP53',
    'DEFINITION  tumor protein p53',
    'ORTHOLOGY   K04451  Tumor protein p53',
    'ORGANISM    hsa  Homo sapiens (human)',
    'PATHWAY     hsa04110  Cell cycle',
    '            hsa04115  p53 signaling pathway',
    'DBLINKS     NCBI-GeneID: 7157',
    '            UniProt: P04637',
    '///'
  ].join('\n')
  const [gene] = parseKeggFlatRecords(geneText).map(normalizeKeggGeneRow)
  assert.equal(gene.entry, 'hsa:7157')
  assert.equal(gene.gene_symbol, 'TP53')
  assert.deepEqual(gene.aliases, ['BCC7', 'LFS1', 'P53', 'TRP53'])
  assert.equal(gene.definition, 'tumor protein p53')
  assert.deepEqual(gene.orthology_ids, ['K04451'])
  assert.equal(gene.organism_id, 'hsa')
  assert.deepEqual(gene.pathway_ids, ['hsa04110', 'hsa04115'])
  assert.deepEqual(gene.dblinks, [
    { database: 'NCBI-GeneID', ids: ['7157'] },
    { database: 'UniProt', ids: ['P04637'] }
  ])

  const compoundText = [
    'ENTRY       C00002                      Compound',
    'NAME        ATP;',
    "            Adenosine 5'-triphosphate",
    'FORMULA     C10H16N5O13P3',
    'EXACT_MASS  506.9957',
    'PATHWAY     map00230  Purine metabolism',
    'ENZYME      2.7.1.25        2.7.4.1',
    '///'
  ].join('\n')
  const [compound] = parseKeggFlatRecords(compoundText).map(normalizeKeggCompoundRow)
  assert.equal(compound.entry, 'C00002')
  assert.equal(compound.preferred_name, 'ATP')
  assert.deepEqual(compound.name, ['ATP', "Adenosine 5'-triphosphate"])
  assert.equal(compound.formula, 'C10H16N5O13P3')
  assert.equal(compound.exact_mass, '506.9957')
  assert.deepEqual(compound.pathway_ids, ['map00230'])

  const findRows = keggListRowsToRecords(
    parseKeggListText('hsa:7157\tTP53, P53; tumor protein p53\nhsa:7158\tOTHER; other gene\n')
  )
  assert.equal(findRows[0]?.id, 'hsa:7157')
  assert.equal(findRows[0]?.gene_symbol, 'TP53')
  assert.deepEqual(findRows[0]?.aliases, ['P53'])
  assert.equal(findRows[0]?.definition, 'tumor protein p53')
})

test('KEGG adapter queries find and get endpoints with structured parsing', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/rest-json/kegg/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const adapter = new KeggAdapter(parsed.manifest as DbConnectorManifest, {
    transport: {
      name: 'mock-kegg',
      async fetch(input) {
        if (input.pathname.includes('/find/genes/')) {
          return new Response('hsa:7157\tTP53, P53; tumor protein p53\n', { status: 200 })
        }
        if (input.pathname.includes('/get/hsa:7157')) {
          return new Response(
            [
              'ENTRY       hsa:7157            CDS       T01001',
              'NAME        TP53',
              'DEFINITION  tumor protein p53',
              'PATHWAY     hsa04115  p53 signaling pathway',
              '///'
            ].join('\n'),
            { status: 200 }
          )
        }
        return new Response(`missing ${input.pathname}`, { status: 404 })
      }
    }
  })

  assert.equal(
    buildKeggRequestPath(parsed.manifest!.domains[0], {
      domain: 'find_genes',
      filters: [{ field: 'query', op: '=', value: 'TP53' }],
      limit: 10
    }),
    '/find/genes/TP53'
  )

  const found = await adapter.query({
    domain: 'find_genes',
    filters: [{ field: 'query', op: '=', value: 'TP53' }],
    limit: 10
  })
  assert.equal(found.rows[0]?.id, 'hsa:7157')
  assert.equal(found.rows[0]?.gene_symbol, 'TP53')

  const gene = await adapter.query({
    domain: 'gene',
    filters: [{ field: 'entry', op: '=', value: 'hsa:7157' }],
    limit: 5
  })
  assert.equal(gene.rows[0]?.entry, 'hsa:7157')
  assert.equal(gene.rows[0]?.definition, 'tumor protein p53')
  assert.deepEqual(gene.rows[0]?.pathway_ids, ['hsa04115'])
})

test('ontology adapter looks up and searches OLS terms with mock transport', async () => {
  const parsed = parseDbConnectorManifest(
    readFileSync('resources/db-connectors/ontology/go/connector.yaml', 'utf-8')
  )
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  const adapter = new OntologyAdapter(parsed.manifest as DbConnectorManifest, {
    transport: {
      name: 'mock-ontology-go',
      async fetch(input) {
        if (input.pathname.endsWith('/search') || input.pathname.includes('/search')) {
          return new Response(
            JSON.stringify({
              response: {
                numFound: 1,
                docs: [
                  {
                    obo_id: 'GO:0006915',
                    iri: 'http://purl.obolibrary.org/obo/GO_0006915',
                    label: 'apoptotic process',
                    description: ['A programmed cell death process.'],
                    ontology_name: 'go'
                  }
                ]
              }
            }),
            { status: 200 }
          )
        }
        if (input.pathname.includes('/terms/')) {
          return new Response(
            JSON.stringify({
              obo_id: 'GO:0006915',
              iri: 'http://purl.obolibrary.org/obo/GO_0006915',
              label: 'apoptotic process',
              description: ['A programmed cell death process.'],
              synonym: ['apoptosis'],
              ontology_name: 'go'
            }),
            { status: 200 }
          )
        }
        return new Response('not found', { status: 404 })
      }
    }
  })

  const lookup = await adapter.query({
    domain: 'term',
    filters: [{ field: 'id', op: '=', value: 'GO:0006915' }],
    limit: 5
  })
  assert.equal(lookup.rows[0]?.obo_id, 'GO:0006915')
  assert.equal(lookup.rows[0]?.label, 'apoptotic process')
  assert.equal(lookup.provenance.database, 'ontology/go')

  const search = await adapter.query({
    domain: 'search',
    filters: [{ field: 'q', op: '=', value: 'apoptosis' }],
    limit: 5
  })
  assert.equal(search.totalRows, 1)
  assert.equal(search.rows[0]?.obo_id, 'GO:0006915')
})

test('catalog applies per-database query toggles to bundled connectors', async () => {
  await withHarness(async ({ agentDir }) => {
    const initial = listDbConnectorCatalog(agentDir).find(
      (entry) => entry.manifest.id === 'entrez/ncbi'
    )
    assert.ok(initial)
    assert.equal(initial.enabledForQuery, true)

    setDbConnectorQueryEnabled(
      initial.manifest.id,
      initial.digest,
      initial.trustTier,
      false,
      agentDir
    )
    const disabled = listDbConnectorCatalog(agentDir).find(
      (entry) => entry.manifest.id === 'entrez/ncbi'
    )
    assert.equal(disabled?.enabledForQuery, false)

    setDbConnectorQueryEnabled(
      initial.manifest.id,
      initial.digest,
      initial.trustTier,
      true,
      agentDir
    )
    const enabled = listDbConnectorCatalog(agentDir).find(
      (entry) => entry.manifest.id === 'entrez/ncbi'
    )
    assert.equal(enabled?.enabledForQuery, true)
  })
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

test('default DB tools create the selected adapter only when it is queried', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const tools = buildDefaultDbCustomTools(agentDir, {
      restJson: {
        transport: {
          name: 'lazy-rest-json',
          async fetch() {
            return new Response(JSON.stringify({ data: [{ symbol: 'TP53' }] }), { status: 200 })
          }
        }
      }
    })
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    const entry = addCustomDbConnector(sourceDir, agentDir)
    allowCustomDbConnector(entry.manifest.id, entry.digest, agentDir)
    const query = tools.find((tool) => tool.name === 'db_query')
    assert.ok(query)
    const result = await query.execute(
      'lazy-selected-query',
      {
        database: 'rest-json/toy',
        domain: 'gene',
        filters: [{ field: 'symbol', op: '=', value: 'TP53' }],
        limit: 1
      },
      undefined,
      fakeCtx()
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]?.text ?? '', /TP53/)
  })
})

test('Database session requires function discovery and inspection before an ordinary query', async () => {
  await withHarness(async ({ root, agentDir }) => {
    const sourceDir = join(root, 'connector-src')
    writeConnector(sourceDir)
    const entry = addCustomDbConnector(sourceDir, agentDir)
    allowCustomDbConnector(entry.manifest.id, entry.digest, agentDir)
    const tools = buildDefaultDbCustomTools(
      agentDir,
      {
        restJson: {
          transport: {
            name: 'staged-query',
            async fetch() {
              return new Response(JSON.stringify({ data: [{ symbol: 'TP53' }] }), { status: 200 })
            }
          }
        }
      },
      { enforceRouting: true }
    )
    const query = tools.find((tool) => tool.name === 'db_query')!
    const routes = tools.find((tool) => tool.name === 'db_routes')!
    const domain = tools.find((tool) => tool.name === 'db_domain')!
    const args = {
      database: 'rest-json/toy',
      domain: 'gene',
      filters: [{ field: 'symbol', op: '=', value: 'TP53' }]
    }

    const beforeRoutes = await query.execute('before-routes', args, undefined, fakeCtx())
    assert.equal(beforeRoutes.isError, true)
    assert.match(beforeRoutes.content[0]?.text ?? '', /db_routes/)

    await routes.execute(
      'select-gene-route',
      { database: 'rest-json/toy', intent: 'gene symbol' },
      undefined,
      fakeCtx()
    )
    const beforeDomain = await query.execute('before-domain', args, undefined, fakeCtx())
    assert.equal(beforeDomain.isError, true)
    assert.match(beforeDomain.content[0]?.text ?? '', /db_domain/)

    await domain.execute(
      'inspect-gene-route',
      { database: 'rest-json/toy', domain: 'gene' },
      undefined,
      fakeCtx()
    )
    const afterDomain = await query.execute('after-domain', args, undefined, fakeCtx())
    assert.equal(afterDomain.isError, undefined)
    assert.match(afterDomain.content[0]?.text ?? '', /TP53/)
  })
})

test('selected database functions can be inspected and queried in parallel', async () => {
  await withHarness(async ({ agentDir }) => {
    const adapterFor = (database: string): DbAdapter => ({
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        return {
          rows: [{ source: database }],
          truncated: false,
          provenance: { database, domain: params.domain, retrievedAt: '2026-09-28T00:00:00.000Z' }
        }
      }
    })
    const tools = buildDbCustomTools(
      {
        'entrez/ncbi': adapterFor('entrez/ncbi'),
        'rest-json/uniprot': adapterFor('rest-json/uniprot')
      },
      agentDir,
      { enforceRouting: true }
    )
    const routes = tools.find((tool) => tool.name === 'db_routes')!
    const domain = tools.find((tool) => tool.name === 'db_domain')!
    const query = tools.find((tool) => tool.name === 'db_query')!
    await Promise.all([
      routes.execute(
        'ncbi-routes',
        { database: 'entrez/ncbi', intent: 'gene symbol' },
        undefined,
        fakeCtx()
      ),
      routes.execute(
        'uniprot-routes',
        { database: 'rest-json/uniprot', intent: 'protein accession' },
        undefined,
        fakeCtx()
      )
    ])
    const inspections = await Promise.all([
      domain.execute(
        'ncbi-domain',
        { database: 'entrez/ncbi', domain: 'gene' },
        undefined,
        fakeCtx()
      ),
      domain.execute(
        'uniprot-domain',
        { database: 'rest-json/uniprot', domain: 'protein' },
        undefined,
        fakeCtx()
      )
    ])
    assert.ok(inspections.every((result) => !result.isError))
    const results = await Promise.all([
      query.execute(
        'ncbi-query',
        { database: 'entrez/ncbi', domain: 'gene', rawQuery: 'TP53' },
        undefined,
        fakeCtx()
      ),
      query.execute(
        'uniprot-query',
        { database: 'rest-json/uniprot', domain: 'protein', rawQuery: 'TP53' },
        undefined,
        fakeCtx()
      )
    ])
    assert.ok(results.every((result) => !result.isError))
  })
})

test('exact identifier resolution permits its ready query without route discovery', async () => {
  await withHarness(async ({ agentDir }) => {
    const adapter: DbAdapter = {
      async listDomains() {
        return []
      },
      async describeDomain() {
        return []
      },
      async query(params): Promise<DbAdapterQueryResult> {
        return {
          rows: [{ accession: 'P04637' }],
          truncated: false,
          provenance: {
            database: 'rest-json/uniprot',
            domain: params.domain,
            retrievedAt: '2026-09-28T00:00:00.000Z'
          }
        }
      }
    }
    const tools = buildDbCustomTools({ 'rest-json/uniprot': adapter }, agentDir, {
      enforceRouting: true
    })
    const resolve = tools.find((tool) => tool.name === 'db_resolve')!
    const query = tools.find((tool) => tool.name === 'db_query')!
    const resolved = await resolve.execute('resolve-p04637', { id: 'P04637' }, undefined, fakeCtx())
    const details = resolved.details as {
      matches: Array<{ query?: Record<string, unknown> }>
    }
    const ready = details.matches.find((match) => match.query)?.query
    assert.ok(ready)
    const result = await query.execute('query-p04637', ready, undefined, fakeCtx())
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]?.text ?? '', /P04637/)
  })
})

test('rest-json jsonBodyTemplates build GraphQL POST bodies from filters', () => {
  const parsed = parseDbConnectorManifest(
    [
      'phiDbConnectorVersion: 1',
      'id: rest-json/graphql-toy',
      'name: GraphQL Toy',
      'protocolFamily: rest-json',
      'curationTier: curated',
      'baseUrl: https://api.example.org',
      'networkPolicy:',
      '  allowedHosts: [api.example.org]',
      'auth:',
      '  type: none',
      'domains:',
      '  - id: variant',
      '    summary: GraphQL variant lookup',
      '    commonFields: [variant_id]',
      '    rest:',
      '      request:',
      '        method: POST',
      '        path: /api',
      '        idempotent: true',
      '        jsonBodyTemplates:',
      '          query: \'{ variant(variantId: "{filter:variantId}") { variant_id } }\'',
      '      response:',
      '        rowsPath: data.variant',
      '    fields:',
      '      - name: variantId',
      '        type: string'
    ].join('\n')
  )
  assert.equal(parsed.valid, true)
  const domain = parsed.manifest!.domains[0]
  const request = buildRestJsonRequest(domain, {
    domain: 'variant',
    limit: 10,
    filters: [{ field: 'variantId', op: '=', value: '17-7676154-G-A' }]
  })
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/api')
  assert.deepEqual(JSON.parse(request.body ?? '{}'), {
    query: '{ variant(variantId: "17-7676154-G-A") { variant_id } }'
  })

  const escaped = buildRestJsonRequest(domain, {
    domain: 'variant',
    limit: 10,
    filters: [{ field: 'variantId', op: '=', value: '1-1-A-T" } evil' }]
  })
  assert.deepEqual(JSON.parse(escaped.body ?? '{}'), {
    query: '{ variant(variantId: "1-1-A-T\\" } evil") { variant_id } }'
  })
})

test('bundled Open Targets GraphQL templates keep nested braces and substitute filters', async () => {
  await withHarness(({ agentDir }) => {
    const entry = listDbConnectorCatalog(agentDir).find(
      (candidate) => candidate.manifest.id === 'rest-json/opentargets'
    )
    assert.ok(entry)
    const domain = entry!.manifest.domains.find((candidate) => candidate.id === 'search')
    assert.ok(domain)
    const request = buildRestJsonRequest(domain!, {
      domain: 'search',
      limit: 7,
      filters: [{ field: 'q', op: '=', value: 'TP53' }]
    })
    const body = JSON.parse(request.body ?? '{}') as { query: string }
    assert.match(body.query, /queryString: "TP53"/)
    assert.match(body.query, /page: \{ index: 0, size: 7 \}/)
    assert.match(body.query, /hits \{ id name entity description score \}/)

    const paged = buildRestJsonRequest(domain!, {
      domain: 'search',
      limit: 5,
      cursor: '2',
      filters: [{ field: 'q', op: '=', value: 'BRCA1' }]
    })
    assert.match(JSON.parse(paged.body ?? '{}').query, /page: \{ index: 2, size: 5 \}/)

    assert.ok(entry!.manifest.domains.some((candidate) => candidate.id === 'evidence'))
    assert.ok(entry!.manifest.domains.some((candidate) => candidate.id === 'associated_targets'))
  })
})

test('gnomAD region and GTEx eQTL domains render expected requests', async () => {
  await withHarness(({ agentDir }) => {
    const gnomad = listDbConnectorCatalog(agentDir).find(
      (candidate) => candidate.manifest.id === 'rest-json/gnomad'
    )
    const region = gnomad?.manifest.domains.find((candidate) => candidate.id === 'region')
    assert.ok(region)
    const regionRequest = buildRestJsonRequest(region!, {
      domain: 'region',
      limit: 10,
      filters: [
        { field: 'chrom', op: '=', value: '17' },
        { field: 'start', op: '=', value: 7660000 },
        { field: 'stop', op: '=', value: 7670000 }
      ]
    })
    const regionBody = JSON.parse(regionRequest.body ?? '{}') as { query: string }
    assert.match(regionBody.query, /chrom: "17"/)
    assert.match(regionBody.query, /start: 7660000/)
    assert.match(regionBody.query, /stop: 7670000/)

    const gtex = listDbConnectorCatalog(agentDir).find(
      (candidate) => candidate.manifest.id === 'rest-json/gtex'
    )
    const eqtl = gtex?.manifest.domains.find((candidate) => candidate.id === 'single_tissue_eqtl')
    assert.ok(eqtl)
    const eqtlRequest = buildRestJsonRequest(eqtl!, {
      domain: 'single_tissue_eqtl',
      limit: 25,
      filters: [
        { field: 'gencodeId', op: '=', value: 'ENSG00000139618.17' },
        { field: 'tissueSiteDetailId', op: '=', value: 'Whole_Blood' }
      ]
    })
    assert.equal(eqtlRequest.path, '/association/singleTissueEqtl')
    assert.equal(eqtlRequest.searchParams.get('gencodeId'), 'ENSG00000139618.17')
    assert.equal(eqtlRequest.searchParams.get('tissueSiteDetailId'), 'Whole_Blood')
    assert.equal(eqtlRequest.searchParams.get('itemsPerPage'), '25')

    const bindingdb = listDbConnectorCatalog(agentDir).find(
      (candidate) => candidate.manifest.id === 'rest-json/bindingdb'
    )
    const ligands = bindingdb?.manifest.domains.find(
      (candidate) => candidate.id === 'ligands_by_uniprot'
    )
    assert.ok(ligands)
    const ligandsRequest = buildRestJsonRequest(ligands!, {
      domain: 'ligands_by_uniprot',
      limit: 10,
      filters: [
        { field: 'uniprot', op: '=', value: 'P04637' },
        { field: 'cutoff', op: '=', value: 10000 }
      ]
    })
    assert.equal(ligandsRequest.path, '/getLigandsByUniprots')
    assert.equal(ligandsRequest.searchParams.get('uniprot'), 'P04637')
    assert.equal(ligandsRequest.searchParams.get('cutoff'), '10000')
  })
})

test('Phase 2 expansion connectors parse and expose BioGRID required auth metadata', async () => {
  await withHarness(({ agentDir }) => {
    const catalog = listDbConnectorCatalog(agentDir)
    const opentargets = catalog.find((entry) => entry.manifest.id === 'rest-json/opentargets')
    const gnomad = catalog.find((entry) => entry.manifest.id === 'rest-json/gnomad')
    const biogrid = catalog.find((entry) => entry.manifest.id === 'rest-json/biogrid')
    assert.ok(opentargets)
    assert.ok(gnomad)
    assert.ok(biogrid)
    assert.equal(biogrid?.manifest.auth?.envVar, 'BIOGRID_API_KEY')
    assert.equal(biogrid?.manifest.auth?.required, true)
    assert.equal(biogrid?.manifest.auth?.paramName, 'accesskey')
    assert.ok(opentargets?.manifest.domains.some((domain) => domain.id === 'associated_diseases'))
    assert.ok(gnomad?.manifest.domains.some((domain) => domain.rest?.request.jsonBodyTemplates))
  })
})

test('DB credential store encrypts secrets and resolveDbAuthSecret prefers env', async () => {
  await withHarness(async ({ agentDir }) => {
    const {
      clearDbConnectorSecret,
      hasDbConnectorSecret,
      readDbConnectorSecret,
      resolveDbAuthSecret,
      storeDbConnectorSecret
    } = await import('../src/main/agent/db/credential-store')

    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        const text = encrypted.toString('utf8')
        assert.ok(text.startsWith('enc:'))
        return text.slice(4)
      }
    }

    storeDbConnectorSecret('BIOGRID_API_KEY', 'secret-key', agentDir, fakeSafeStorage)
    assert.equal(hasDbConnectorSecret('BIOGRID_API_KEY', agentDir), true)
    assert.equal(readDbConnectorSecret('BIOGRID_API_KEY', agentDir, fakeSafeStorage), 'secret-key')
    assert.equal(resolveDbAuthSecret('BIOGRID_API_KEY', agentDir, fakeSafeStorage), 'secret-key')

    process.env.BIOGRID_API_KEY = 'from-env'
    assert.equal(resolveDbAuthSecret('BIOGRID_API_KEY', agentDir, fakeSafeStorage), 'from-env')
    delete process.env.BIOGRID_API_KEY

    clearDbConnectorSecret('BIOGRID_API_KEY', agentDir)
    assert.equal(hasDbConnectorSecret('BIOGRID_API_KEY', agentDir), false)
  })
})

test('required BioGRID auth fails fast without a configured key', async () => {
  await withHarness(async ({ agentDir }) => {
    delete process.env.BIOGRID_API_KEY
    const entry = listDbConnectorCatalog(agentDir).find(
      (candidate) => candidate.manifest.id === 'rest-json/biogrid'
    )
    assert.ok(entry)
    await assert.rejects(
      () =>
        executeDbHttpRequest({
          manifest: entry!.manifest,
          path: '/interactions',
          searchParams: new URLSearchParams({ format: 'json', geneList: 'TP53' }),
          method: 'GET',
          headers: { accept: 'application/json' },
          defaultProxyMode: 'disabled',
          transport: {
            name: 'direct',
            fetch: async () => {
              throw new Error('should not fetch without auth')
            }
          }
        }),
      (error: unknown) => {
        assert.ok(error instanceof DbHttpError)
        assert.equal(error.code, 'DB_AUTH_REQUIRED')
        assert.match(error.message, /BIOGRID_API_KEY/)
        return true
      }
    )
  })
})

test('rest-json TSV response parsing and adapter query', async () => {
  const rows = parseTsvPayload(
    ['ENTITYA\tENTITYB\tTYPE', 'P04637\tP38398\tphosphorylation', 'P00533\tP04626\tbinding'].join(
      '\n'
    ),
    { format: 'tsv', tsvHasHeader: true }
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.ENTITYA, 'P04637')
  assert.equal(rows[1]?.TYPE, 'binding')

  const withoutHeader = parseTsvPayload('a\tb\n1\t2', {
    format: 'tsv',
    tsvHasHeader: false,
    tsvColumns: ['left', 'right']
  })
  assert.deepEqual(withoutHeader, [
    { left: 'a', right: 'b' },
    { left: '1', right: '2' }
  ])

  const manifest: DbConnectorManifest = {
    phiDbConnectorVersion: 1,
    id: 'rest-json/tsv-fixture',
    name: 'TSV Fixture',
    protocolFamily: 'rest-json',
    curationTier: 'curated',
    baseUrl: 'https://api.example.org',
    networkPolicy: { allowedHosts: ['api.example.org'], allowRedirects: false },
    domains: [
      {
        id: 'edges',
        summary: 'TSV edges',
        commonFields: ['ENTITYA', 'ENTITYB', 'TYPE'],
        fields: [
          { name: 'ENTITYA', type: 'string' },
          { name: 'ENTITYB', type: 'string' },
          { name: 'TYPE', type: 'string' }
        ],
        rest: {
          request: { path: '/edges.tsv' },
          response: { format: 'tsv', tsvHasHeader: true }
        }
      }
    ]
  }
  const adapter = new RestJsonAdapter(manifest, {
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    sleep: async () => {},
    transport: {
      name: 'mock-tsv',
      async fetch() {
        return new Response('ENTITYA\tENTITYB\tTYPE\nP04637\tQ00987\tinhibition\n', {
          status: 200,
          headers: { 'content-type': 'text/tab-separated-values' }
        })
      }
    }
  })
  const result = await adapter.query({ domain: 'edges', limit: 10 })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.ENTITYA, 'P04637')
  assert.equal(result.rows[0]?.TYPE, 'inhibition')
})

test('optimization deepen: OmniPath/AlphaFold/HPA/EuropePMC/OpenFDA domains and contracts', async () => {
  await withHarness(async ({ agentDir }) => {
    const catalog = listDbConnectorCatalog(agentDir)
    const omnipath = catalog.find((entry) => entry.manifest.id === 'rest-json/omnipath')
    const alphafold = catalog.find((entry) => entry.manifest.id === 'rest-json/alphafold')
    const hpa = catalog.find((entry) => entry.manifest.id === 'rest-json/hpa')
    const europepmc = catalog.find((entry) => entry.manifest.id === 'rest-json/europepmc')
    const openfda = catalog.find((entry) => entry.manifest.id === 'rest-json/openfda')
    assert.ok(omnipath && alphafold && hpa && europepmc && openfda)

    for (const id of ['interactions', 'signor', 'enz_sub', 'annotations', 'intercell']) {
      assert.ok(
        omnipath!.manifest.domains.some((domain) => domain.id === id),
        `missing omnipath domain ${id}`
      )
    }
    assert.ok(alphafold!.manifest.domains.some((domain) => domain.id === 'structure_summary'))
    assert.ok(hpa!.manifest.domains.some((domain) => domain.id === 'search_pathology'))
    assert.ok(europepmc!.manifest.domains.some((domain) => domain.id === 'citations'))
    assert.ok(europepmc!.manifest.domains.some((domain) => domain.id === 'references'))
    assert.ok(openfda!.manifest.domains.some((domain) => domain.id === 'drug_label_by_name'))
    assert.ok(openfda!.manifest.domains.some((domain) => domain.id === 'drug_event_by_name'))

    const byName = openfda!.manifest.domains.find((domain) => domain.id === 'drug_label_by_name')
    const request = buildRestJsonRequest(byName!, {
      domain: 'drug_label_by_name',
      limit: 5,
      filters: [{ field: 'name', op: '=', value: 'aspirin' }]
    })
    assert.equal(request.path, '/drug/label.json')
    assert.match(request.searchParams.get('search') ?? '', /openfda\.brand_name:"aspirin"/)
    assert.match(request.searchParams.get('search') ?? '', /openfda\.generic_name:"aspirin"/)
    assert.match(request.searchParams.get('search') ?? '', / OR /)
    assert.equal(request.searchParams.get('limit'), '5')

    const quotedName = buildRestJsonRequest(byName!, {
      domain: 'drug_label_by_name',
      limit: 1,
      filters: [{ field: 'name', op: '=', value: 'foo"bar' }]
    })
    assert.match(quotedName.searchParams.get('search') ?? '', /openfda\.brand_name:"foo\\"bar"/)

    const bindingdb = catalog.find((entry) => entry.manifest.id === 'rest-json/bindingdb')
    const clinpgx = catalog.find((entry) => entry.manifest.id === 'rest-json/clinpgx')
    const zinc = catalog.find((entry) => entry.manifest.id === 'rest-json/zinc')
    assert.ok(bindingdb && clinpgx && zinc)

    const bindingAdapter = new RestJsonAdapter(bindingdb!.manifest, {
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      sleep: async () => {},
      transport: {
        name: 'mock-bindingdb',
        async fetch() {
          return new Response(
            JSON.stringify({
              getLigandsByUniprotsResponse: {
                affinities: [
                  {
                    monomerid: '123',
                    smile: 'CCO',
                    affinity_type: 'Ki',
                    affinity: '10',
                    pmid: '1',
                    doi: '10.1/x'
                  }
                ]
              }
            }),
            { status: 200 }
          )
        }
      }
    })
    const bindingResult = await bindingAdapter.query({
      domain: 'ligands_by_uniprot',
      limit: 10,
      filters: [{ field: 'uniprot', op: '=', value: 'P04637' }]
    })
    assert.equal(bindingResult.rows[0]?.monomerid, '123')
    assert.equal(bindingResult.rows[0]?.smile, 'CCO')

    const clinpgxAdapter = new RestJsonAdapter(clinpgx!.manifest, {
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      sleep: async () => {},
      transport: {
        name: 'mock-clinpgx',
        async fetch() {
          return new Response(
            JSON.stringify({
              data: [{ objCls: 'Gene', id: 'PA128', name: 'CYP2D6', symbol: 'CYP2D6' }]
            }),
            { status: 200 }
          )
        }
      }
    })
    const clinpgxResult = await clinpgxAdapter.query({
      domain: 'search',
      limit: 10,
      rawQuery: 'CYP2D6'
    })
    assert.equal(clinpgxResult.rows[0]?.symbol, 'CYP2D6')
    assert.equal(clinpgxResult.rows[0]?.objCls, 'Gene')

    const zincAdapter = new RestJsonAdapter(zinc!.manifest, {
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      sleep: async () => {},
      transport: {
        name: 'mock-zinc',
        async fetch() {
          return new Response(
            JSON.stringify({
              zinc_id: 'ZINC000000000053',
              preferred_name: 'aspirin',
              smiles: 'CC(=O)Oc1ccccc1C(=O)O',
              inchikey: 'BSYNRYMUTXKLSE-UHFFFAOYSA-N'
            }),
            { status: 200 }
          )
        }
      }
    })
    const zincResult = await zincAdapter.query({
      domain: 'substance',
      limit: 1,
      filters: [{ field: 'zinc_id', op: '=', value: 'ZINC000000000053' }]
    })
    assert.equal(zincResult.rows[0]?.zinc_id, 'ZINC000000000053')
    assert.equal(zincResult.rows[0]?.preferred_name, 'aspirin')

    const openfdaAdapter = new RestJsonAdapter(openfda!.manifest, {
      now: () => new Date('2026-09-20T00:00:00.000Z'),
      sleep: async () => {},
      transport: {
        name: 'mock-openfda',
        async fetch() {
          return new Response(
            JSON.stringify({
              meta: { results: { total: 1 } },
              results: [
                {
                  id: 'label-1',
                  effective_time: '20200101',
                  openfda: {
                    brand_name: ['ASPIRIN'],
                    generic_name: ['aspirin'],
                    manufacturer_name: ['Example']
                  },
                  indications_and_usage: ['Pain'],
                  warnings: ['Bleeding']
                }
              ]
            }),
            { status: 200 }
          )
        }
      }
    })
    const openfdaResult = await openfdaAdapter.query({
      domain: 'drug_label_by_name',
      limit: 5,
      filters: [{ field: 'name', op: '=', value: 'aspirin' }]
    })
    assert.equal(openfdaResult.rows[0]?.id, 'label-1')
    assert.deepEqual(openfdaResult.rows[0]?.brand_name, ['ASPIRIN'])
    assert.equal(openfdaResult.totalRows, 1)

    const emptyDetails = buildDbQueryToolDetails(
      {
        rows: [],
        truncated: false,
        provenance: {
          database: 'rest-json/openfda',
          domain: 'drug_label_by_name',
          retrievedAt: '2026-09-20T00:00:00.000Z'
        }
      },
      {
        agentDir,
        resolvedQuery: {
          database: 'rest-json/openfda',
          domain: 'drug_label_by_name',
          inferred: true,
          targetSource: 'heuristic',
          predicateSource: 'heuristic',
          input: { source: 'query', text: 'aspirin label' },
          filters: [{ field: 'name', op: '=', value: 'aspirin' }],
          reasons: []
        }
      }
    )
    assert.equal(emptyDetails.summary.returnedRows, 0)
    assert.match(emptyDetails.summary.warnings.join(' '), /No rows returned/)
    assert.match(emptyDetails.summary.warnings.join(' '), /drug_label_by_name/)
  })
})
