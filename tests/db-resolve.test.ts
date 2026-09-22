import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listDbConnectorCatalog } from '../src/main/agent/db/catalog'
import { inferQueryPredicate } from '../src/main/agent/db/tool-query-resolution'
import { buildDbResolveTool, resolveDbIdentifier } from '../src/main/agent/db/tool-resolve'
import type { DbConnectorCatalogEntry } from '../src/main/agent/db/manifest-types'

function withCatalog<T>(callback: (catalog: DbConnectorCatalogEntry[], agentDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-db-resolve-'))
  try {
    const agentDir = join(root, '.phi-home')
    return callback(listDbConnectorCatalog(agentDir), agentDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

interface Route {
  kind: string
  database: string
  domain: string
  ambiguous?: boolean
  query?: { database: string; domain: string; filters?: unknown[]; rawQuery?: string }
}

function routes(id: string, catalog: DbConnectorCatalogEntry[]): Route[] {
  const result = resolveDbIdentifier(id, catalog)
  assert.equal(result.recognized, true, `${id} should be recognized`)
  return result.matches as Route[]
}

// Each row: identifier -> [database, domain] the first match must be, and what the ready-made
// query must contain. The query is what db_query is called with, so it must be complete.
const EXACT_ROUTES: Array<[string, string, string, unknown]> = [
  ['GSE12345', 'entrez/ncbi', 'geo', { rawQuery: 'GSE12345' }],
  ['gsm99', 'entrez/ncbi', 'geo', { rawQuery: 'GSM99' }],
  ['SRR1234567', 'entrez/ncbi', 'sra', { rawQuery: 'SRR1234567' }],
  ['ERX000001', 'entrez/ncbi', 'sra', { rawQuery: 'ERX000001' }],
  ['PRJNA123456', 'entrez/ncbi', 'bioproject', { rawQuery: 'PRJNA123456' }],
  ['SAMN00000002', 'entrez/ncbi', 'biosample', { rawQuery: 'SAMN00000002' }],
  ['VCV000012582', 'entrez/ncbi', 'clinvar', { rawQuery: 'VCV000012582' }],
  [
    'P04637',
    'rest-json/uniprot',
    'protein',
    { filters: [{ field: 'accession', op: '=', value: 'P04637' }] }
  ],
  [
    'ENSG00000141510',
    'rest-json/ensembl',
    'lookup_id',
    { filters: [{ field: 'id', op: '=', value: 'ENSG00000141510' }] }
  ],
  [
    'ENSMUST00000000001.5',
    'rest-json/ensembl',
    'lookup_id',
    { filters: [{ field: 'id', op: '=', value: 'ENSMUST00000000001.5' }] }
  ],
  [
    'GO:0006915',
    'ontology/go',
    'term',
    { filters: [{ field: 'id', op: '=', value: 'GO:0006915' }] }
  ],
  [
    'HP:0001250',
    'ontology/hpo',
    'term',
    { filters: [{ field: 'id', op: '=', value: 'HP:0001250' }] }
  ],
  ['NCT04280705', 'rest-json/clinicaltrials', 'study', undefined],
  [
    'R-HSA-109581',
    'rest-json/reactome',
    'query',
    { filters: [{ field: 'id', op: '=', value: 'R-HSA-109581' }] }
  ],
  [
    'IPR000719',
    'rest-json/interpro',
    'entry',
    { filters: [{ field: 'accession', op: '=', value: 'IPR000719' }] }
  ],
  [
    'WP254',
    'sparql/wikipathways',
    'pathway',
    { filters: [{ field: 'pathway_id', op: '=', value: 'WP254' }] }
  ]
]

for (const [id, database, domain, expectedQuery] of EXACT_ROUTES) {
  test(`db_resolve routes ${id} to ${database}/${domain} with a ready query`, () => {
    withCatalog((catalog) => {
      const [first] = routes(id, catalog)
      assert.equal(first.database, database)
      assert.equal(first.domain, domain)
      assert.ok(first.query, `${id} should come with query arguments`)
      assert.equal(first.query.database, database)
      assert.equal(first.query.domain, domain)
      assert.ok(first.query.filters || first.query.rawQuery, 'a query needs a predicate')
      if (expectedQuery)
        assert.deepEqual(
          { ...first.query, database: undefined, domain: undefined },
          { ...(expectedQuery as object), database: undefined, domain: undefined }
        )
    })
  })
}

test('an rsID is a variation lookup, with the GWAS catalog offered as the other route', () => {
  withCatalog((catalog) => {
    const matches = routes('rs334', catalog)
    assert.deepEqual(
      matches.slice(0, 2).map((match) => `${match.database}/${match.domain}`),
      ['rest-json/ensembl/variation', 'rest-json/gwas-catalog/snp']
    )
    assert.deepEqual(matches[0].query?.filters, [
      { field: 'species', op: '=', value: 'homo_sapiens' },
      { field: 'id', op: '=', value: 'rs334' }
    ])
  })
})

test('a ChEMBL id can be a molecule or a target, and both routes are offered as ambiguous', () => {
  withCatalog((catalog) => {
    const matches = routes('CHEMBL25', catalog)
    assert.deepEqual(
      matches.map((match) => match.domain),
      ['molecule', 'target']
    )
    assert.ok(matches.every((match) => match.ambiguous === true))
    assert.deepEqual(matches[0].query?.filters, [
      { field: 'chembl_id', op: '=', value: 'CHEMBL25' }
    ])
  })
})

test('a PDB id is offered but flagged as a guess, since four characters can be many things', () => {
  withCatalog((catalog) => {
    const [first] = routes('4HHB', catalog)
    assert.equal(first.database, 'rest-json/pdbe')
    assert.equal(first.ambiguous, true)
    assert.deepEqual(first.query?.filters, [{ field: 'pdb_id', op: '=', value: '4hhb' }])
  })
})

test('surrounding whitespace and quotes are ignored', () => {
  withCatalog((catalog) => {
    assert.equal(routes('  "GSE12345"  ', catalog)[0].domain, 'geo')
  })
})

test('names, sentences and bare numbers are not identifiers, and are not guessed at', () => {
  withCatalog((catalog) => {
    for (const text of [
      'TP53',
      'human TP53 protein structure',
      '7157',
      '',
      'GSE',
      'GSE12345 and GSE999',
      'SRR12x'
    ]) {
      const result = resolveDbIdentifier(text, catalog)
      assert.equal(result.recognized, false, `"${text}" must not be resolved`)
      assert.deepEqual(result.matches, [])
    }
  })
})

test('a route whose connector is missing or not enabled is reported, without a query', () => {
  withCatalog((catalog) => {
    const withoutUniprot = catalog.filter((entry) => entry.manifest.id !== 'rest-json/uniprot')
    const [missing] = routes('P04637', withoutUniprot)
    assert.equal(missing.query, undefined)
    assert.match(
      String((missing as Route & { unavailable?: string }).unavailable),
      /not installed/i
    )

    const disabled = catalog.map((entry) =>
      entry.manifest.id === 'entrez/ncbi' ? { ...entry, enabledForQuery: false } : entry
    )
    const [notEnabled] = routes('GSE12345', disabled)
    assert.equal(notEnabled.query, undefined)
    assert.match(
      String((notEnabled as Route & { unavailable?: string }).unavailable),
      /not enabled/i
    )
  })
})

test('every route the table can produce exists in the bundled catalog', () => {
  withCatalog((catalog) => {
    for (const [id] of EXACT_ROUTES) {
      for (const match of routes(id, catalog)) {
        assert.equal(
          (match as Route & { unavailable?: string }).unavailable,
          undefined,
          `${id} -> ${match.database}/${match.domain} is not available in the bundled catalog`
        )
      }
    }
  })
})

test('the db_resolve tool returns compact JSON with ready-made query arguments', async () => {
  await withCatalog(async (_catalog, agentDir) => {
    const result = await buildDbResolveTool(agentDir).execute(
      'r1',
      { id: 'GSE12345' },
      undefined,
      {} as never
    )
    assert.equal(result.isError, undefined)
    const text = (result.content[0] as { text: string }).text
    assert.equal(text, JSON.stringify(JSON.parse(text)))
    const parsed = JSON.parse(text) as { id: string; matches: Route[] }
    assert.equal(parsed.id, 'GSE12345')
    assert.deepEqual(parsed.matches[0].query, {
      database: 'entrez/ncbi',
      domain: 'geo',
      rawQuery: 'GSE12345'
    })
    assert.equal((result.details as { kind: string }).kind, 'db_resolve_result')
  })
})

test('the db_resolve tool sends unrecognised input to db_search and rejects a missing id', async () => {
  await withCatalog(async (_catalog, agentDir) => {
    const tool = buildDbResolveTool(agentDir)
    assert.equal(tool.name, 'db_resolve')
    assert.equal(tool.approval, 'read')

    const unknown = await tool.execute('r2', { id: 'TP53' }, undefined, {} as never)
    assert.match((unknown.content[0] as { text: string }).text, /db_search/)

    const missing = await tool.execute('r3', {}, undefined, {} as never)
    assert.equal(missing.isError, true)
  })
})

test('a UniProt accession of any shape becomes an accession filter, never a gene name', () => {
  // O/P/Q accessions and the 10-character A0A... form were once read as gene symbols.
  for (const accession of ['P04637', 'Q9Y6K9', 'O15111', 'A0A024R161', 'B7Z1M6', 'P04637-2']) {
    assert.deepEqual(
      inferQueryPredicate('rest-json/uniprot', 'protein', `human ${accession} structure`).filters,
      [{ field: 'accession', op: '=', value: accession }],
      accession
    )
  }
  for (const notAccession of ['TP53', 'C00031', 'BRCA1 human']) {
    const [filter] = inferQueryPredicate('rest-json/uniprot', 'protein', notAccession).filters ?? []
    assert.equal(filter?.field, 'gene_name', notAccession)
  }
})
