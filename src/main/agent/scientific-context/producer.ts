import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import { isRecord } from '../../../shared/guards'
import {
  MATRIX_VALUE_SEMANTICS,
  declaredValue,
  observedValue,
  unknownValue,
  type MatrixValueSemantics,
  type ProvenancedValue,
  type ScientificContextSidecar,
  type ScientificMatrixContext,
  type ScientificReferenceInfo,
  type ScientificSampleContext
} from '../../../shared/scientificContextTypes'
import type { WrapperOutputScientificContext } from '../../../shared/wrapperCompositionManifestTypes'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import type { WrapperOutputRecord } from '../wrappers/types'
import { writeRemoteScientificContextSidecar } from './remote-sidecar'
import { writeScientificContextSidecar } from './sidecar'

const ALLOWED_SEMANTICS = new Set<string>(MATRIX_VALUE_SEMANTICS)
const DONOR_COLUMNS = [
  'donor',
  'donor_id',
  'patient',
  'patient_id',
  'subject',
  'subject_id',
  'source_sample'
]

function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function findSampleColumnIndex(lowerHeader: string[], explicitSampleCol?: string): number {
  if (explicitSampleCol) {
    const explicitIdx = lowerHeader.indexOf(explicitSampleCol.trim().toLowerCase())
    if (explicitIdx >= 0) return explicitIdx
  }
  return lowerHeader.findIndex((col) => col === 'sample' || col === 'sample_id')
}

function collectSheetSamplesAndDonors(
  dataLines: string[],
  delimiter: string,
  sampleIdx: number,
  donorIdx: number
): { sampleIds: string[]; donorBySample?: Record<string, string> } {
  const sampleIds: string[] = []
  const donorBySample: Record<string, string> = {}
  let hasCompleteDonors = donorIdx >= 0

  for (const line of dataLines) {
    const cols = line.split(delimiter).map((col) => col.trim().replace(/^"|"$/g, ''))
    const sampleId = cols[sampleIdx] ?? ''
    if (!sampleId) continue
    if (!sampleIds.includes(sampleId)) sampleIds.push(sampleId)
    if (donorIdx >= 0) {
      const donorId = cols[donorIdx] ?? ''
      if (donorId) donorBySample[sampleId] = donorId
      else hasCompleteDonors = false
    }
  }
  return {
    sampleIds,
    ...(hasCompleteDonors && Object.keys(donorBySample).length > 0 ? { donorBySample } : {})
  }
}

function parseSamplesheetCsvText(
  csvText: string,
  sourceLabel: string,
  explicitSampleCol?: string
): ProvenancedValue<ScientificSampleContext> | undefined {
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length < 2) return undefined
  const delimiter = lines[0].includes('\t') && !lines[0].includes(',') ? '\t' : ','
  const lowerHeader = lines[0]
    .split(delimiter)
    .map((col) => col.trim().replace(/^"|"$/g, '').toLowerCase())
  const sampleIdx = findSampleColumnIndex(lowerHeader, explicitSampleCol)
  if (sampleIdx < 0) return undefined
  const donorIdx = lowerHeader.findIndex((col) => DONOR_COLUMNS.includes(col))
  const collected = collectSheetSamplesAndDonors(lines.slice(1), delimiter, sampleIdx, donorIdx)
  return collected.sampleIds.length > 0 ? observedValue(collected, sourceLabel) : undefined
}

function readTrimmedStringParam(params: Record<string, unknown>, key?: string): string | undefined {
  if (!key) return undefined
  const val = params[key]
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined
}

