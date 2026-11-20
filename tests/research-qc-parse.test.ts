import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_RESEARCH_QC_SIDECAR_BYTES,
  RESEARCH_QC_COLUMNS,
  parseResearchQcSidecar
} from '../src/main/agent/wrappers/composition/research-qc'

const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const FAKE_MD5 = 'a'.repeat(32)

const DEFAULTS: Record<string, string> = {
  schemaVersion: '1',
  disposition: 'eligible',
  contrast: 'condition_treated_vs_control',
  geneIdColumn: 'gene_id',
  padjThreshold: '0.05',
  log2fcThreshold: '1',
  evaluated: '12000',
  hits: '340'
}

function sidecarText(overrides: Record<string, string> = {}, md5 = FAKE_MD5): string {
  const fields = { ...DEFAULTS, ...overrides }
  const record = [
    fields.schemaVersion,
    fields.disposition,
    fields.contrast,
    fields.geneIdColumn,
    fields.padjThreshold,
    fields.log2fcThreshold,
    fields.evaluated,
    fields.hits,
    md5
  ].join(TAB)
  return RESEARCH_QC_COLUMNS.join(TAB) + LF + record + LF
}

function parseOk(
  text: string
): import('../src/main/agent/wrappers/composition/research-qc').ResearchQcSidecar {
  const result = parseResearchQcSidecar(text)
  assert.equal(result.ok, true)
  return result.sidecar
}

function parseFail(text: string): string {
  const result = parseResearchQcSidecar(text)
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('expected a parse failure')
  return result.error
}

// ── the happy contract ────────────────────────────────────────────────────

test('a well-formed eligible sidecar parses into the exact sanitized summary', () => {
  const sidecar = parseOk(sidecarText())
  assert.deepEqual(sidecar, {
    schemaVersion: 1,
    disposition: 'eligible',
    contrast: 'condition_treated_vs_control',
    geneIdColumn: 'gene_id',
    padjThreshold: 0.05,
    log2fcThreshold: 1,
    evaluated: 12000,
    hits: 340,
    resultMd5: FAKE_MD5
  })
})

test('skip and invalid dispositions parse when their counts agree', () => {
  const skip = parseOk(sidecarText({ disposition: 'skip', hits: '0' }))
  assert.equal(skip.disposition, 'skip')
  assert.equal(skip.hits, 0)
  const invalid = parseOk(sidecarText({ disposition: 'invalid', evaluated: '0', hits: '0' }))
  assert.equal(invalid.disposition, 'invalid')
})

test('an advanced contrast formula is kept verbatim as the actual coefficient description', () => {
  const formula = 'condition_treated_vs_control + batch:condition'
  assert.equal(parseOk(sidecarText({ contrast: formula })).contrast, formula)
})

test('threshold boundaries are accepted: padj 1, log2fc 0, scientific notation', () => {
  const sidecar = parseOk(sidecarText({ padjThreshold: '1', log2fcThreshold: '0' }))
  assert.equal(sidecar.padjThreshold, 1)
  assert.equal(sidecar.log2fcThreshold, 0)
  assert.equal(parseOk(sidecarText({ padjThreshold: '5e-2' })).padjThreshold, 0.05)
})

test('the trailing newline is optional and an uppercase MD5 is normalized', () => {
  const text = sidecarText({}, 'ABCDEF0123456789ABCDEF0123456789')
  assert.equal(parseOk(text).resultMd5, 'abcdef0123456789abcdef0123456789')
  assert.equal(parseOk(text.slice(0, -1)).resultMd5, 'abcdef0123456789abcdef0123456789')
})

// ── structure ─────────────────────────────────────────────────────────────

test('the header must match the declared column order exactly', () => {
  const reordered = [...RESEARCH_QC_COLUMNS]
  const swapped = reordered[2]
  reordered[2] = reordered[3]
  reordered[3] = swapped
  const record = sidecarText().split(LF)[1]
  parseFail(reordered.join(TAB) + LF + record + LF)
  parseFail(RESEARCH_QC_COLUMNS.join(TAB) + LF)
  parseFail('')
})

