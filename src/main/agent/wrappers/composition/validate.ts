import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { verifyFileContentAssertion } from '../../verification/output-assertions'
import type { WrapperCompositionManifest, WrapperCompositionParam } from './manifest'

/**
 * Light validation from resources/skills/create-wrapper/references/guide.md
 * section 5: required params, simple type/enum/range checks, local input
 * path existence, and primary-output existence after a run. Deliberately
 * shallow — Nextflow itself is the authority on channel semantics.
 */

const GLOB_CHARS = /[*?{[]/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function checkType(
  key: string,
  param: WrapperCompositionParam,
  value: unknown
): string | undefined {
  if (param.type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value)
      ? undefined
      : `${key} must be an integer`
  }
  if (param.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? undefined
      : `${key} must be a number`
  }
  if (param.type === 'boolean') {
    return typeof value === 'boolean' ? undefined : `${key} must be a boolean`
  }
  return typeof value === 'string' ? undefined : `${key} must be a string`
}

function checkConstraints(
  key: string,
  param: WrapperCompositionParam,
  value: unknown
): string | undefined {
  if (param.enum && !param.enum.includes(String(value))) {
    return `${key} must be one of: ${param.enum.join(', ')}`
  }
  if (typeof value === 'number') {
    if (param.minimum !== undefined && value < param.minimum) {
      return `${key} must be >= ${param.minimum}`
    }
    if (param.maximum !== undefined && value > param.maximum) {
      return `${key} must be <= ${param.maximum}`
    }
  }
  return undefined
}

function checkInputPath(
  key: string,
  param: WrapperCompositionParam,
  value: unknown,
  componentDir: string
): string | undefined {
  if (param.kind !== 'input' || typeof value !== 'string') return undefined
  if (URL_SCHEME.test(value) || GLOB_CHARS.test(value) || value.includes('${')) return undefined
  const full = isAbsolute(value) ? value : resolve(componentDir, value)
  return existsSync(full) ? undefined : `${key}: input path does not exist: ${value}`
}

/**
 * Nextflow's `fromFilePairs` names each sample by the file name up to the first
 * `{` or `[` of the glob. A brace or bracket before the last `*` of the file-name
 * part (`L1{04,05}-*_R{1,2}.fq.gz`) therefore gives every file the same sample
 * name and merges the samples — so reject it here, before anything is launched.
 */
function checkPairGlob(
  key: string,
  param: WrapperCompositionParam,
  value: unknown
): string | undefined {
  if (param.type !== 'fastq_glob' || typeof value !== 'string') return undefined
  const fileName = value.slice(value.lastIndexOf('/') + 1)
  const lastStar = fileName.lastIndexOf('*')
  const firstGroup = fileName.search(/[{[]/)
  if (lastStar < 0 || firstGroup < 0 || firstGroup > lastStar) return undefined
  return (
    `${key}: "${fileName}" would merge several samples into one sample. Nextflow names a sample by the ` +
    'file name up to the first { or [, so braces or brackets before the last * merge samples. ' +
    'Use a glob such as /data/*_R{1,2}.fastq.gz, or start one run per group of samples.'
  )
}

/**
 * Validates the merge of a wrapper's default params and the agent's
 * overrides. `componentDir` is the directory Nextflow is launched from, so
 * relative input paths resolve against it. Returns human-readable errors;
 * an empty array means the run may proceed.
 */
export function validateWrapperParams(
  manifest: WrapperCompositionManifest,
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
  componentDir: string,
  /** `false` for a run on another machine, where a local path check would be meaningless. */
  options: { checkInputPaths?: boolean } = {}
): string[] {
  const checkInputPaths = options.checkInputPaths ?? true
  const merged = { ...defaults, ...overrides }
  const errors: string[] = []

  const known = new Set([...Object.keys(manifest.params), ...Object.keys(defaults)])
  for (const key of Object.keys(overrides)) {
    if (!known.has(key)) {
      errors.push(
        `Unknown parameter: ${key}. Declared parameters: ${Object.keys(manifest.params).join(', ')}`
      )
    }
  }

  for (const [key, param] of Object.entries(manifest.params)) {
    const value = merged[key]
    if (isMissing(value)) {
      if (param.required) errors.push(`Missing required parameter: ${key}`)
      continue
    }
    const problem =
      checkType(key, param, value) ??
      checkConstraints(key, param, value) ??
      checkPairGlob(key, param, value) ??
      (checkInputPaths ? checkInputPath(key, param, value, componentDir) : undefined)
    if (problem) errors.push(problem)
  }

  return errors
}

function interpolate(template: string, params: Record<string, unknown>): string | undefined {
  let unresolved = false
  const result = template.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name]
    if (isMissing(value)) {
      unresolved = true
      return ''
    }
    return String(value)
  })
  return unresolved ? undefined : result
}

