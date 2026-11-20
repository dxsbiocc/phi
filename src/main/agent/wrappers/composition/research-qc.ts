import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

import { isRecord } from '../../../../shared/guards'
import type {
  ResearchInputQuestion,
  ResearchQcInvalidReason,
  WrapperResearchQc
} from '../../../../shared/wrapperResearchQcTypes'
import { researchUserQuestion } from '../../agents/research-handoff'
import type { WrapperCompositionManifest } from './manifest'
import { resolveOutputPaths } from './validate'

/**
 * Host-side binding of the research QC sidecar contract. The sidecar is a
 * UTF-8 TSV with exactly one header and one record (no quotes), columns in
 * this exact order. The host parses it strictly, hashes the declared primary
 * results by streaming (never loading the table), and only then reports the
 * package's verdict. Every failure maps to a fixed reason code; raw file
 * content is never echoed into errors, status or persisted summaries.
 */

export const RESEARCH_QC_OUTPUT_ID = 'research_qc'
export const RESEARCH_QC_RESULTS_ID = 'results'
export const RESEARCH_QC_PATH_SUFFIX = '.deseq2.qc.tsv'

export const RESEARCH_INPUT_OUTPUT_ID = 'research_input'
export const RESEARCH_INPUT_PATH_SUFFIX = '.deseq2.input.json'
export const MAX_RESEARCH_INPUT_BYTES = 8 * 1024

export const RESEARCH_QC_COLUMNS = [
  'schemaVersion',
  'disposition',
  'contrast',
  'geneIdColumn',
  'padjThreshold',
  'log2fcThreshold',
  'evaluated',
  'hits',
  'resultMd5'
] as const

export const MAX_RESEARCH_QC_SIDECAR_BYTES = 64 * 1024
const MAX_FIELD_CHARS = 200
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const COUNT = /^\d+$/
const MD5 = /^[0-9a-fA-F]{32}$/

// Named instead of escape sequences so no raw control character sits in this source.
const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const BOM = String.fromCharCode(0xfeff)
const QUOTE = String.fromCharCode(34)

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export interface ResearchQcSidecar {
  schemaVersion: 1
  disposition: 'eligible' | 'skip' | 'invalid'
  contrast: string
  geneIdColumn: string
  padjThreshold: number
  log2fcThreshold: number
  evaluated: number
  hits: number
  resultMd5: string
}

export type ResearchQcParseResult =
  { ok: true; sidecar: ResearchQcSidecar } | { ok: false; error: string }

function boundedSingleLine(value: string): boolean {
  return (
    value.trim().length >= 1 &&
    value.length <= MAX_FIELD_CHARS &&
    !/[\u2028\u2029]/u.test(value) &&
    !hasControlChars(value)
  )
}