test('exactly one header and one record: extra or missing lines fail', () => {
  const text = sidecarText()
  parseFail(text + text.split(LF)[1] + LF)
  parseFail(text + LF)
  parseFail(RESEARCH_QC_COLUMNS.join(TAB) + LF + LF)
})

test('the record must have exactly nine fields', () => {
  const header = RESEARCH_QC_COLUMNS.join(TAB)
  parseFail(header + LF + sidecarText().split(LF)[1] + TAB + 'extra' + LF)
  parseFail(header + LF + DEFAULTS.schemaVersion + TAB + DEFAULTS.disposition + LF)
})

test('quotes, CR and BOM are rejected: the format has no quoting', () => {
  parseFail(sidecarText({ contrast: 'say "hi"' }))
  parseFail(sidecarText().replace(LF, CR + LF))
  parseFail(String.fromCharCode(0xfeff) + sidecarText())
})

// ── field validation ──────────────────────────────────────────────────────

test('schemaVersion must literally be 1', () => {
  parseFail(sidecarText({ schemaVersion: '2' }))
  parseFail(sidecarText({ schemaVersion: '1.0' }))
})

test('disposition must be one of the three known values', () => {
  parseFail(sidecarText({ disposition: 'pass' }))
  parseFail(sidecarText({ disposition: '' }))
})

test('disposition must agree with evaluated/hits', () => {
  parseFail(sidecarText({ disposition: 'eligible', hits: '0' }))
  parseFail(sidecarText({ disposition: 'skip', hits: '1' }))
  parseFail(sidecarText({ disposition: 'invalid', evaluated: '5', hits: '0' }))
  parseFail(sidecarText({ disposition: 'skip', evaluated: '0', hits: '0' }))
})

test('padjThreshold must be finite and inside (0, 1]', () => {
  for (const value of ['0', '-0.1', '1.5', 'NaN', 'Infinity', 'abc', '0x10', '']) {
    parseFail(sidecarText({ padjThreshold: value }))
  }
})

test('log2fcThreshold must be finite and >= 0', () => {
  for (const value of ['-1', 'NaN', 'Infinity', 'abc', '']) {
    parseFail(sidecarText({ log2fcThreshold: value }))
  }
})

test('evaluated and hits must be non-negative safe integers with hits <= evaluated', () => {
  parseFail(sidecarText({ evaluated: '1.5' }))
  parseFail(sidecarText({ hits: '-1' }))
  parseFail(sidecarText({ evaluated: '10', hits: '11' }))
  parseFail(sidecarText({ evaluated: '9'.repeat(20) }))
  parseFail(sidecarText({ hits: '1e3' }))
})

test('resultMd5 must be a 32-character hex digest', () => {
  parseFail(sidecarText({}, 'a'.repeat(31)))
  parseFail(sidecarText({}, 'g'.repeat(32)))
  parseFail(sidecarText({}, ''))
})

test('contrast and geneIdColumn must be bounded single-line tab-free strings', () => {
  parseFail(sidecarText({ contrast: '' }))
  parseFail(sidecarText({ geneIdColumn: '' }))
  parseFail(sidecarText({ contrast: 'x'.repeat(201) }))
  parseFail(sidecarText({ geneIdColumn: 'x'.repeat(201) }))
  parseFail(sidecarText({ contrast: 'two' + String.fromCharCode(10) + 'lines' }))
  parseFail(sidecarText({ geneIdColumn: 'col' + String.fromCharCode(0x0b) + 'x' }))
})

test('an oversized sidecar is refused without reading it whole', () => {
  parseFail('x'.repeat(MAX_RESEARCH_QC_SIDECAR_BYTES + 1))
})

// ── no raw values on failure ──────────────────────────────────────────────

test('parse errors are fixed strings that never echo file content', () => {
  const secret = 'RAWSECRET'
  const error = parseFail(sidecarText({ contrast: secret.repeat(40) }))
  assert.equal(error.includes(secret), false)
  const badMd5 = parseFail(sidecarText({}, secret))
  assert.equal(badMd5.includes(secret), false)
  const badNumber = parseFail(sidecarText({ padjThreshold: secret }))
  assert.equal(badNumber.includes(secret), false)
})
