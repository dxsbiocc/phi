import Ajv, { type ValidateFunction } from 'ajv'

import type { JsonSchema } from './manifest-types'

const ajv = new Ajv({ allErrors: true, strict: false })
const compiledCache = new WeakMap<JsonSchema, ValidateFunction>()

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema)
  if (cached) return cached
  const validate = ajv.compile(schema)
  compiledCache.set(schema, validate)
  return validate
}

export interface ParamsValidationResult {
  valid: boolean
  errors: string[]
}

/** Validates wrapper params against the manifest's `parameters.schema` (JSON Schema). */
export function validateWrapperParams(
  schema: JsonSchema,
  params: Record<string, unknown>
): ParamsValidationResult {
  const validate = compile(schema)
  const valid = validate(params) as boolean
  if (valid) return { valid: true, errors: [] }

  const errors = (validate.errors ?? []).map((error) => {
    const path = error.instancePath || '(root)'
    return `${path} ${error.message ?? '不满足参数约束'}`.trim()
  })
  return { valid: false, errors }
}

/** Structural check that a value is at least a plausible JSON Schema object, not a full meta-schema check. */
export function isPlausibleJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
