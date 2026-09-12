import { createHash } from 'node:crypto'

import * as semver from 'semver'
import { parse as parseYaml } from 'yaml'

import type { ManifestParseResult, WrapperManifest, WrapperManifestRuntime } from './manifest-types'
import { isPlausibleJsonSchema } from './schema'
import type { WrapperEngineType, WrapperResourceClass } from './types'

/** Phi's own wrapper runtime version, checked against a manifest's `runtime.minVersion`/`maxVersion`. */
export const PHI_WRAPPER_RUNTIME_VERSION = '1.0.0'

const SUPPORTED_PHI_WRAPPER_MANIFEST_VERSION = 1
const RESOURCE_CLASSES: WrapperResourceClass[] = ['light', 'standard', 'heavy', 'hpc']
const ENGINE_TYPES: WrapperEngineType[] = ['nextflow', 'snakemake', 'cwl', 'wdl']
/** Only this engine can actually be submitted for execution (Phase 1-3). Others parse fine but can't run yet. */
const EXECUTABLE_ENGINE_TYPES: WrapperEngineType[] = ['nextflow']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maxVersionSatisfied(maxVersion: string, current: string): boolean {
  const majorWildcard = /^(\d+)\.x$/.exec(maxVersion)
  if (majorWildcard) {
    return semver.major(current) === Number(majorWildcard[1])
  }
  if (!semver.valid(maxVersion)) return false
  return semver.lte(current, maxVersion)
}

function isRuntimeCompatible(runtime: WrapperManifestRuntime, current: string): boolean {
  if (!semver.valid(runtime.minVersion)) return false
  if (!semver.gte(current, runtime.minVersion)) return false
  return maxVersionSatisfied(runtime.maxVersion, current)
}

/**
 * Structural validation of a parsed manifest object. Collects every problem
 * found instead of stopping at the first one, so authoring feedback is
 * useful in one pass.
 */