function resolveWrapperSamplesContext(
  decl: WrapperOutputScientificContext,
  params: Record<string, unknown>,
  readSamplesheet?: (paramValue: string) => string | undefined
): ProvenancedValue<ScientificSampleContext> {
  const sheetPath = readTrimmedStringParam(params, decl.samplesheetParam)
  if (!sheetPath || !readSamplesheet) return unknownValue('samplesheet not inspected')
  const text = readSamplesheet(sheetPath)
  if (!text) return unknownValue('samplesheet not inspected')
  const sampleIdCol = readTrimmedStringParam(params, 'sample_id_col')
  return (
    parseSamplesheetCsvText(text, `samplesheet:${decl.samplesheetParam}`, sampleIdCol) ??
    unknownValue('samplesheet not inspected')
  )
}

function buildWrapperContextFields(
  wrapperId: string,
  decl: WrapperOutputScientificContext,
  params: Record<string, unknown>,
  readSamplesheet?: (paramValue: string) => string | undefined
): {
  organism: ProvenancedValue<string>
  reference: ProvenancedValue<ScientificReferenceInfo>
  samples: ProvenancedValue<ScientificSampleContext>
  matrix: ProvenancedValue<ScientificMatrixContext>
} {
  const paramOrigin = `wrapper_param:${wrapperId}`
  const manifestOrigin = `wrapper_manifest:${wrapperId}`

  const orgStr = readTrimmedStringParam(params, decl.organismParam)
  const organism: ProvenancedValue<string> = orgStr
    ? declaredValue(orgStr, paramOrigin)
    : unknownValue('organism not supplied')

  const refStr = readTrimmedStringParam(params, decl.referenceAssemblyParam)
  const reference: ProvenancedValue<ScientificReferenceInfo> = refStr
    ? declaredValue({ assembly: refStr }, paramOrigin)
    : unknownValue('reference assembly not supplied')

  const samples = resolveWrapperSamplesContext(decl, params, readSamplesheet)

  const matrix: ProvenancedValue<ScientificMatrixContext> = decl.valueSemantics
    ? declaredValue(
        {
          valueSemantics: decl.valueSemantics,
          ...(decl.rowIdType ? { rowIdType: decl.rowIdType } : {})
        },
        manifestOrigin
      )
    : unknownValue('matrix valueSemantics not declared')

  return { organism, reference, samples, matrix }
}

/**
 * Host-bound `.phi-context.json` sidecar emission for completed local Wrapper runs.
 * Computes real SHA-256 on disk and stamps the verified wrapper run identity.
 */
export function emitLocalWrapperOutputSidecars(input: {
  wrapperId: string
  runId: string
  outputs: readonly WrapperOutputRecord[]
  declarationsByOutputId: Readonly<Record<string, WrapperOutputScientificContext | undefined>>
  params: Record<string, unknown>
  baseDir?: string
}): ScientificContextSidecar[] {
  const written: ScientificContextSidecar[] = []
  const readSheet = (sheetPath: string): string | undefined => {
    try {
      const abs = isAbsolute(sheetPath)
        ? sheetPath
        : input.baseDir
          ? resolve(input.baseDir, sheetPath)
          : resolve(sheetPath)
      if (!existsSync(abs) || !lstatSync(abs).isFile()) return undefined
      return readFileSync(abs, 'utf-8')
    } catch {
      return undefined
    }
  }

  for (const out of input.outputs) {
    if (!out.exists || out.location !== 'local') continue
    const decl = input.declarationsByOutputId[out.id]
    if (!decl) continue
    try {
      if (!existsSync(out.path) || !lstatSync(out.path).isFile()) continue
      const fields = buildWrapperContextFields(input.wrapperId, decl, input.params, readSheet)
      written.push(
        writeScientificContextSidecar(out.path, {
          producer: { kind: 'wrapper', id: input.wrapperId, runId: input.runId },
          location: 'local',
          path: out.path,
          hashLocalBytes: true,
          ...fields
        })
      )
    } catch {
      // Best-effort sidecar emission: missing sidecar safely degrades to `unknown` downstream.
    }
  }
  return written
}

