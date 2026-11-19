import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readWrapperRun, getWrapperRunsDir } from '../src/main/agent/wrappers/store'

import {
  MAX_RESEARCH_QC_SIDECAR_BYTES,
  RESEARCH_QC_COLUMNS,
  declaresResearchQc,
  researchQcLaunchBlock,
  verifyResearchQcArtifacts
} from '../src/main/agent/wrappers/composition/research-qc'
import type { WrapperCompositionManifest } from '../src/shared/wrapperCompositionManifestTypes'

const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)

function md5(content: string | Buffer): string {
  return createHash('md5').update(content).digest('hex')
}

function manifest(overrides: Partial<WrapperCompositionManifest> = {}): WrapperCompositionManifest {
  return {
    id: 'nf-core/workflows/deseq2',
    name: 'DESeq2',
    summary: 'Differential expression',
    params: { outdir: { kind: 'output', type: 'string', required: true } },
    outputs: {
      results: { type: 'table', path: '${outdir}/deseq2.results.tsv', primary: true },
      research_qc: { type: 'research_qc', path: '${outdir}/run.deseq2.qc.tsv', primary: true }
    },
    ...overrides
  }
}

function sidecarText(resultMd5: string, overrides: Record<string, string> = {}): string {
  const fields = {
    schemaVersion: '1',
    disposition: 'eligible',
    contrast: 'condition_treated_vs_control',
    geneIdColumn: 'gene_id',
    padjThreshold: '0.05',
    log2fcThreshold: '1',
    evaluated: '12000',
    hits: '340',
    ...overrides
  }
  const record = [
    fields.schemaVersion,
    fields.disposition,
    fields.contrast,
    fields.geneIdColumn,
    fields.padjThreshold,
    fields.log2fcThreshold,
    fields.evaluated,
    fields.hits,
    resultMd5
  ].join(TAB)
  return RESEARCH_QC_COLUMNS.join(TAB) + LF + record + LF
}

const RESULTS =
  ['gene_id', 'log2FoldChange', 'padj'].join(TAB) + LF + ['gene1', '2.5', '0.001'].join(TAB) + LF

interface Harness {
  root: string
  outDir: string
  componentDir: string
  resultsPath: string
  qcPath: string
  params: Record<string, unknown>
}

function harness(t: { after: (fn: () => void) => void }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'phi-research-qc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'out')
  const componentDir = join(root, 'component')
  mkdirSync(outDir)
  mkdirSync(componentDir)
  return {
    root,
    outDir,
    componentDir,
    resultsPath: join(outDir, 'deseq2.results.tsv'),
    qcPath: join(outDir, 'run.deseq2.qc.tsv'),
    params: { outdir: outDir }
  }
}

function writeArtifacts(h: Harness, overrides: Record<string, string> = {}): void {
  writeFileSync(h.resultsPath, RESULTS)
  writeFileSync(h.qcPath, sidecarText(md5(RESULTS), overrides))
}

function verify(
  h: Harness,
  overrides: Partial<Parameters<typeof verifyResearchQcArtifacts>[0]> = {}
): ReturnType<typeof verifyResearchQcArtifacts> {
  return verifyResearchQcArtifacts({
    manifest: manifest(),
    params: h.params,
    componentDir: h.componentDir,
    outDir: h.outDir,
    ...overrides
  })
}

// ── declaration gate ──────────────────────────────────────────────────────

test('a wrapper is QC-gated only when it declares research_qc by id and type', () => {
  assert.equal(declaresResearchQc(manifest()), true)
  assert.equal(
    declaresResearchQc(
      manifest({
        outputs: {
          results: { type: 'table', path: '${outdir}/r.tsv', primary: true },
          research_qc: { type: 'table', path: '${outdir}/run.deseq2.qc.tsv', primary: true }
        }
      })
    ),
    false
  )
  assert.equal(
    declaresResearchQc(
      manifest({ outputs: { results: { type: 'table', path: '${outdir}/r.tsv', primary: true } } })
    ),
    false
  )
})

