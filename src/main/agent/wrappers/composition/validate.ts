import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import type { WrapperCompositionManifest, WrapperCompositionParam } from './manifest'

/**
 * Light validation from docs/design/phi-wrapper-agent-composition-design.md
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

/** Every declared output whose path can be resolved from the params; unresolvable ones are skipped. */
export function resolveOutputPaths(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): ResolvedOutput[] {
  const resolved: ResolvedOutput[] = []
  for (const [id, output] of Object.entries(manifest.outputs)) {
    const path = interpolate(output.path, params)
    if (path === undefined) continue
    resolved.push({
      id,
      type: output.type,
      path,
      absolutePath: isAbsolute(path) ? path : resolve(componentDir, path),
      primary: output.primary
    })
  }
  return resolved
}

/**
 * After a successful run, lists each `primary: true` output whose resolved
 * path does not exist, formatted as `name (path)`. Outputs whose path
 * cannot be resolved from the params are skipped rather than reported.
 */
export function findMissingPrimaryOutputs(
  manifest: WrapperCompositionManifest,
  params: Record<string, unknown>,
  componentDir: string
): string[] {
  return resolveOutputPaths(manifest, params, componentDir)
    .filter((output) => output.primary && !existsSync(output.absolutePath))
    .map((output) => `${output.id} (${output.path})`)
}
