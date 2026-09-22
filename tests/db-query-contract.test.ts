import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateDbRequestedFields } from '../src/main/agent/db/adapters/types'
import type { DbAdapter } from '../src/main/agent/db/adapters/types'
import { buildRestJsonRequest } from '../src/main/agent/db/adapters/rest-json-adapter'
import { findDbConnectorCatalogEntry } from '../src/main/agent/db/catalog'
import { closestNames } from '../src/main/agent/db/tool-query-hints'
import { buildDbQueryTool } from '../src/main/agent/db/tools'
import { DB_FILTER_OPS } from '../src/shared/dbConnectorTypes'

function withAgentDir<T>(callback: (agentDir: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-db-query-contract-'))
  return Promise.resolve(callback(join(root, '.phi-home'))).finally(() =>
    rmSync(root, { recursive: true, force: true })
  )
}

const ctx = {} as never

interface Schema {
  type?: string
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  enum?: unknown[]
  anyOf?: Schema[]
  default?: unknown
  maximum?: number
}

// ── the contract the model is given ───────────────────────────────────────

test('db_query requires the target, so the model must route explicitly instead of hoping to be guessed', async () => {
  await withAgentDir((agentDir) => {
    const schema = buildDbQueryTool({}, agentDir).parameters as Schema
    assert.deepEqual(schema.required?.slice().sort(), ['database', 'domain'])
  })
})

test('db_query no longer advertises free-text aliases', async () => {
  await withAgentDir((agentDir) => {
    const schema = buildDbQueryTool({}, agentDir).parameters as Schema
    for (const alias of ['query', 'term', 'keyword']) {
      assert.equal(schema.properties?.[alias], undefined, `${alias} should not be in the schema`)
    }
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
      'cursor',
      'database',
      'domain',
      'fields',
      'filters',
      'limit',
      'maxPages',
      'rawQuery'
    ])
  })
})

test('a filter is an object with a field and an operator from the fixed list', async () => {
  await withAgentDir((agentDir) => {
    const filters = (buildDbQueryTool({}, agentDir).parameters as Schema).properties?.filters
    assert.equal(filters?.type, 'array')
    assert.equal(filters?.items?.type, 'object')
    assert.deepEqual(filters?.items?.required?.slice().sort(), ['field', 'op'])
    assert.equal(filters?.items?.properties?.field?.type, 'string')
    assert.deepEqual(filters?.items?.properties?.op?.enum, [...DB_FILTER_OPS])
    assert.ok(filters?.items?.properties?.value, 'a filter can carry a value')
  })
})

test('the operator list is the one the adapters understand', () => {
  assert.deepEqual(
    [...DB_FILTER_OPS],
    ['=', '!=', '>', '<', '>=', '<=', 'in', 'between', 'like', 'is_null']
  )
})

test('the remaining parameters keep their types and bounds', async () => {
  await withAgentDir((agentDir) => {
    const properties = (buildDbQueryTool({}, agentDir).parameters as Schema).properties ?? {}
    assert.equal(properties.fields?.items?.type, 'string')
    assert.equal(properties.limit?.maximum, 500)
    assert.equal(properties.rawQuery?.type, 'string')
    assert.equal(properties.cursor?.type, 'string')
  })
})

test('the description no longer promises to infer the database from the user intent', async () => {
  await withAgentDir((agentDir) => {
    const { description } = buildDbQueryTool({}, agentDir)
    assert.doesNotMatch(description, /infer the database\/domain/i)
    assert.match(description, /db_domain/)
  })
})

// ── mistakes in the target come back with the way out ─────────────────────

async function runQuery(
  params: Record<string, unknown>,
  adapters: Record<string, DbAdapter> = {}
): Promise<{ text: string; isError?: boolean; code?: string }> {
  return withAgentDir(async (agentDir) => {
    const result = await buildDbQueryTool(adapters, agentDir).execute('q1', params, undefined, ctx)
    return {
      text: (result.content[0] as { text: string }).text,
      isError: result.isError,
      code: (result.details as { code?: string } | undefined)?.code
    }
  })
}

test('an unknown database is answered with the closest installed ones, not just "not found"', async () => {
  const result = await runQuery({ database: 'rest-json/unprot', domain: 'protein' })
  assert.equal(result.isError, true)
  assert.equal(result.code, 'connector_not_found')
  assert.match(result.text, /rest-json\/unprot/)
  assert.match(result.text, /rest-json\/uniprot/)
  assert.match(result.text, /db_search/)
  assert.ok(
    result.text.length < 600,
    `should suggest a few, not list all: ${result.text.length} chars`
  )
})