function parseNumber(value: string): number | undefined {
  if (!NUMBER.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseCount(value: string): number | undefined {
  if (!COUNT.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Strict parse of the sidecar text. Errors are fixed strings: nothing read
 * from the file is ever echoed back, so a corrupt or hostile sidecar cannot
 * inject content into status, notices or prompts.
 */
export function parseResearchQcSidecar(text: string): ResearchQcParseResult {
  const fail = (error: string): ResearchQcParseResult => ({ ok: false, error })
  if (text.length > MAX_RESEARCH_QC_SIDECAR_BYTES) {
    return fail('research QC sidecar exceeds the bounded size')
  }
  if (text.startsWith(BOM) || text.includes(CR) || text.includes(QUOTE)) {
    return fail('research QC sidecar must be plain UTF-8 TSV without BOM, CR or quotes')
  }
  const body = text.endsWith(LF) ? text.slice(0, -1) : text
  const lines = body.split(LF)
  if (lines.length !== 2 || lines[0].length === 0 || lines[1].length === 0) {
    return fail('research QC sidecar must have exactly one header line and one record line')
  }
  const header = lines[0].split(TAB)
  if (
    header.length !== RESEARCH_QC_COLUMNS.length ||
    RESEARCH_QC_COLUMNS.some((column, index) => header[index] !== column)
  ) {
    return fail('research QC sidecar header does not match the declared column order')
  }
  const fields = lines[1].split(TAB)
  if (fields.length !== RESEARCH_QC_COLUMNS.length) {
    return fail('research QC sidecar record must have exactly 9 tab-separated fields')
  }
  const [
    schemaVersion,
    disposition,
    contrast,
    geneIdColumn,
    padjRaw,
    log2fcRaw,
    evaluatedRaw,
    hitsRaw,
    resultMd5Raw
  ] = fields
  if (schemaVersion !== '1') return fail('research QC sidecar schemaVersion must be 1')
  if (disposition !== 'eligible' && disposition !== 'skip' && disposition !== 'invalid') {
    return fail('research QC sidecar disposition must be eligible, skip or invalid')
  }
  if (!boundedSingleLine(contrast)) {
    return fail('research QC sidecar contrast must be a bounded single-line tab-free string')
  }
  if (!boundedSingleLine(geneIdColumn)) {
    return fail('research QC sidecar geneIdColumn must be a bounded single-line tab-free string')
  }
  const padjThreshold = parseNumber(padjRaw)
  if (padjThreshold === undefined || padjThreshold <= 0 || padjThreshold > 1) {
    return fail('research QC sidecar padjThreshold must be a finite number in (0, 1]')
  }
  const log2fcThreshold = parseNumber(log2fcRaw)
  if (log2fcThreshold === undefined || log2fcThreshold < 0) {
    return fail('research QC sidecar log2fcThreshold must be a finite number >= 0')
  }
  const evaluated = parseCount(evaluatedRaw)
  const hits = parseCount(hitsRaw)
  if (evaluated === undefined || hits === undefined || hits > evaluated) {
    return fail(
      'research QC sidecar evaluated and hits must be non-negative safe integers with hits <= evaluated'
    )
  }
  const consistent =
    disposition === 'eligible'
      ? evaluated > 0 && hits > 0
      : disposition === 'skip'
        ? evaluated > 0 && hits === 0
        : evaluated === 0 && hits === 0
  if (!consistent) {
    return fail('research QC sidecar disposition does not match evaluated/hits')
  }
  if (!MD5.test(resultMd5Raw)) {
    return fail('research QC sidecar resultMd5 must be a 32-character hex MD5')
  }
  return {
    ok: true,
    sidecar: {
      schemaVersion: 1,
      disposition,
      contrast,
      geneIdColumn,
      padjThreshold,
      log2fcThreshold,
      evaluated,
      hits,
      resultMd5: resultMd5Raw.toLowerCase()
    }
  }
}

/** True when the wrapper declares the research QC output by id and type. */
export function declaresResearchQc(manifest: WrapperCompositionManifest): boolean {
  const output = manifest.outputs[RESEARCH_QC_OUTPUT_ID]
  return output !== undefined && output.type === RESEARCH_QC_OUTPUT_ID
}

function invalid(reason: ResearchQcInvalidReason): WrapperResearchQc {
  return { disposition: 'invalid', reason }
}

function withinRoot(path: string, root: string): boolean {
  return path.startsWith(root + sep)
}

/**
 * The artifact must lexically sit inside the declared output root, be a
 * regular file (lstat: a symlink is refused even if its target is inside),
 * and its real path must stay inside the root's real path so a symlinked
 * parent directory cannot smuggle the read outside.
 */
async function checkContainedRegularFile(
  path: string,
  root: string,
  realRoot: string
): Promise<ResearchQcInvalidReason | undefined> {
  const absolute = resolve(path)
  if (!withinRoot(absolute, root)) return 'unsafe-path'
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  if (!stats.isFile()) return 'unsafe-path'
  let real
  try {
    real = await realpath(absolute)
  } catch {
    return 'unreadable'
  }
  if (!withinRoot(real, realRoot)) return 'unsafe-path'
  return undefined
}

class ResearchQcMalformedError extends Error {}

/** Reads at most `maxBytes`; anything larger is malformed, never loaded whole. */
async function readBoundedUtf8(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buffer = Buffer.alloc(8192)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new ResearchQcMalformedError('sidecar too large')
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks)
      )
    } catch {
      throw new ResearchQcMalformedError('sidecar is not valid UTF-8')
    }
  } finally {
    await handle.close()
  }
}

