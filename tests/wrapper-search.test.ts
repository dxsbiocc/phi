import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetWrapperCompositionCatalogCache } from '../src/main/agent/wrappers/composition/discovery'
import { rankWrapperEntries } from '../src/main/agent/wrappers/composition/search'
import {
  buildWrapperCompositionInspectTool,
  buildWrapperCompositionSearchTool
} from '../src/main/agent/wrappers/composition/tools'

function wrapper(
  id: string,
  summary: string,
  name = id.split('/').pop() ?? id
): { manifest: { id: string; name: string; summary: string } } {
  return { manifest: { id, name, summary } }
}

const CATALOG = [
  wrapper('nf-core/modules/fastqc', 'Read-level quality control for FASTQ files.'),
  wrapper('nf-core/modules/fastp', 'Adapter trimming and filtering of FASTQ reads.'),
  wrapper('nf-core/modules/trimgalore', 'Adapter trimming with built-in quality control reports.'),
  wrapper('nf-core/modules/bowtie2-align', 'Align reads to a Bowtie2 index.', 'bowtie2/align'),
  wrapper(
    'nf-core/workflows/rnaseq',
    'Full RNA-seq quantification pipeline (QC, trim, align).',
    'nf-core/rnaseq'
  ),
  wrapper('nf-core/modules/multiqc', 'Aggregate results from many tools; also reads FastQC output.')
]

// The tool boundary uses the same small metadata cases as the ranking tests.
const sourceRoot = mkdtempSync(join(tmpdir(), 'phi-wrapper-search-'))
for (const { manifest } of CATALOG) {
  const [provider, kind, name] = manifest.id.split('/')
  const dir = join(sourceRoot, kind, provider, name, 'wrapper')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.nf'), 'workflow {}\n')
  writeFileSync(join(dir, 'params.json'), '{}\n')
  writeFileSync(
    join(dir, 'wrapper.yaml'),
    JSON.stringify({
      ...manifest,
      params: {},
      outputs: { report: { type: 'path', path: 'results/report.txt', primary: true } }
    })
  )
}
const DISCOVERY = { sourceRoot }
after(() => rmSync(sourceRoot, { recursive: true, force: true }))

const ids = (entries: ReadonlyArray<{ manifest: { id: string } }>): string[] =>
  entries.map((entry) => entry.manifest.id)

test('an empty query lists everything in catalog order', () => {
  const outcome = rankWrapperEntries(CATALOG, '   ')
  assert.deepEqual(ids(outcome.entries), ids(CATALOG))
  assert.equal(outcome.matchedAll, true)
})

test('a multi-word query matches when every word appears somewhere, in any order', () => {
  const outcome = rankWrapperEntries(CATALOG, 'trimming quality')
  assert.deepEqual(ids(outcome.entries), ['nf-core/modules/trimgalore'])
  assert.equal(outcome.matchedAll, true)
})

test('separators and case do not matter: "RNA seq", "rna-seq" and "rnaseq" find the same wrapper', () => {
  for (const query of ['RNA seq', 'rna-seq', 'rnaseq', 'RNA-Seq pipeline']) {
    const outcome = rankWrapperEntries(CATALOG, query)
    assert.ok(
      ids(outcome.entries).includes('nf-core/workflows/rnaseq'),
      `"${query}" should find the rnaseq wrapper, got ${JSON.stringify(ids(outcome.entries))}`
    )
  }
})

test('an id or name hit outranks a summary-only mention', () => {
  const outcome = rankWrapperEntries(CATALOG, 'fastqc')
  assert.equal(outcome.entries[0].manifest.id, 'nf-core/modules/fastqc')
  assert.ok(ids(outcome.entries).includes('nf-core/modules/multiqc'))
})

test('a longer query word matches its stem, but not an unrelated shorter word inside it', () => {
  assert.ok(
    ids(rankWrapperEntries(CATALOG, 'alignment').entries).includes('nf-core/modules/bowtie2-align')
  )
  // "profile" merely contains "file"; only a prefix relation counts as a stem.
  const profile = rankWrapperEntries([wrapper('x/y', 'Reads a FASTQ file.')], 'profile')
  assert.deepEqual(profile.entries, [])
})

test('a tool name that merely starts with another word is not a stem match', () => {
  const catalog = [
    wrapper('nf-core/modules/cat-fastq', 'Concatenate FASTQ files.'),
    wrapper('nf-core/modules/fastqc', 'Read-level quality control.')
  ]
  assert.deepEqual(ids(rankWrapperEntries(catalog, 'fastqc').entries), ['nf-core/modules/fastqc'])
  // Inflected forms still count: trimming ~ trim, aligned ~ align.
  const trim = [wrapper('a/trim', 'Trim reads.'), wrapper('a/align', 'Align reads.')]
  assert.deepEqual(ids(rankWrapperEntries(trim, 'trimming').entries), ['a/trim'])
  assert.deepEqual(ids(rankWrapperEntries(trim, 'aligned').entries), ['a/align'])
})