export interface ResolvedOutput {
  id: string
  type: string
  /** The declared path with `${param}` filled in, as written (may be relative). */
  path: string
  /** `path` resolved against the directory Nextflow runs from. */
  absolutePath: string
  primary: boolean
}

export type InspectedOutput =
  | (ResolvedOutput & { resolved: true })
  | {
      id: string
      type: string
      /** Raw declared template or blank path that could not be resolved from params. */
      path: string
      primary: boolean
      resolved: false
    }

/**
 * Inspects every declared manifest output without dropping unresolvable entries,
 * so local, composition, and remote collectors share one resolution rule.
 */
export function inspectOutputPaths(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): InspectedOutput[] {
  return Object.entries(manifest.outputs).map(([id, output]) => {
    const path = interpolate(output.path, params)
    if (path === undefined || path.trim() === '') {
      return { id, type: output.type, path: output.path, primary: output.primary, resolved: false }
    }
    return {
      id,
      type: output.type,
      path,
      absolutePath: isAbsolute(path) ? path : resolve(componentDir, path),
      primary: output.primary,
      resolved: true
    }
  })
}

/** Every declared output whose path can be resolved from the params; unresolvable ones are skipped. */
export function resolveOutputPaths(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): ResolvedOutput[] {
  return inspectOutputPaths(manifest, params, componentDir)
    .filter((output): output is ResolvedOutput & { resolved: true } => output.resolved)
    .map(({ id, type, path, absolutePath, primary }) => ({
      id,
      type,
      path,
      absolutePath,
      primary
    }))
}

export interface PrimaryOutputRecord {
  id: string
  path: string
  primary?: boolean
  /** `false` when the path is absent on disk or could not be resolved at all. */
  exists: boolean
}

/**
 * The single primary-output verdict shared by local runs, local composition,
 * and remote composition: a primary output is missing when its path does not
 * exist (or could not be resolved); optional outputs never count. Labels are `id (path)`.
 */
export function missingPrimaryOutputs(records: readonly PrimaryOutputRecord[]): string[] {
  return records
    .filter((record) => record.primary && !record.exists)
    .map((record) => `${record.id} (${record.path})`)
}

/**
 * After a successful run, lists each `primary: true` output whose resolved
 * path does not exist, formatted as `name (path)`. A primary output whose
 * path cannot be resolved from the params counts as missing (reported with
 * its declared template); unresolvable optional outputs are skipped.
 */
export function findMissingPrimaryOutputs(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): string[] {
  const records: PrimaryOutputRecord[] = inspectOutputPaths(manifest, params, componentDir).map(
    (output) => ({
      id: output.id,
      path: output.path,
      primary: output.primary,
      exists: output.resolved ? existsSync(output.absolutePath) : false
    })
  )
  return missingPrimaryOutputs(records)
}

/**
 * Evaluates declared content assertions (`nonEmpty`, `format`, `minDataRows`,
 * `minColumns`, `requiredColumns`) on local composition outputs after a run.
 * Returns human-readable failure descriptions; empty means all assertions passed.
 */
export function findFailedOutputAssertions(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): string[] {
  const failures: string[] = []
  for (const inspected of inspectOutputPaths(manifest, params, componentDir)) {
    const declared = manifest.outputs[inspected.id]
    if (!declared?.assertions) continue
    if (!inspected.resolved) {
      if (inspected.primary) {
        failures.push(`${inspected.id} (${inspected.path}): output path could not be resolved`)
      }
      continue
    }
    if (!existsSync(inspected.absolutePath)) {
      if (!inspected.primary) continue
      failures.push(`${inspected.id} (${inspected.path}): file does not exist`)
      continue
    }
    const verdict = verifyFileContentAssertion(inspected.absolutePath, declared.assertions)
    if (!verdict.ok) {
      failures.push(`${inspected.id} (${inspected.path}): ${verdict.reason ?? 'assertion failed'}`)
    }
  }
  return failures
}
