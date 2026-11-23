import { parse as parseYaml } from 'yaml'

import type {
  WrapperCompositionManifest,
  WrapperCompositionOutput,
  WrapperCompositionParam
} from '../../../../shared/wrapperCompositionManifestTypes'

import { isRecord } from '../../../../shared/guards'
/**
 * Parser for the minimal per-wrapper manifest described in
 * resources/skills/create-wrapper/references/guide.md section 3 — NOT the
 * package manifest `packages/manifest.ts` parse (that one describes the
 * distributable tree unit; this one describes a single
 * `wrapper/wrapper.yaml` adapter beside a vendored nf-core module or
 * subworkflow). The shape itself lives in `shared/wrapperCompositionManifestTypes.ts`
 * so the renderer can use it too — see that file's own header comment.
 */
export type {
  WrapperCompositionManifest,
  WrapperCompositionOutput,
  WrapperCompositionParam
} from '../../../../shared/wrapperCompositionManifestTypes'

const WRAPPER_ID = /^[a-z][a-z0-9-]*\/(?:modules|subworkflows|workflows)\/[a-z][a-z0-9-]*$/
const PARAM_NAME = /^[a-z][a-z0-9_]*$/
const TOP_LEVEL_KEYS = new Set(['id', 'name', 'summary', 'params', 'outputs'])
const PARAM_KEYS = new Set([
  'kind',
  'type',
  'required',
  'description',
  'minimum',
  'maximum',
  'enum'
])
const OUTPUT_KEYS = new Set(['type', 'path', 'primary', 'assertions'])
const ASSERTION_KEYS = new Set([
  'nonEmpty',
  'format',
  'minDataRows',
  'minColumns',
  'requiredColumns'
])
const ASSERTION_FORMATS = new Set(['tsv', 'csv', 'json'])

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is an unknown field`)
  }
}

function requiredText(value: unknown, path: string, options: { maxLength?: number } = {}): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error(`${path} must be a non-empty string`)
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new Error(`${path} must be 1-${options.maxLength} characters`)
  }
  return value
}

function validateParamRanges(key: string, type: string, value: Record<string, unknown>): void {
  for (const range of ['minimum', 'maximum'] as const) {
    const constraint = value[range]
    if (constraint === undefined) continue
    if (typeof constraint !== 'number' || !Number.isFinite(constraint)) {
      throw new Error(`wrapper.yaml.params.${key}.${range} must be a finite number`)
    }
    if (type !== 'integer' && type !== 'number') {
      throw new Error(
        `wrapper.yaml.params.${key}.${range} is only allowed for numeric types integer and number`
      )
    }
  }
}

function optionalParamFields(value: Record<string, unknown>): Partial<WrapperCompositionParam> {
  return {
    ...(value.description !== undefined ? { description: value.description as string } : {}),
    ...(value.minimum !== undefined ? { minimum: value.minimum as number } : {}),
    ...(value.maximum !== undefined ? { maximum: value.maximum as number } : {}),
    ...(value.enum !== undefined ? { enum: value.enum as string[] } : {})
  }
}

function parseManifestParam(key: string, value: unknown): WrapperCompositionParam {
  if (!isRecord(value)) throw new Error(`wrapper.yaml params.${key} must be a mapping`)
  if (!PARAM_NAME.test(key)) {
    throw new Error(`wrapper.yaml params.${key} name must match ^[a-z][a-z0-9_]*$`)
  }
  assertKnownKeys(value, PARAM_KEYS, `wrapper.yaml.params.${key}`)
  if (value.kind !== 'input' && value.kind !== 'output' && value.kind !== 'option') {
    throw new Error(`wrapper.yaml params.${key}.kind must be input, output, or option`)
  }
  const type = requiredText(value.type, `wrapper.yaml.params.${key}.type`)
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new Error(`wrapper.yaml.params.${key}.required must be a boolean`)
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error(`wrapper.yaml.params.${key}.description must be a string`)
  }
  validateParamRanges(key, type, value)
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.every((item) => typeof item === 'string'))
  ) {
    throw new Error(`wrapper.yaml.params.${key}.enum must be a list of strings`)
  }
  return {
    kind: value.kind,
    type,
    required: value.required ?? false,
    ...optionalParamFields(value)
  }
}

function validateAssertionCounts(key: string, raw: Record<string, unknown>): void {
  for (const countKey of ['minDataRows', 'minColumns'] as const) {
    const count = raw[countKey]
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    ) {
      throw new Error(
        `wrapper.yaml outputs.${key}.assertions.${countKey} must be a non-negative integer`
      )
    }
  }
}

function buildOutputAssertions(
  raw: Record<string, unknown>
): NonNullable<WrapperCompositionOutput['assertions']> {
  return {
    ...(raw.nonEmpty !== undefined ? { nonEmpty: raw.nonEmpty as boolean } : {}),
    ...(raw.format !== undefined ? { format: raw.format as 'tsv' | 'csv' | 'json' } : {}),
    ...(raw.minDataRows !== undefined ? { minDataRows: raw.minDataRows as number } : {}),
    ...(raw.minColumns !== undefined ? { minColumns: raw.minColumns as number } : {}),
    ...(raw.requiredColumns !== undefined
      ? { requiredColumns: raw.requiredColumns as string[] }
      : {})
  }
}

function parseOutputAssertions(key: string, raw: unknown): WrapperCompositionOutput['assertions'] {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error(`wrapper.yaml outputs.${key}.assertions must be a mapping`)
  assertKnownKeys(raw, ASSERTION_KEYS, `wrapper.yaml.outputs.${key}.assertions`)
  if (raw.nonEmpty !== undefined && typeof raw.nonEmpty !== 'boolean') {
    throw new Error(`wrapper.yaml outputs.${key}.assertions.nonEmpty must be a boolean`)
  }
  if (
    raw.format !== undefined &&
    (typeof raw.format !== 'string' || !ASSERTION_FORMATS.has(raw.format))
  ) {
    throw new Error(`wrapper.yaml outputs.${key}.assertions.format must be tsv, csv, or json`)
  }
  validateAssertionCounts(key, raw)
  if (
    raw.requiredColumns !== undefined &&
    (!Array.isArray(raw.requiredColumns) ||
      !raw.requiredColumns.every((col) => typeof col === 'string' && col.trim().length > 0))
  ) {
    throw new Error(
      `wrapper.yaml outputs.${key}.assertions.requiredColumns must be a list of non-empty strings`
    )
  }
  return buildOutputAssertions(raw)
}

function parseManifestOutput(key: string, value: unknown): WrapperCompositionOutput {
  if (!isRecord(value)) throw new Error(`wrapper.yaml outputs.${key} must be a mapping`)
  assertKnownKeys(value, OUTPUT_KEYS, `wrapper.yaml.outputs.${key}`)
  const type = requiredText(value.type, `wrapper.yaml.outputs.${key}.type`)
  const path = requiredText(value.path, `wrapper.yaml.outputs.${key}.path`)
  if (value.primary !== undefined && typeof value.primary !== 'boolean') {
    throw new Error(`wrapper.yaml.outputs.${key}.primary must be a boolean`)
  }
  const assertions = parseOutputAssertions(key, value.assertions)
  return {
    type,
    path,
    primary: value.primary ?? false,
    ...(assertions ? { assertions } : {})
  }
}

export function parseWrapperCompositionManifest(yamlText: string): WrapperCompositionManifest {
  const doc: unknown = parseYaml(yamlText)
  if (!isRecord(doc)) throw new Error('wrapper.yaml must be a mapping')
  assertKnownKeys(doc, TOP_LEVEL_KEYS, 'wrapper.yaml')

  const { id, name, summary, params, outputs } = doc
  if (typeof id !== 'string' || !WRAPPER_ID.test(id)) {
    throw new Error(
      'wrapper.yaml.id must have format <provider>/<kind>/<name>, where kind is modules, subworkflows, or workflows'
    )
  }
  const parsedName = requiredText(name, 'wrapper.yaml.name', { maxLength: 80 })
  const parsedSummary = requiredText(summary, 'wrapper.yaml.summary', { maxLength: 300 })
  if (!isRecord(params)) throw new Error('wrapper.yaml missing required field: params')
  if (!isRecord(outputs)) throw new Error('wrapper.yaml missing required field: outputs')

  const parsedParams: Record<string, WrapperCompositionParam> = {}
  for (const [key, value] of Object.entries(params)) {
    parsedParams[key] = parseManifestParam(key, value)
  }

  const parsedOutputs: Record<string, WrapperCompositionOutput> = {}
  for (const [key, value] of Object.entries(outputs)) {
    parsedOutputs[key] = parseManifestOutput(key, value)
  }

  if (!Object.values(parsedOutputs).some((output) => output.primary)) {
    throw new Error('wrapper.yaml.outputs must contain at least one output with primary: true')
  }

  return {
    id,
    name: parsedName,
    summary: parsedSummary,
    params: parsedParams,
    outputs: parsedOutputs
  }
}
