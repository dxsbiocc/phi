/**
 * Artifact contract 1.0.0. `artifactSchema` must stay deep-equal to
 * docs/contracts/artifact.schema.json. File layout, project containment,
 * and kind-specific blocks are checked in code.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import Ajv, { type ErrorObject } from 'ajv'

export const ARTIFACT_CONTRACT_VERSION = '1.0.0'

const MAX_DESCRIPTOR_BYTES = 64 * 1024
const MAX_ARTIFACTS = 8
const DESCRIPTOR_SUFFIX = '.phi-artifact.json'

/** Published copy: docs/contracts/artifact.schema.json. */
export const artifactSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://phi.local/contracts/artifact.schema.json',
  title: 'Phi artifact descriptor',
  description:
    'Artifact contract 1.0.0 (docs/contracts/artifact.md). File name checks, project containment, and kind-specific block rules are enforced in code.',
  type: 'object',
  required: ['contractVersion', 'kind', 'file', 'mediaType', 'title', 'provenance'],
  patternProperties: { '^x-': true },
  additionalProperties: false,
  properties: {
    contractVersion: { const: '1.0.0' },
    kind: { enum: ['figure', 'table', 'structure', 'molecule', 'network', 'report'] },
    file: { type: 'string', minLength: 1, pattern: '^[^/\\\\]+$' },
    mediaType: { type: 'string', pattern: '^[a-z]+/[A-Za-z0-9.+-]+$' },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    provenance: {
      type: 'object',
      required: ['createdAt', 'tool'],
      additionalProperties: false,
      properties: {
        createdAt: { type: 'string', format: 'date-time' },
        tool: { type: 'string', minLength: 1 },
        skill: { type: 'string', minLength: 1 },
        inputs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path'],
            additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1 },
              sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
            }
          }
        },
        script: { type: 'string', minLength: 1 },
        parameters: { type: 'object' }
      }
    },
    figure: {
      type: 'object',
      required: ['format'],
      additionalProperties: false,
      properties: {
        widthPx: { type: 'integer', minimum: 1 },
        heightPx: { type: 'integer', minimum: 1 },
        format: { enum: ['png', 'pdf', 'svg'] }
      }
    },
    table: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: { type: 'integer', minimum: 0 },
        columns: {
          oneOf: [
            { type: 'integer', minimum: 0 },
            { type: 'array', items: { type: 'string' } }
          ]
        }
      }
    }
  }
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

function isIso8601WithZone(value: string): boolean {
  const match = DATE_TIME.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return false
  }
  if (match[8] === 'Z') return true
  const offsetHour = Number(match[9])
  const offsetMinute = Number(match[10])
  return offsetHour <= 23 && offsetMinute <= 59
}

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false })
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => isIso8601WithZone(value)
})
const validateDescriptor = ajv.compile(structuredClone(artifactSchema))

export interface ArtifactDescriptor {
  contractVersion: string
  kind: string
  file: string
  mediaType: string
  title: string
  description?: string
  provenance: {
    createdAt: string
    tool: string
    skill?: string
    inputs?: Array<{ path: string; sha256?: string }>
    script?: string
    parameters?: Record<string, unknown>
  }
  figure?: { widthPx?: number; heightPx?: number; format: string }
  table?: { rows?: number; columns?: number | string[] }
  [extension: `x-${string}`]: unknown
}

export interface ReadArtifactOk {
  ok: true
  path: string
  relativePath: string
  descriptor: ArtifactDescriptor
}

export type ReadArtifactResult = ReadArtifactOk | { ok: false; path: string; error: string }