/** MD5 of the exact file bytes, streamed so the results table is never held in memory. */
async function streamMd5(path: string): Promise<string> {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Binds the declared sidecar to the declared primary results and returns the
 * sanitized verdict. Local runs only; any missing, malformed, unsafe or
 * mismatched artifact yields a fixed invalid record, never raw content.
 */
export async function verifyResearchQcArtifacts(input: {
  manifest: WrapperCompositionManifest
  params: Record<string, unknown>
  componentDir: string
  /** The run's declared local output root; both artifacts must live inside it. */
  outDir: string
}): Promise<WrapperResearchQc> {
  const qcDeclaration = input.manifest.outputs[RESEARCH_QC_OUTPUT_ID]
  const resultsDeclaration = input.manifest.outputs[RESEARCH_QC_RESULTS_ID]
  if (
    !qcDeclaration ||
    qcDeclaration.type !== RESEARCH_QC_OUTPUT_ID ||
    qcDeclaration.primary !== true ||
    !qcDeclaration.path.endsWith(RESEARCH_QC_PATH_SUFFIX) ||
    resultsDeclaration?.primary !== true ||
    !input.outDir
  ) {
    return invalid('declaration')
  }
  const resolved = resolveOutputPaths(input.manifest, input.params, input.componentDir)
  const qc = resolved.find((output) => output.id === RESEARCH_QC_OUTPUT_ID)
  const results = resolved.find((output) => output.id === RESEARCH_QC_RESULTS_ID)
  if (!qc || !results) return invalid('declaration')
  const root = resolve(input.outDir)
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return invalid('missing')
  }
  for (const artifact of [qc, results]) {
    const problem = await checkContainedRegularFile(artifact.absolutePath, root, realRoot)
    if (problem) return invalid(problem)
  }
  let text: string
  try {
    text = await readBoundedUtf8(qc.absolutePath, MAX_RESEARCH_QC_SIDECAR_BYTES)
  } catch (error) {
    return invalid(error instanceof ResearchQcMalformedError ? 'malformed' : 'unreadable')
  }
  const parsed = parseResearchQcSidecar(text)
  if (!parsed.ok) return invalid('malformed')
  const qcReport = parsed.sidecar
  const params = input.params
  const expectedContrast =
    typeof params.formula === 'string' && params.formula
      ? typeof params.comparison === 'string'
        ? `${params.formula} | ${params.comparison}`
        : undefined
      : typeof params.target_level === 'string' && typeof params.reference_level === 'string'
        ? `${params.target_level} vs ${params.reference_level}`
        : undefined
  if (
    (expectedContrast !== undefined && qcReport.contrast !== expectedContrast) ||
    (params.gene_id_col !== undefined && qcReport.geneIdColumn !== params.gene_id_col) ||
    (params.padj_threshold !== undefined && qcReport.padjThreshold !== params.padj_threshold) ||
    (params.log2fc_threshold !== undefined && qcReport.log2fcThreshold !== params.log2fc_threshold)
  ) {
    return invalid('integrity-mismatch')
  }
  let md5: string
  try {
    md5 = await streamMd5(results.absolutePath)
  } catch {
    return invalid('unreadable')
  }
  if (md5 !== parsed.sidecar.resultMd5) return invalid('integrity-mismatch')
  if (parsed.sidecar.disposition === 'invalid') return invalid('declared-invalid')
  return { ...parsed.sidecar, disposition: parsed.sidecar.disposition, integrityVerified: true }
}

/**
 * Optional research_input artifact: the static domain question a wrapper
 * publishes when it stops before inference. Only the declared id/type/suffix
 * is honored, the file must sit safely inside the run's output root, and the
 * payload must pass the bounded question validator. Any doubt — missing,
 * unsafe, oversized, malformed — yields undefined (fail closed); raw content
 * is never echoed.
 */
export async function readResearchInputQuestion(input: {
  manifest: WrapperCompositionManifest
  params: Record<string, unknown>
  componentDir: string
  outDir: string
}): Promise<ResearchInputQuestion | undefined> {
  const declaration = input.manifest.outputs[RESEARCH_INPUT_OUTPUT_ID]
  if (
    !declaration ||
    declaration.type !== RESEARCH_INPUT_OUTPUT_ID ||
    !declaration.path.endsWith(RESEARCH_INPUT_PATH_SUFFIX) ||
    !input.outDir
  ) {
    return undefined
  }
  const resolved = resolveOutputPaths(input.manifest, input.params, input.componentDir)
  const artifact = resolved.find((output) => output.id === RESEARCH_INPUT_OUTPUT_ID)
  if (!artifact) return undefined
  const root = resolve(input.outDir)
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return undefined
  }
  if (await checkContainedRegularFile(artifact.absolutePath, root, realRoot)) return undefined
  let text: string
  try {
    text = await readBoundedUtf8(artifact.absolutePath, MAX_RESEARCH_INPUT_BYTES)
  } catch {
    return undefined
  }
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(stored) || stored.schemaVersion !== 1) return undefined
  const keys = Object.keys(stored)
  if (keys.length !== 2 || !keys.includes('question')) return undefined
  return researchUserQuestion(stored.question)
}