test('an unknown domain is answered with the closest domains of that database', async () => {
  const result = await runQuery({ database: 'rest-json/uniprot', domain: 'protien' })
  assert.equal(result.isError, true)
  assert.equal(result.code, 'invalid_query')
  assert.match(result.text, /protien/)
  assert.match(result.text, /\bprotein\b/)
  assert.match(result.text, /db_domain/)
  assert.ok(result.text.length < 600, `${result.text.length} chars`)
})

test('an unknown domain with nothing close still lists a few real ones', async () => {
  const result = await runQuery({ database: 'rest-json/uniprot', domain: 'zzzz' })
  assert.equal(result.isError, true)
  assert.match(result.text, /protein/)
})

function throwingAdapter(build: () => unknown): DbAdapter {
  return {
    listDomains: async () => [],
    describeDomain: async () => [],
    query: async () => {
      build()
      throw new Error('the adapter should have rejected the query before this point')
    }
  }
}

test('a misspelt field name gets the closest real names, and not the whole field dump', async () => {
  const entry = withAgentDirSync((agentDir) =>
    findDbConnectorCatalogEntry('rest-json/uniprot', agentDir)
  )
  const domain = entry?.manifest.domains.find((candidate) => candidate.id === 'protein')
  assert.ok(domain)
  const adapter = throwingAdapter(() => validateDbRequestedFields(domain, ['gene_nam']))
  const original = (() => {
    try {
      validateDbRequestedFields(domain, ['gene_nam'])
    } catch (error) {
      return (error as Error).message
    }
    return ''
  })()

  const result = await runQuery(
    { database: 'rest-json/uniprot', domain: 'protein', fields: ['gene_nam'] },
    { 'rest-json/uniprot': adapter }
  )

  assert.equal(result.isError, true)
  assert.match(result.text, /does not expose field: gene_nam/)
  assert.match(result.text, /did you mean:[^.]*\bgene_name\b/i)
  assert.ok(
    result.text.length < original.length / 2,
    `the ${original.length}-char field dump should be replaced, got ${result.text.length}`
  )
})

test('a filter the domain does not accept gets the closest accepted filters', async () => {
  const entry = withAgentDirSync((agentDir) =>
    findDbConnectorCatalogEntry('rest-json/chembl', agentDir)
  )
  const domain = entry?.manifest.domains.find((candidate) => candidate.id === 'molecule')
  assert.ok(domain)
  const adapter = throwingAdapter(() =>
    buildRestJsonRequest(domain, {
      domain: 'molecule',
      filters: [{ field: 'chembl_idd', op: '=', value: 'CHEMBL25' }],
      limit: 1
    })
  )

  const result = await runQuery(
    {
      database: 'rest-json/chembl',
      domain: 'molecule',
      filters: [{ field: 'chembl_idd', op: '=', value: 'CHEMBL25' }]
    },
    { 'rest-json/chembl': adapter }
  )

  assert.equal(result.isError, true)
  assert.match(result.text, /does not accept filter: chembl_idd/)
  assert.match(result.text, /did you mean:[^.]*\bchembl_id\b/i)
})

test('errors that are not about names pass through unchanged', async () => {
  const result = await runQuery(
    { database: 'rest-json/uniprot', domain: 'protein' },
    {
      'rest-json/uniprot': throwingAdapter(() => {
        throw new Error('rest-json filters and rawQuery cannot be used together')
      })
    }
  )
  assert.equal(result.text, 'rest-json filters and rawQuery cannot be used together')
})

function withAgentDirSync<T>(callback: (agentDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'phi-db-query-contract-'))
  try {
    return callback(join(root, '.phi-home'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── the name matcher ──────────────────────────────────────────────────────

test('closestNames ranks typos, shared words and substrings ahead of unrelated names', () => {
  const domains = [
    'protein',
    'uniref',
    'uniparc',
    'proteome',
    'id_mapping',
    'lookup_symbol',
    'lookup_id'
  ]
  assert.equal(closestNames('protien', domains)[0], 'protein')
  assert.equal(closestNames('lookup', domains).slice(0, 2).sort().join(), 'lookup_id,lookup_symbol')
  assert.equal(closestNames('symbol_lookup', domains)[0], 'lookup_symbol')
  assert.deepEqual(closestNames('zzzz', domains), [])
  assert.deepEqual(closestNames('protein', []), [])
  assert.ok(closestNames('pro', domains, 2).length <= 2)
})