async function fetchCachedRemoteSheet(
  session: RemoteSshSession,
  decl: WrapperOutputScientificContext,
  params: Record<string, unknown>,
  cache: Map<string, string | undefined>
): Promise<string | undefined> {
  const sheetParam = decl.samplesheetParam ? params[decl.samplesheetParam] : undefined
  if (typeof sheetParam !== 'string' || !sheetParam.trim()) return undefined
  const key = sheetParam.trim()
  if (!cache.has(key)) {
    const content = await session.readTextFile(key).catch(() => undefined)
    cache.set(key, content)
  }
  return cache.get(key)
}

/**
 * Host-bound `.phi-context.json` sidecar emission for completed SSH/Slurm remote Wrapper runs.
 * Computes real SHA-256 on the remote host and writes `<output>.phi-context.json` remotely.
 */
export async function emitRemoteWrapperOutputSidecars(input: {
  session: RemoteSshSession
  host: string
  remoteRootDir?: string
  wrapperId: string
  runId: string
  outputs: readonly WrapperOutputRecord[]
  declarationsByOutputId: Readonly<Record<string, WrapperOutputScientificContext | undefined>>
  params: Record<string, unknown>
}): Promise<ScientificContextSidecar[]> {
  const written: ScientificContextSidecar[] = []
  const sheetCache = new Map<string, string | undefined>()

  for (const out of input.outputs) {
    if (!out.exists || out.location !== 'remote') continue
    const decl = input.declarationsByOutputId[out.id]
    if (!decl) continue
    try {
      const sheetText = await fetchCachedRemoteSheet(input.session, decl, input.params, sheetCache)
      const fields = buildWrapperContextFields(input.wrapperId, decl, input.params, () => sheetText)
      written.push(
        await writeRemoteScientificContextSidecar(input.session, out.path, {
          producer: { kind: 'wrapper', id: input.wrapperId, runId: input.runId },
          host: input.host,
          path: out.path,
          hashRemoteBytes: true,
          remoteRootDir: input.remoteRootDir,
          ...fields
        })
      )
    } catch {
      // Best-effort remote sidecar write; downstream preflight treats absence as `unknown`.
    }
  }
  return written
}

function parseDonorMap(rawDonor: unknown): Record<string, string> | undefined {
  if (!isRecord(rawDonor)) return undefined
  const cleanMap: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawDonor)) {
    if (typeof v === 'string' && v.trim().length > 0) cleanMap[k] = v.trim()
  }
  return Object.keys(cleanMap).length > 0 ? cleanMap : undefined
}

function parseScriptSamples(
  raw: Record<string, unknown>,
  source: string
): ProvenancedValue<ScientificSampleContext> {
  if (
    !Array.isArray(raw.sampleIds) ||
    raw.sampleIds.length === 0 ||
    !raw.sampleIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    return unknownValue('not reported by script tool')
  }
  const sampleIds = [...new Set(raw.sampleIds.map((id: string) => id.trim()))]
  const donorBySample = parseDonorMap(raw.donorBySample)
  return observedValue({ sampleIds, ...(donorBySample ? { donorBySample } : {}) }, source)
}

function parseScriptReference(
  raw: Record<string, unknown>,
  source: string
): ProvenancedValue<ScientificReferenceInfo> {
  if (typeof raw.referenceAssembly !== 'string' || !raw.referenceAssembly.trim()) {
    return unknownValue('not reported by script tool')
  }
  const annotation =
    typeof raw.referenceAnnotation === 'string' && raw.referenceAnnotation.trim()
      ? raw.referenceAnnotation.trim()
      : undefined
  return declaredValue(
    { assembly: raw.referenceAssembly.trim(), ...(annotation ? { annotation } : {}) },
    source
  )
}

function parseScriptMatrix(
  raw: Record<string, unknown>,
  source: string
): ProvenancedValue<ScientificMatrixContext> {
  if (typeof raw.valueSemantics !== 'string' || !ALLOWED_SEMANTICS.has(raw.valueSemantics)) {
    return unknownValue('not reported by script tool')
  }
  const rowIdType =
    typeof raw.rowIdType === 'string' && raw.rowIdType.trim() ? raw.rowIdType.trim() : undefined
  return declaredValue(
    {
      valueSemantics: raw.valueSemantics as MatrixValueSemantics,
      ...(rowIdType ? { rowIdType } : {})
    },
    source
  )
}