function validateManifestShape(raw: unknown): { errors: string[]; manifest?: WrapperManifest } {
  const errors: string[] = []
  if (!isRecord(raw)) {
    return { errors: ['manifest 根节点必须是一个对象'] }
  }

  if (raw.phiWrapperVersion !== SUPPORTED_PHI_WRAPPER_MANIFEST_VERSION) {
    errors.push(
      `不支持的 phiWrapperVersion: ${String(raw.phiWrapperVersion)}（仅支持 ${SUPPORTED_PHI_WRAPPER_MANIFEST_VERSION}）`
    )
  }

  if (typeof raw.id !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(raw.id)) {
    errors.push('id 必须是形如 "namespace/group/short-id" 的规范化 wrapper id')
  }

  if (typeof raw.shortId !== 'string' || raw.shortId.trim().length === 0) {
    errors.push('shortId 不能为空')
  }

  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    errors.push('name 不能为空')
  }

  if (typeof raw.version !== 'string' || !semver.valid(raw.version)) {
    errors.push(`version 必须是合法的 SemVer: ${String(raw.version)}`)
  }

  if (typeof raw.summary !== 'string' || raw.summary.trim().length === 0) {
    errors.push('summary 不能为空')
  }

  const runtime = raw.runtime
  if (
    !isRecord(runtime) ||
    typeof runtime.minVersion !== 'string' ||
    typeof runtime.maxVersion !== 'string'
  ) {
    errors.push('runtime.minVersion / runtime.maxVersion 必须是字符串')
  } else if (
    !isRuntimeCompatible(
      { minVersion: runtime.minVersion, maxVersion: runtime.maxVersion },
      PHI_WRAPPER_RUNTIME_VERSION
    )
  ) {
    errors.push(
      `wrapper 声明的运行时范围 [${runtime.minVersion}, ${runtime.maxVersion}] 与当前 Phi wrapper 运行时 ${PHI_WRAPPER_RUNTIME_VERSION} 不兼容`
    )
  }

  if (
    typeof raw.resourceClass !== 'string' ||
    !RESOURCE_CLASSES.includes(raw.resourceClass as WrapperResourceClass)
  ) {
    errors.push(`resourceClass 必须是以下之一: ${RESOURCE_CLASSES.join(', ')}`)
  }

  const engine = raw.engine
  if (!isRecord(engine)) {
    errors.push('engine 不能为空')
  } else {
    if (
      typeof engine.type !== 'string' ||
      !ENGINE_TYPES.includes(engine.type as WrapperEngineType)
    ) {
      errors.push(`engine.type 必须是以下之一: ${ENGINE_TYPES.join(', ')}`)
    }
    if (typeof engine.entrypoint !== 'string' || engine.entrypoint.trim().length === 0) {
      errors.push('engine.entrypoint 不能为空')
    }
    if (!Array.isArray(engine.profiles) || engine.profiles.length === 0) {
      errors.push('engine.profiles 必须至少声明一个 profile')
    }
  }

  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) {
      errors.push('steps 必须是数组')
    } else {
      const stepIds = new Set<string>()
      raw.steps.forEach((step, index) => {
        if (
          !isRecord(step) ||
          typeof step.id !== 'string' ||
          typeof step.label !== 'string' ||
          !Array.isArray(step.dependsOn)
        ) {
          errors.push(`steps[${index}] 必须包含 id、label、dependsOn（字符串数组）`)
          return
        }
        stepIds.add(step.id)
      })
      raw.steps.forEach((step) => {
        if (!isRecord(step) || !Array.isArray(step.dependsOn)) return
        for (const dependency of step.dependsOn) {
          if (typeof dependency !== 'string' || !stepIds.has(dependency)) {
            errors.push(
              `steps 中 "${String(step.id)}" 的 dependsOn 引用了未声明的 step: ${String(dependency)}`
            )
          }
        }
      })
    }
  }

  if (!Array.isArray(raw.inputs)) {
    errors.push('inputs 必须是数组')
  } else {
    raw.inputs.forEach((input, index) => {
      if (!isRecord(input) || typeof input.id !== 'string' || typeof input.type !== 'string') {
        errors.push(`inputs[${index}] 必须包含 id 和 type`)
      }
    })
  }

  const parameters = raw.parameters
  if (!isRecord(parameters) || !isPlausibleJsonSchema(parameters.schema)) {
    errors.push('parameters.schema 必须是一个 JSON Schema 对象')
  }

  if (!Array.isArray(raw.outputs) || raw.outputs.length === 0) {
    errors.push('outputs 必须至少声明一个输出')
  } else {
    raw.outputs.forEach((output, index) => {
      if (
        !isRecord(output) ||
        typeof output.id !== 'string' ||
        typeof output.label !== 'string' ||
        typeof output.type !== 'string' ||
        typeof output.path !== 'string'
      ) {
        errors.push(`outputs[${index}] 必须包含 id、label、type、path`)
      }
    })
  }

  const resources = raw.resources
  if (!isRecord(resources) || !isRecord(resources.defaults)) {
    errors.push('resources.defaults 不能为空')
  }

  if (errors.length > 0) {
    return { errors }
  }

  return { errors: [], manifest: raw as unknown as WrapperManifest }
}

/** Parses a `wrapper.yaml` document and validates its static contract. Never throws. */
export function parseWrapperManifest(rawYamlText: string): ManifestParseResult {
  let raw: unknown
  try {
    raw = parseYaml(rawYamlText)
  } catch (error) {
    return {
      valid: false,
      errors: [`YAML 解析失败: ${error instanceof Error ? error.message : String(error)}`]
    }
  }

  const { errors, manifest } = validateManifestShape(raw)
  if (!manifest) {
    return { valid: false, errors }
  }
  return { valid: true, manifest, errors: [] }
}

/**
 * Canonical digest of a manifest: keys sorted recursively before hashing, so
 * semantically identical YAML with different key order or whitespace
 * produces the same digest. Verification (Phase 3) compares this against a
 * registry-recorded digest — never the raw YAML text.
 */
export function canonicalManifestDigest(manifest: WrapperManifest): string {
  const canonicalJson = JSON.stringify(sortKeysDeep(manifest))
  return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortKeysDeep(value[key])
        return sorted
      }, {})
  }
  return value
}

/** Only `nextflow` is executable today; other engine types parse but cannot be submitted. */
export function isEngineExecutable(manifest: WrapperManifest): boolean {
  return EXECUTABLE_ENGINE_TYPES.includes(manifest.engine.type)
}

export function assertEngineExecutable(manifest: WrapperManifest): void {
  if (!isEngineExecutable(manifest)) {
    throw new Error(
      `wrapper ${manifest.id} 使用的 engine.type "${manifest.engine.type}" 暂不支持执行，目前仅支持 nextflow`
    )
  }
}