test('a malformed QC declaration is invalid, not silently ungated', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const base = manifest()
  const notPrimary = manifest({
    outputs: { ...base.outputs, research_qc: { ...base.outputs.research_qc, primary: false } }
  })
  assert.deepEqual(await verify(h, { manifest: notPrimary }), {
    disposition: 'invalid',
    reason: 'declaration'
  })
  const wrongSuffix = manifest({
    outputs: {
      ...base.outputs,
      research_qc: { ...base.outputs.research_qc, path: '${outdir}/run.qc.txt' }
    }
  })
  assert.deepEqual(await verify(h, { manifest: wrongSuffix }), {
    disposition: 'invalid',
    reason: 'declaration'
  })
  const noResults = manifest({
    outputs: { research_qc: base.outputs.research_qc }
  })
  assert.deepEqual(await verify(h, { manifest: noResults }), {
    disposition: 'invalid',
    reason: 'declaration'
  })
  assert.deepEqual(await verify(h, { params: {} }), {
    disposition: 'invalid',
    reason: 'declaration'
  })
  assert.deepEqual(await verify(h, { outDir: '' }), {
    disposition: 'invalid',
    reason: 'declaration'
  })
})

// ── verified states ───────────────────────────────────────────────────────

test('eligible: the sidecar is bound to the actual results bytes and reported sanitized', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const record = await verify(h)
  assert.deepEqual(record, {
    schemaVersion: 1,
    disposition: 'eligible',
    contrast: 'condition_treated_vs_control',
    geneIdColumn: 'gene_id',
    padjThreshold: 0.05,
    log2fcThreshold: 1,
    evaluated: 12000,
    hits: 340,
    resultMd5: md5(RESULTS),
    integrityVerified: true
  })
})

test('skip: zero valid hits still verifies integrity and completes as skip', async (t) => {
  const h = harness(t)
  writeArtifacts(h, { disposition: 'skip', hits: '0' })
  const record = await verify(h)
  assert.equal(record.disposition, 'skip')
  if (record.disposition !== 'skip') throw new Error('expected skip')
  assert.equal(record.hits, 0)
  assert.equal(record.evaluated, 12000)
  assert.equal(record.integrityVerified, true)
})

test('a sidecar declaring invalid (evaluated = hits = 0) fails with the fixed invalid record', async (t) => {
  const h = harness(t)
  writeArtifacts(h, { disposition: 'invalid', evaluated: '0', hits: '0' })
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'declared-invalid' })
})

test('a large results table is hashed by streaming, never loaded whole', async (t) => {
  const h = harness(t)
  const row = ['gene1', '2.5', '0.001'].join(TAB) + LF
  const big = row.repeat(120000)
  writeFileSync(h.resultsPath, big)
  writeFileSync(h.qcPath, sidecarText(md5(big)))
  const record = await verify(h)
  assert.equal(record.disposition, 'eligible')
  assert.equal(record.resultMd5, md5(big))
})

// ── corruption and integrity ──────────────────────────────────────────────

test('missing artifacts or output root are invalid with reason missing', async (t) => {
  const h = harness(t)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'missing' })
  writeFileSync(h.resultsPath, RESULTS)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'missing' })
  rmSync(h.resultsPath)
  writeFileSync(h.qcPath, sidecarText(md5(RESULTS)))
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'missing' })
  assert.deepEqual(await verify(h, { outDir: join(h.root, 'gone') }), {
    disposition: 'invalid',
    reason: 'missing'
  })
})

test('tampered results bytes fail the MD5 binding', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  writeFileSync(h.resultsPath, RESULTS + ['gene2', '-3', '0.02'].join(TAB) + LF)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'integrity-mismatch' })
})

test('a corrupt sidecar is malformed and never echoes its content', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  writeFileSync(h.qcPath, 'not a sidecar at all')
  const record = await verify(h)
  assert.deepEqual(record, { disposition: 'invalid', reason: 'malformed' })
  assert.equal(JSON.stringify(record).includes('not a sidecar'), false)
})

test('an oversized sidecar is malformed without being read whole', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  writeFileSync(h.qcPath, 'x'.repeat(MAX_RESEARCH_QC_SIDECAR_BYTES + 1))
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'malformed' })
})

test('invalid UTF-8 bytes are malformed', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  writeFileSync(h.qcPath, Buffer.from([255, 254, 65, 66]))
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'malformed' })
})

// ── path safety ───────────────────────────────────────────────────────────

