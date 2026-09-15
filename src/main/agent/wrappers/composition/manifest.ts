import { parse as parseYaml } from 'yaml'

/**
 * Parser for the minimal per-wrapper manifest described in
 * docs/design/phi-wrapper-agent-composition-design.md section 3 — NOT the
 * fuller package manifest `manifest.ts`/`manifest-types.ts` parse (that one
 * describes a whole bundled wrapper package; this one describes a single
 * `wrapper/wrapper.yaml` adapter beside a vendored nf-core module or
 * subworkflow).
 */

export interface WrapperCompositionParam {
  kind: 'input' | 'output' | 'option'
  type: string
  required: boolean
  description?: string
  minimum?: number
  maximum?: number
}

export interface WrapperCompositionOutput {
  type: string
  path: string
  primary: boolean
}

export interface WrapperCompositionManifest {
  id: string
  name: string
  summary: string
  params: Record<string, WrapperCompositionParam>
  outputs: Record<string, WrapperCompositionOutput>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseWrapperCompositionManifest(yamlText: string): WrapperCompositionManifest {
  const doc: unknown = parseYaml(yamlText)
  if (!isRecord(doc)) {
    throw new Error('wrapper.yaml must be a mapping')
  }

  const { id, name, summary, params, outputs } = doc
  if (typeof id !== 'string' || !id) throw new Error('wrapper.yaml missing required field: id')
  if (typeof name !== 'string' || !name)
    throw new Error('wrapper.yaml missing required field: name')
  if (typeof summary !== 'string' || !summary) {
    throw new Error('wrapper.yaml missing required field: summary')
  }
  if (!isRecord(params)) throw new Error('wrapper.yaml missing required field: params')
  if (!isRecord(outputs)) throw new Error('wrapper.yaml missing required field: outputs')

  const parsedParams: Record<string, WrapperCompositionParam> = {}
  for (const [key, value] of Object.entries(params)) {
    if (!isRecord(value)) throw new Error(`wrapper.yaml params.${key} must be a mapping`)
    if (value.kind !== 'input' && value.kind !== 'output' && value.kind !== 'option') {
      throw new Error(`wrapper.yaml params.${key}.kind must be input, output, or option`)
    }
    if (typeof value.type !== 'string') {
      throw new Error(`wrapper.yaml params.${key}.type must be a string`)
    }
    parsedParams[key] = {
      kind: value.kind,
      type: value.type,
      required: value.required === true,
      description: typeof value.description === 'string' ? value.description : undefined,
      minimum: typeof value.minimum === 'number' ? value.minimum : undefined,
      maximum: typeof value.maximum === 'number' ? value.maximum : undefined
    }
  }

  const parsedOutputs: Record<string, WrapperCompositionOutput> = {}
  for (const [key, value] of Object.entries(outputs)) {
    if (!isRecord(value)) throw new Error(`wrapper.yaml outputs.${key} must be a mapping`)
    if (typeof value.type !== 'string') {
      throw new Error(`wrapper.yaml outputs.${key}.type must be a string`)
    }
    if (typeof value.path !== 'string') {
      throw new Error(`wrapper.yaml outputs.${key}.path must be a string`)
    }
    parsedOutputs[key] = {
      type: value.type,
      path: value.path,
      primary: value.primary === true
    }
  }

  return { id, name, summary, params: parsedParams, outputs: parsedOutputs }
}
