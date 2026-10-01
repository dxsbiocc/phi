import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'

import { validateSkill, type ValidatedSkill } from '../content/skill'
import { validatePlugin, type ValidatedPlugin } from '../plugins/validate'

export const PACKAGE_CONTRACT_VERSION = '1.0.0'

export const packageManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://phi.local/contracts/package.schema.json',
  title: 'Phi package manifest (phi-package.yaml)',
  description:
    'Package contract 1.0.0 (docs/contracts/package.md). Type-specific path and component validation is enforced in code.',
  type: 'object',
  required: ['schemaVersion', 'id', 'type', 'version', 'title', 'summary'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
    type: { enum: ['skill', 'plugin'] },
    version: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
    },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    summary: { type: 'string', minLength: 1, maxLength: 300 },
    minAppVersion: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
    },
    requires: {
      type: 'object',
      additionalProperties: false,
      properties: {
        coreTools: {
          type: 'array',
          items: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          uniqueItems: true
        }
      }
    },
    dependsOn: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type', 'version'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
          type: { enum: ['skill', 'plugin'] },
          version: { type: 'string', minLength: 1 }
        }
      }
    },
    files: { const: 'files.json' },
    toolPrefix: { type: 'string', pattern: '^[a-z][a-z0-9]{1,11}$' },
    components: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string', pattern: '^agents/[A-Z][A-Za-z0-9]*\\.md$' },
          uniqueItems: true
        },
        skills: {
          type: 'array',
          items: { type: 'string', pattern: '^skills/[a-z0-9][a-z0-9-]{0,63}$' },
          uniqueItems: true
        }
      }
    },
    environments: {
      type: 'object',
      propertyNames: { pattern: '^[a-z][a-z0-9-]{0,62}$' },
      additionalProperties: {
        type: 'object',
        required: ['spec'],
        additionalProperties: false,
        properties: {
          spec: {
            type: 'string',
            pattern: '^environments/[a-z][a-z0-9-]{0,62}/environment\\.yml$'
          }
        }
      }
    }
  },
  allOf: [
    {
      if: { properties: { type: { const: 'skill' } }, required: ['type'] },
      then: {
        not: {
          anyOf: [
            { required: ['toolPrefix'] },
            { required: ['components'] },
            { required: ['environments'] }
          ]
        }
      }
    },
    {
      if: { properties: { type: { const: 'plugin' } }, required: ['type'] },
      then: { required: ['toolPrefix', 'components'] }
    }
  ]
} as const

export type PackageType = 'skill' | 'plugin'

export interface PackageDependency {
  id: string
  type: PackageType
  version: string
}

export interface PackageRequirements {
  coreTools?: string[]
}

export interface BasePackageManifest {
  schemaVersion: 1
  id: string
  type: PackageType
  version: string
  title: string
  summary: string
  minAppVersion?: string
  requires?: PackageRequirements
  dependsOn?: PackageDependency[]
  files?: 'files.json'
}

export interface SkillPackageManifest extends BasePackageManifest {
  type: 'skill'
}

export type PluginPackageManifest = BasePackageManifest &
  ValidatedPlugin['manifest'] & { type: 'plugin' }

export type PackageManifest = SkillPackageManifest | PluginPackageManifest

export interface PackageProblem {
  level: 'error' | 'warning'
  path: string
  message: string
}

export interface ValidatedPackage {
  dir: string
  manifest: PackageManifest
  skill?: ValidatedSkill
  plugin?: ValidatedPlugin
}

export interface PackageValidationResult {
  ok: boolean
  errors: PackageProblem[]
  warnings: PackageProblem[]
  package?: ValidatedPackage
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateManifestSchema = ajv.compile(packageManifestSchema)

export function parsePackageManifestText(text: string): PackageManifest {
  let document: unknown
  try {
    document = parseYaml(text)
  } catch (error) {
    throw new Error(`YAML parse error: ${errorMessage(error)}`)
  }
  if (!isRecord(document)) throw new Error('phi-package.yaml must be a YAML mapping')
  const rawType = document.type
  if (rawType === 'wrapper' || rawType === 'mcp') {
    throw new Error(`package type '${rawType}' is reserved and not supported by the v1 installer`)
  }
  if (!validateManifestSchema(document)) {
    throw new Error(
      (validateManifestSchema.errors ?? [])
        .map((error) => `${schemaPath(error)}: ${schemaMessage(error)}`)
        .join('; ')
    )
  }
  const manifest = document as unknown as PackageManifest
  if (!semver.valid(manifest.version)) {
    throw new Error(`version: '${manifest.version}' is not a valid semantic version`)
  }
  if (manifest.minAppVersion && !semver.valid(manifest.minAppVersion)) {
    throw new Error(`minAppVersion: '${manifest.minAppVersion}' is not a valid semantic version`)
  }
  for (const [index, dependency] of (manifest.dependsOn ?? []).entries()) {
    if (!semver.validRange(dependency.version)) {
      throw new Error(`dependsOn[${index}].version: '${dependency.version}' is not a semver range`)
    }
  }
  return manifest
}

export function readPackageManifest(dir: string): PackageManifest {
  const path = join(resolve(dir), 'phi-package.yaml')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read phi-package.yaml: ${errorMessage(error)}`)
  }
  return parsePackageManifestText(text)
}

export function validatePackage(dir: string): PackageValidationResult {
  const packageDir = resolve(dir)
  let manifest: PackageManifest
  try {
    manifest = readPackageManifest(packageDir)
  } catch (error) {
    return finish([{ level: 'error', path: 'phi-package.yaml', message: errorMessage(error) }], [])
  }

  if (manifest.type === 'plugin') {
    const result = validatePlugin(packageDir)
    if (!result.ok || !result.plugin) return finish(result.errors, result.warnings)
    return finish([], result.warnings, { dir: packageDir, manifest, plugin: result.plugin })
  }

  const result = validateSkill(packageDir, { expectedName: manifest.id })
  const errors: PackageProblem[] = [...result.errors]
  if (result.skill && manifest.id !== result.skill.name) {
    errors.push({
      level: 'error',
      path: 'id',
      message: `package id '${manifest.id}' must equal skill name '${result.skill.name}'`
    })
  }
  if (errors.length > 0 || !result.skill) return finish(errors, result.warnings)
  return finish([], result.warnings, { dir: packageDir, manifest, skill: result.skill })
}

function finish(
  errors: PackageProblem[],
  warnings: PackageProblem[],
  value?: ValidatedPackage
): PackageValidationResult {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(value && errors.length === 0 ? { package: value } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaPath(error: ErrorObject): string {
  const parts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  const params = error.params as Record<string, unknown>
  if (error.keyword === 'required') parts.push(String(params.missingProperty))
  if (error.keyword === 'additionalProperties') parts.push(String(params.additionalProperty))
  return parts.length > 0 ? parts.join('.') : 'phi-package.yaml'
}

function schemaMessage(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties') {
    return `unknown field '${String((error.params as Record<string, unknown>).additionalProperty)}'`
  }
  return error.message ?? 'is invalid'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
