import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildDbDocsSearchTool,
  buildDbDomainTool,
  buildDbSearchTool
} from '../src/main/agent/db/tools'

// What the model reads is `content[0].text`; `details` feeds the UI and must not change.
// These tests pin the model-facing text: compact, and carrying only what routing needs.

async function withAgentDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'phi-db-tool-output-'))
  try {
    return await callback(join(root, '.phi-home'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0]
  assert.equal(part.type, 'text')
  return part.text ?? ''
}

function assertCompactJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  assert.equal(text, JSON.stringify(parsed), 'content must be single-line JSON without indentation')
  return parsed
}

const ctx = {} as never

interface SearchItem {
  id: string
  name?: string
  domains: Array<{ id: string; summary?: string; match?: string[] }>
  enabled?: boolean
}

test('db_search content is compact and omits per-connector metadata the model does not route on', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbSearchTool(agentDir).execute('c1', {}, undefined, ctx)
    const text = contentText(result)
    const items = assertCompactJson(text) as SearchItem[]

    assert.ok(items.length > 10, 'bundled connectors should be listed')
    for (const item of items) {
      assert.deepEqual(
        Object.keys(item).filter((key) => !['id', 'name', 'domains', 'enabled'].includes(key)),
        [],
        `unexpected keys on ${item.id}`
      )
      for (const domain of item.domains) {
        assert.deepEqual(
          Object.keys(domain).filter((key) => !['id', 'summary', 'match'].includes(key)),
          [],
          `unexpected keys on ${item.id}/${domain.id}`
        )
        assert.equal(domain.match, undefined, 'no query, so no per-field match hints')
      }
    }

    const details = result.details as { results: unknown[] }
    const previousLength = JSON.stringify(details.results, null, 2).length
    assert.ok(
      text.length < previousLength * 0.5,
      `expected under half of the old ${previousLength} chars, got ${text.length}`
    )
  })
})

test('db_search content shows which common fields matched the query', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbSearchTool(agentDir).execute(
      'c2',
      { query: 'PDB structure' },
      undefined,
      ctx
    )
    const items = assertCompactJson(contentText(result)) as SearchItem[]
    const protein = items
      .find((item) => item.id === 'rest-json/uniprot')
      ?.domains.find((domain) => domain.id === 'protein')

    assert.ok(protein, 'uniprot/protein should be discovered from PDB structure intent')
    assert.ok(protein.match?.includes('pdb_ids'), `match was ${JSON.stringify(protein.match)}`)
    assert.ok((protein.match?.length ?? 0) <= 8, 'match hints stay short')
  })
})

test('db_search content flags connectors that are not enabled for query', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbSearchTool(agentDir).execute('c3', {}, undefined, ctx)
    const details = result.details as {
      results: Array<{ id: string; enabledForQuery: boolean }>
    }
    const items = assertCompactJson(contentText(result)) as SearchItem[]
    for (const detail of details.results) {
      const item = items.find((candidate) => candidate.id === detail.id)
      assert.ok(item, `${detail.id} missing from content`)
      assert.equal(item.enabled, detail.enabledForQuery ? undefined : false)
    }
  })
})

test('db_search still reports an empty result in plain text', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbSearchTool(agentDir).execute(
      'c4',
      { query: 'zzzz-no-such-database' },
      undefined,
      ctx
    )
    assert.match(contentText(result), /没有找到/)
  })
})

interface DomainContent {
  database: string
  domain: string
  summary: string
  identity?: { stableIdFields: string[] }
  standardFields: string[]
  commonFields: Array<{ name: string; type?: string; namespace?: string }>
  otherFields?: Array<string | { name: string; type?: string }>
}

test('db_domain content gives common fields in detail and the remaining fields by name only', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbDomainTool(agentDir).execute(
      'd1',
      { database: 'rest-json/uniprot', domain: 'protein' },
      undefined,
      ctx
    )
    assert.equal(result.isError, undefined)
    const text = contentText(result)
    const content = assertCompactJson(text) as DomainContent
    const details = result.details as {
      commonFields: string[]
      fields: Array<{ name: string }>
      identity: unknown
    }

    assert.equal(content.database, 'rest-json/uniprot')
    assert.equal(content.domain, 'protein')
    assert.deepEqual(content.identity, details.identity)
    assert.deepEqual(
      content.commonFields.map((field) => field.name),
      details.commonFields
    )
    assert.ok(content.commonFields.every((field) => typeof field.name === 'string'))
    assert.ok(
      (content.otherFields ?? []).every((field) => typeof field === 'string'),
      'other fields are bare names by default'
    )

    // No field the connector declares may disappear from what the model sees.
    const seen = new Set([
      ...content.commonFields.map((field) => field.name),
      ...(content.otherFields ?? []).map((field) =>
        typeof field === 'string' ? field : field.name
      )
    ])
    for (const field of details.fields) assert.ok(seen.has(field.name), `${field.name} was dropped`)

    // uniprot/protein declares 79 fields, 72 of them common, and the field descriptions are most
    // of the text, so the saving here is indentation and key overhead: a guard against going back
    // to pretty-printed JSON, not a compression target. Descriptions and synonyms are what maps
    // a user's wording onto a field name, so they stay.
    const previousLength = JSON.stringify(details, null, 2).length
    assert.ok(
      text.length < previousLength * 0.7,
      `expected under 70% of the old ${previousLength} chars, got ${text.length}`
    )
  })
})

test('db_domain detail:"all" returns every field in full', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbDomainTool(agentDir).execute(
      'd2',
      { database: 'rest-json/uniprot', domain: 'protein', detail: 'all' },
      undefined,
      ctx
    )
    const content = assertCompactJson(contentText(result)) as DomainContent
    const details = result.details as { fields: Array<{ name: string }> }
    const others = content.otherFields ?? []
    assert.ok(others.every((field) => typeof field === 'object' && typeof field.name === 'string'))
    const seen = new Set([
      ...content.commonFields.map((field) => field.name),
      ...others.map((field) => (typeof field === 'string' ? field : field.name))
    ])
    for (const field of details.fields) assert.ok(seen.has(field.name), `${field.name} was dropped`)
  })
})

test('db_domain keeps the not-found message readable', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbDomainTool(agentDir).execute(
      'd3',
      { database: 'rest-json/uniprot', domain: 'no-such-domain' },
      undefined,
      ctx
    )
    assert.equal(result.isError, true)
    assert.match(contentText(result), /no-such-domain/)
  })
})

interface DocsHit {
  kind: string
  database: string
  title: string
  snippet: string
  [key: string]: unknown
}

test('db_docs_search content is compact and drops ranking internals', async () => {
  await withAgentDir(async (agentDir) => {
    const result = await buildDbDocsSearchTool(agentDir).execute(
      'k1',
      { query: 'gene symbol' },
      undefined,
      ctx
    )
    const text = contentText(result)
    const hits = assertCompactJson(text) as DocsHit[]
    const details = result.details as { results: unknown[] }

    assert.ok(hits.length > 0)
    for (const hit of hits) {
      for (const dropped of [
        'score',
        'matchReasons',
        'protocolFamily',
        'curationTier',
        'trustTier'
      ]) {
        assert.equal(hit[dropped], undefined, `${dropped} should not reach the model`)
      }
      assert.ok(hit.kind && hit.database && hit.title && hit.snippet)
    }
    assert.equal(hits.length, details.results.length)

    const previousLength = JSON.stringify(details.results, null, 2).length
    assert.ok(
      text.length < previousLength * 0.6,
      `expected under 60% of the old ${previousLength} chars, got ${text.length}`
    )
  })
})