export function readArtifact(projectDir: string, requested: string): ReadArtifactResult {
  const fail = (error: string): ReadArtifactResult => ({ ok: false, path: requested, error })
  if (requested.length === 0) return fail('path is required')

  let projectReal: string
  try {
    projectReal = realpathSync(resolve(projectDir))
  } catch {
    return fail('project directory does not exist')
  }

  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(projectReal, requested)

  let artifactReal: string
  try {
    artifactReal = realpathSync(lexical)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return fail('file does not exist')
    const message = error instanceof Error ? error.message : String(error)
    return fail(message)
  }
  if (!containsPath(projectReal, artifactReal)) return fail('file is outside the project')
  if (!statSync(artifactReal).isFile()) return fail('file is not a regular file')

  const descriptorPath = `${lexical}${DESCRIPTOR_SUFFIX}`
  let descriptorReal: string
  try {
    descriptorReal = realpathSync(descriptorPath)
  } catch {
    return fail('descriptor does not exist')
  }
  if (!containsPath(projectReal, descriptorReal)) return fail('descriptor is outside the project')
  const descriptorStat = statSync(descriptorReal)
  if (!descriptorStat.isFile()) return fail('descriptor is not a regular file')
  if (descriptorStat.size > MAX_DESCRIPTOR_BYTES) return fail('descriptor exceeds 64 KiB')

  const bytes = readFileSync(descriptorReal)
  if (bytes.byteLength > MAX_DESCRIPTOR_BYTES) return fail('descriptor exceeds 64 KiB')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail('descriptor is not UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return fail('descriptor is not JSON')
  }
  if (!validateDescriptor(parsed)) {
    return fail(
      `descriptor does not match the schema: ${formatSchemaErrors(validateDescriptor.errors)}`
    )
  }

  const descriptor = parsed as unknown as ArtifactDescriptor
  const artifactName = basename(lexical)
  if (descriptor.file !== artifactName) return fail(`file must equal '${artifactName}'`)
  if (descriptor.figure !== undefined && descriptor.kind !== 'figure') {
    return fail('figure is only allowed when kind is figure')
  }
  if (descriptor.table !== undefined && descriptor.kind !== 'table') {
    return fail('table is only allowed when kind is table')
  }
  for (const input of descriptor.provenance.inputs ?? []) {
    const problem = projectRelativeError(projectReal, input.path)
    if (problem) return fail(`provenance input '${input.path}' ${problem}`)
  }
  if (descriptor.provenance.script !== undefined) {
    const problem = projectRelativeError(projectReal, descriptor.provenance.script)
    if (problem) return fail(`provenance script '${descriptor.provenance.script}' ${problem}`)
  }

  return {
    ok: true,
    path: artifactReal,
    relativePath: relative(projectReal, artifactReal).split(sep).join('/'),
    descriptor
  }
}

export function collectArtifacts(
  projectDir: string,
  output: unknown
): { artifacts: ReadArtifactOk[]; warnings: string[] } {
  if (!isRecord(output) || !Object.hasOwn(output, 'artifacts')) {
    return { artifacts: [], warnings: [] }
  }
  const listed = output.artifacts
  if (!Array.isArray(listed) || listed.some((item) => typeof item !== 'string')) {
    return { artifacts: [], warnings: ['artifacts must be an array of project paths'] }
  }

  const seen = new Set<string>()
  const selected: string[] = []
  const skipped: string[] = []
  for (const entry of listed) {
    const key = requestKey(projectDir, entry)
    if (seen.has(key)) continue
    seen.add(key)
    if (selected.length >= MAX_ARTIFACTS) {
      skipped.push(entry)
      continue
    }
    selected.push(entry)
  }

  const warnings: string[] = []
  const artifacts: ReadArtifactOk[] = []
  const seenReal = new Set<string>()
  for (const entry of selected) {
    const read = readArtifact(projectDir, entry)
    if (!read.ok) {
      warnings.push(`${entry}: ${read.error}`)
      continue
    }
    if (seenReal.has(read.path)) continue
    seenReal.add(read.path)
    artifacts.push(read)
  }
  if (skipped.length > 0) {
    warnings.push(
      `only the first ${MAX_ARTIFACTS} artifacts are presented; not presented: ${skipped.join(', ')}`
    )
  }
  return { artifacts, warnings }
}

function requestKey(projectDir: string, value: string): string {
  try {
    const root = resolve(projectDir)
    return isAbsolute(value) ? resolve(value) : resolve(root, value)
  } catch {
    return value
  }
}

function containsPath(root: string, target: string): boolean {
  if (target === root) return true
  const part = relative(root, target)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function projectRelativeError(projectReal: string, value: string): string | undefined {
  if (value.length === 0 || isAbsolute(value)) return 'is not project-relative'
  let lexical: string
  try {
    lexical = resolve(projectReal, value)
  } catch {
    return 'is outside the project'
  }
  if (!containsPath(projectReal, lexical)) return 'is outside the project'
  if (resolvedPathLeaves(projectReal, lexical)) return 'is outside the project'
  return undefined
}

function resolvedPathLeaves(projectReal: string, lexical: string): boolean {
  const pending: string[] = []
  let current = lexical
  while (true) {
    try {
      const real = realpathSync(current)
      if (!containsPath(projectReal, real)) return true
      let rebuilt = real
      for (const name of [...pending].reverse()) rebuilt = join(rebuilt, name)
      return !containsPath(projectReal, rebuilt)
    } catch {
      const parent = dirname(current)
      if (parent === current) return true
      pending.push(basename(current))
      current = parent
    }
  }
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  const list = errors ?? []
  if (list.length === 0) return 'is invalid'
  return list
    .map((error) => {
      const where = error.instancePath || '(root)'
      if (error.keyword === 'additionalProperties') {
        const name = (error.params as { additionalProperty?: unknown }).additionalProperty
        return `${where} has unknown property '${String(name)}'`
      }
      const message = error.message ?? 'is invalid'
      return error.instancePath ? `${error.instancePath} ${message}` : message
    })
    .join('; ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