test('words that share a long stem match, so "quantification" finds a wrapper that says "quantify"', () => {
  const catalog = [
    wrapper('nf-core/modules/salmon-quant', 'Quantify transcript expression with salmon.'),
    wrapper('nf-core/modules/samtools-sort', 'Sort a BAM file.')
  ]
  const quantification = rankWrapperEntries(catalog, 'transcript quantification')
  assert.deepEqual(ids(quantification.entries), ['nf-core/modules/salmon-quant'])
  assert.equal(quantification.matchedAll, true, 'both words match: it is not a partial match')
  assert.deepEqual(ids(rankWrapperEntries(catalog, 'sequencing').entries), [])
  // Five shared characters are a coincidence, not a stem: "fastqc" is not "fastq".
  const fastq = [wrapper('nf-core/modules/cat-fastq', 'Concatenate FASTQ files.')]
  assert.deepEqual(rankWrapperEntries(fastq, 'fastqc').entries, [])
})

test('a partial match needs at least half of the query words, so one shared word is not an answer', () => {
  const catalog = [
    wrapper('nf-core/workflows/rnaseq', 'Full RNA-seq quantification pipeline.'),
    wrapper('nf-core/modules/rseqc-bamstat', 'Summarise a BAM file with RSeQC (RNA-seq).')
  ]
  // Nothing here is about ChIP-seq or peaks: only "seq" is shared.
  const chip = rankWrapperEntries(catalog, 'chip seq peak calling')
  assert.deepEqual(chip.entries, [])
  // Two of the four words are shared, which is enough to show as a partial match.
  const single = rankWrapperEntries(catalog, 'single cell rna seq')
  assert.ok(single.entries.length > 0)
  assert.equal(single.matchedAll, false)
  assert.ok(single.unmatchedWords.includes('cell'))
})

test('when no wrapper has every word, partial matches come back ranked and flagged', () => {
  const outcome = rankWrapperEntries(CATALOG, 'alignment adapter')
  assert.equal(outcome.matchedAll, false)
  assert.ok(outcome.entries.length > 0)
  assert.ok(ids(outcome.entries).includes('nf-core/modules/fastp'))
  assert.ok(ids(outcome.entries).includes('nf-core/modules/bowtie2-align'))
})

test('words that match nothing yield no results', () => {
  const outcome = rankWrapperEntries(CATALOG, 'zzzz qqqq')
  assert.deepEqual(outcome.entries, [])
})

test('a query made only of punctuation behaves like an empty query', () => {
  assert.equal(rankWrapperEntries(CATALOG, ' - / ').entries.length, CATALOG.length)
})

interface SearchContentResult {
  content: Array<{ type: string; text?: string }>
  details?: unknown
}

test('wrapper_search finds the RNA-seq pipeline from a natural multi-word query', async () => {
  resetWrapperCompositionCatalogCache()
  const result = (await buildWrapperCompositionSearchTool(DISCOVERY).execute('w1', {
    query: 'rna seq alignment'
  })) as SearchContentResult

  const details = result.details as { results: Array<{ id: string }> }
  assert.ok(details.results.some((item) => item.id === 'nf-core/workflows/rnaseq'))
})

test('wrapper_search content is compact JSON and names the words that matched nothing', async () => {
  resetWrapperCompositionCatalogCache()
  const result = (await buildWrapperCompositionSearchTool(DISCOVERY).execute('w2', {
    query: 'rna seq nonexistentword'
  })) as SearchContentResult

  const text = result.content[0].text ?? ''
  assert.equal(text, JSON.stringify(JSON.parse(text)), 'first content part is single-line JSON')
  const note = result.content[1]?.text ?? ''
  assert.match(note, /partial/i)
  assert.match(note, /nonexistentword/)
})

test('wrapper_search has no partial-match note when every word matched', async () => {
  resetWrapperCompositionCatalogCache()
  const result = (await buildWrapperCompositionSearchTool(DISCOVERY).execute('w3', {
    query: 'fastqc'
  })) as SearchContentResult
  assert.equal(result.content.length, 1)
})

test('wrapper_search reports an empty result in plain text', async () => {
  resetWrapperCompositionCatalogCache()
  const result = (await buildWrapperCompositionSearchTool(DISCOVERY).execute('w4', {
    query: 'zzzz qqqq'
  })) as SearchContentResult
  assert.match(result.content[0].text ?? '', /No matching wrappers/)
})

test('wrapper_inspect content is compact JSON', async () => {
  resetWrapperCompositionCatalogCache()
  const result = (await buildWrapperCompositionInspectTool(DISCOVERY).execute('w5', {
    id: 'nf-core/workflows/rnaseq'
  })) as SearchContentResult
  const text = result.content[0].text ?? ''
  assert.equal(text, JSON.stringify(JSON.parse(text)))
})