test('symlinked artifacts are refused even when their targets are inside the root', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const realQc = join(h.outDir, 'real.qc.tsv')
  rmSync(h.qcPath)
  writeFileSync(realQc, sidecarText(md5(RESULTS)))
  symlinkSync(realQc, h.qcPath)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'unsafe-path' })

  rmSync(h.qcPath)
  writeFileSync(h.qcPath, sidecarText(md5(RESULTS)))
  const realResults = join(h.outDir, 'real.results.tsv')
  rmSync(h.resultsPath)
  writeFileSync(realResults, RESULTS)
  symlinkSync(realResults, h.resultsPath)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'unsafe-path' })
})

test('a directory in place of an artifact is refused', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  rmSync(h.qcPath)
  mkdirSync(h.qcPath)
  assert.deepEqual(await verify(h), { disposition: 'invalid', reason: 'unsafe-path' })
})

test('a declared path escaping the output root is refused before any read', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const escaped = join(h.root, 'escaped.deseq2.qc.tsv')
  writeFileSync(escaped, sidecarText(md5(RESULTS)))
  const base = manifest()
  const escaping = manifest({
    outputs: {
      ...base.outputs,
      research_qc: { ...base.outputs.research_qc, path: '${outdir}/../escaped.deseq2.qc.tsv' }
    }
  })
  assert.deepEqual(await verify(h, { manifest: escaping }), {
    disposition: 'invalid',
    reason: 'unsafe-path'
  })
})

test('a symlinked parent directory cannot smuggle the read outside the root', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const outside = join(h.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'run.deseq2.qc.tsv'), sidecarText(md5(RESULTS)))
  symlinkSync(outside, join(h.outDir, 'linkdir'))
  const base = manifest()
  const throughLink = manifest({
    outputs: {
      ...base.outputs,
      research_qc: { ...base.outputs.research_qc, path: '${outdir}/linkdir/run.deseq2.qc.tsv' }
    }
  })
  assert.deepEqual(await verify(h, { manifest: throughLink }), {
    disposition: 'invalid',
    reason: 'unsafe-path'
  })
})

// ── launch gate ───────────────────────────────────────────────────────────

test('a new local research launch is refused when the declared QC artifact already exists', async (t) => {
  const h = harness(t)
  writeArtifacts(h)
  const block = researchQcLaunchBlock({
    manifest: manifest(),
    params: h.params,
    componentDir: h.componentDir,
    live: []
  })
  assert.equal(typeof block, 'string')
  assert.match(block as string, /already exists/)
  assert.match(block as string, /fresh output directory/)
})

test('even a dangling symlink at the QC destination refuses the launch', async (t) => {
  const h = harness(t)
  symlinkSync(join(h.root, 'nowhere'), h.qcPath)
  const block = researchQcLaunchBlock({
    manifest: manifest(),
    params: h.params,
    componentDir: h.componentDir,
    live: []
  })
  assert.equal(typeof block, 'string')
})

test('a destination another live run writes to is refused; a fresh directory proceeds', async (t) => {
  const h = harness(t)
  const live = [{ manifest: manifest(), params: h.params, componentDir: h.componentDir }]
  const blocked = researchQcLaunchBlock({
    manifest: manifest(),
    params: h.params,
    componentDir: h.componentDir,
    live
  })
  assert.match(blocked as string, /another running wrapper run/)
  const fresh = researchQcLaunchBlock({
    manifest: manifest(),
    params: { outdir: join(h.root, 'fresh') },
    componentDir: h.componentDir,
    live
  })
  assert.equal(fresh, undefined)
})
test('restored completed reports fail closed when their QC has malformed content', (t) => {
  const h = harness(t)
  const runId = 'wrun_edited'
  const dir = join(getWrapperRunsDir(h.root), runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({
      runId,
      state: 'completed',
      researchQcExpected: true,
      researchQc: { disposition: 'invalid', reason: 'RAW_LOG_MARKER' }
    })
  )
  const run = readWrapperRun(runId, h.root)
  assert.equal(run?.state, 'failed')
  assert.deepEqual(run?.researchQc, { disposition: 'invalid', reason: 'malformed' })
  assert.ok(!JSON.stringify(run).includes('RAW_LOG_MARKER'))
})
