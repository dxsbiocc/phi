import { parse as parseYaml } from 'yaml'

import type {
  WrapperCompositionManifest,
  WrapperCompositionOutput,
  WrapperCompositionParam
} from '../../../../shared/wrapperCompositionManifestTypes'

/**
 * Parser for the minimal per-wrapper manifest described in
 * docs/design/phi-wrapper-agent-composition-design.md section 3 — NOT the
 * fuller package manifest `manifest.ts`/`manifest-types.ts` parse (that one
 * describes a whole bundled wrapper package; this one describes a single
 * `wrapper/wrapper.yaml` adapter beside a vendored nf-core module or
 * subworkflow). The shape itself lives in `shared/wrapperCompositionManifestTypes.ts`
 * so the renderer can use it too — see that file's own header comment.
 */
export type {
  WrapperCompositionManifest,
  WrapperCompositionOutput,
  WrapperCompositionParam
} from '../../../../shared/wrapperCompositionManifestTypes'

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
      maximum: typeof value.maximum === 'number' ? value.maximum : undefined,
      enum:
        Array.isArray(value.enum) && value.enum.every((item) => typeof item === 'string')
          ? (value.enum as string[])
          : undefined
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