function parseScriptContextEntry(
  raw: Record<string, unknown>,
  source: string
): {
  organism: ProvenancedValue<string>
  reference: ProvenancedValue<ScientificReferenceInfo>
  samples: ProvenancedValue<ScientificSampleContext>
  matrix: ProvenancedValue<ScientificMatrixContext>
} {
  const organism: ProvenancedValue<string> =
    typeof raw.organism === 'string' && raw.organism.trim().length > 0
      ? declaredValue(raw.organism.trim(), source)
      : unknownValue('not reported by script tool')
  return {
    organism,
    reference: parseScriptReference(raw, source),
    samples: parseScriptSamples(raw, source),
    matrix: parseScriptMatrix(raw, source)
  }
}

function resolveContainedRegularFile(
  realProjectRoot: string,
  rawPath: string
): { ok: true; realTarget: string } | { ok: false; warning: string } {
  if (!isAbsolute(rawPath) && rawPath.split(/[\\/]+/).includes('..')) {
    return {
      ok: false,
      warning: `scientificContext["${rawPath}"] refused: must not contain parent traversal`
    }
  }
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(realProjectRoot, rawPath)
  if (!withinRoot(candidate, realProjectRoot)) {
    return {
      ok: false,
      warning: `scientificContext["${rawPath}"] refused: escapes project root`
    }
  }
  const stats = lstatSync(candidate)
  if (!stats.isFile()) {
    return {
      ok: false,
      warning: `scientificContext["${rawPath}"] skipped: target is not a regular file`
    }
  }
  const realTarget = realpathSync(candidate)
  if (!withinRoot(realTarget, realProjectRoot)) {
    return {
      ok: false,
      warning: `scientificContext["${rawPath}"] refused: symlink escapes project root`
    }
  }
  return { ok: true, realTarget }
}

/**
 * Host-bound `.phi-context.json` sidecar emission for write-approved plugin/skill script tools.
 * Strictly enforces containment inside `projectDir` (rejecting `..` and symlink escapes),
 * ignores any script-supplied hashes or producer claims, and computes real SHA-256 on disk.
 */
export function emitScriptToolOutputSidecars(input: {
  projectDir: string
  toolName: string
  envId: string
  rawContextMap: unknown
}): { writtenPaths: string[]; warnings: string[] } {
  const writtenPaths: string[] = []
  const warnings: string[] = []
  if (!isRecord(input.rawContextMap)) return { writtenPaths, warnings }

  let realProjectRoot: string
  try {
    realProjectRoot = realpathSync(resolve(input.projectDir))
  } catch {
    return {
      writtenPaths,
      warnings: ['project directory could not be resolved for scientificContext']
    }
  }

  const source = `script_tool:${input.toolName}`
  for (const [rawRelPath, entry] of Object.entries(input.rawContextMap)) {
    if (!isRecord(entry)) {
      warnings.push(`scientificContext["${rawRelPath}"] ignored: must be an object`)
      continue
    }
    try {
      const checked = resolveContainedRegularFile(realProjectRoot, rawRelPath)
      if (!checked.ok) {
        warnings.push(checked.warning)
        continue
      }
      const fields = parseScriptContextEntry(entry, source)
      writeScientificContextSidecar(checked.realTarget, {
        producer: { kind: 'plan_step', id: input.toolName, runId: input.envId },
        location: 'local',
        path: checked.realTarget,
        hashLocalBytes: true,
        ...fields
      })
      writtenPaths.push(rawRelPath)
    } catch (error) {
      warnings.push(
        `scientificContext["${rawRelPath}"] failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { writtenPaths, warnings }
}