function pathOccupied(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// Resolve aliases even when the final directories have not been created yet.
function destinationKey(path: string): string {
  const suffix: string[] = []
  let cursor = path
  while (dirname(cursor) !== cursor && !pathOccupied(cursor)) {
    suffix.push(basename(cursor))
    cursor = dirname(cursor)
  }
  return resolve(realpathSync(cursor), ...suffix.reverse())
}

/**
 * Launch gate for local research runs, applied before any persistence or
 * mutation: an existing declared QC or research_input artifact means stale
 * results or a stale question could be reused, and a destination another live
 * run already writes to must not be overwritten. Returns a fixed refusal
 * message, or undefined to proceed.
 */
export function researchQcLaunchBlock(input: {
  manifest: WrapperCompositionManifest
  params: Record<string, unknown>
  componentDir: string
  live: ReadonlyArray<{
    manifest: WrapperCompositionManifest
    params: Record<string, unknown>
    componentDir: string
  }>
}): string | undefined {
  const gated = declaresResearchQc(input.manifest)
  const competing = gated
    ? input.live
    : input.live.filter((job) => declaresResearchQc(job.manifest))
  if (!gated && !competing.length) return undefined
  const outputs = resolveOutputPaths(input.manifest, input.params, input.componentDir)
  const qc = outputs.find(
    (output) =>
      (output.primary || output.id === RESEARCH_INPUT_OUTPUT_ID) &&
      pathOccupied(output.absolutePath)
  )
  if (gated && qc) {
    return (
      `Refusing to launch: a declared research output already exists (${qc.absolutePath}). ` +
      'Choose a fresh output directory so stale results cannot be reused.'
    )
  }
  const destinations = new Set(outputs.map((output) => destinationKey(output.absolutePath)))
  for (const job of competing) {
    for (const other of resolveOutputPaths(job.manifest, job.params, job.componentDir)) {
      if (destinations.has(destinationKey(other.absolutePath))) {
        return (
          `Refusing to launch: another running wrapper run already writes to ${other.absolutePath}. ` +
          'Choose a different output directory.'
        )
      }
    }
  }
  return undefined
}
export async function localResearchOutcome(
  entry: { manifest: WrapperCompositionManifest; componentDir: string },
  params: Record<string, unknown>,
  outDir: string,
  outcome: string,
  exitCode: number,
  missing: readonly string[]
): Promise<WrapperResearchQc | undefined> {
  const input = { manifest: entry.manifest, componentDir: entry.componentDir, params, outDir }
  if (outcome === 'completed') return verifyResearchQcArtifacts(input)
  if (outcome !== 'failed') return undefined
  if (exitCode === 0 && missing.length) return invalid('missing')
  if (exitCode === 0) return undefined
  const question = await readResearchInputQuestion(input)
  return question ? { disposition: 'needs_input', question } : undefined
}

const invalidReasons: readonly ResearchQcInvalidReason[] = [
  'declaration',
  'missing',
  'unsafe-path',
  'unreadable',
  'malformed',
  'integrity-mismatch',
  'declared-invalid'
]

/** Project and bound persisted JSON before handing it to a resumed conversation. */
export function restoreResearchQc(value: unknown): WrapperResearchQc {
  if (!isRecord(value)) return invalid('malformed')
  if (value.disposition === 'needs_input') {
    const question = researchUserQuestion(value.question)
    return question ? { disposition: 'needs_input', question } : invalid('malformed')
  }
  if (value.disposition === 'invalid') {
    return invalid(invalidReasons.find((reason) => reason === value.reason) ?? 'malformed')
  }
  if (
    value.integrityVerified !== true ||
    value.schemaVersion !== 1 ||
    typeof value.contrast !== 'string' ||
    typeof value.geneIdColumn !== 'string' ||
    typeof value.resultMd5 !== 'string' ||
    ![value.padjThreshold, value.log2fcThreshold, value.evaluated, value.hits].every(
      (n) => typeof n === 'number'
    ) ||
    (value.disposition !== 'eligible' && value.disposition !== 'skip')
  )
    return invalid('malformed')
  const fields = RESEARCH_QC_COLUMNS.map((key) => value[key])
  const parsed = parseResearchQcSidecar(RESEARCH_QC_COLUMNS.join(TAB) + LF + fields.join(TAB))
  if (!parsed.ok || parsed.sidecar.disposition === 'invalid') return invalid('malformed')
  return { ...parsed.sidecar, disposition: parsed.sidecar.disposition, integrityVerified: true }
}
