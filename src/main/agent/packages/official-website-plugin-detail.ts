import type {
  PhiPluginCatalogDetail,
  PhiPluginCatalogDetailResult,
  PhiPluginCatalogEnvironment,
  PhiPluginDependency,
  PhiPluginDependencyManifest
} from '../../../shared/phiPluginDetailTypes'
import { isRecord } from '../../../shared/guards'
import {
  fetchOfficialWebsiteJson,
  type OfficialWebsiteRequestOptions
} from './official-website-transport'

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 15_000
const MAX_ITEMS = 256
const MAX_DEPENDENCIES = 2_048
const MAX_TEXT_BYTES = 64 * 1024

const limits = {
  identifier: 128,
  title: 160,
  summary: 2_000,
  description: 8_000,
  source: 160,
  version: 128,
  path: 4_096,
  note: 1_024,
  yaml: MAX_TEXT_BYTES
} as const

function requiredString(value: unknown, path: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value.replace(/\0/g, '').slice(0, limit)
}

function optionalString(value: unknown, path: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, path, limit)
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function stringArray(value: unknown, path: string, limit: number = limits.identifier): string[] {
  return requiredArray(value, path)
    .slice(0, MAX_ITEMS)
    .map((entry, index) => requiredString(entry, `${path}[${index}]`, limit))
}

function optionalStringArray(value: unknown, path: string): string[] {
  return value === undefined ? [] : stringArray(value, path)
}

function dependency(value: unknown, index: number): PhiPluginDependency {
  const path = `environment.dependencies[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  if (!['conda', 'pip', 'source', 'other'].includes(String(value.kind))) {
    throw new Error(`${path}.kind is invalid`)
  }
  const version = optionalString(value.version, `${path}.version`, limits.version)
  const note = optionalString(value.note, `${path}.note`, limits.note)
  return {
    name: requiredString(value.name, `${path}.name`, limits.identifier),
    kind: value.kind as PhiPluginDependency['kind'],
    ...(version !== undefined ? { version } : {}),
    ...(note !== undefined ? { note } : {})
  }
}

function dependencyManifest(value: Record<string, unknown>): PhiPluginDependencyManifest {
  const yamlText = optionalString(value.yamlText, 'environment.yamlText', limits.yaml)
  const sourceFile = optionalString(value.sourceFile, 'environment.sourceFile', limits.path)
  return {
    dependencies: requiredArray(value.dependencies, 'environment.dependencies')
      .slice(0, MAX_DEPENDENCIES)
      .map(dependency),
    ...(yamlText !== undefined ? { yamlText } : {}),
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    lookedFor: stringArray(value.lookedFor, 'environment.lookedFor', limits.path)
  }
}

function environment(value: unknown): PhiPluginCatalogEnvironment {
  if (!isRecord(value)) throw new Error('environment must be an object')
  const description = optionalString(
    value.description,
    'environment.description',
    limits.description
  )
  const sharedNote = optionalString(value.sharedNote, 'environment.sharedNote', limits.note)
  return {
    id: requiredString(value.id, 'environment.id', limits.identifier),
    title: requiredString(value.title, 'environment.title', limits.title),
    ...(description !== undefined ? { description } : {}),
    ...(sharedNote !== undefined ? { sharedNote } : {}),
    usedBySkills: optionalStringArray(value.usedBySkills, 'environment.usedBySkills'),
    usedByAgents: optionalStringArray(value.usedByAgents, 'environment.usedByAgents'),
    channels: optionalStringArray(value.channels, 'environment.channels'),
    dependencyManifest: dependencyManifest(value)
  }
}

function namedDescription(value: unknown, path: string): { name: string; description: string } {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return {
    name: requiredString(value.name, `${path}.name`, limits.identifier),
    description: optionalString(value.description, `${path}.description`, limits.description) ?? ''
  }
}

function scriptTool(value: unknown, index: number): PhiPluginCatalogDetail['scriptTools'][number] {
  const path = `scriptTools[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  // Approval and owner skill are display hints: an unfamiliar value hides that hint only,
  // so a new website field value never blanks the whole detail.
  const approval =
    value.approval === 'read' || value.approval === 'write' ? value.approval : undefined
  const skillName =
    typeof value.skill === 'string' && value.skill
      ? requiredString(value.skill, `${path}.skill`, limits.identifier)
      : undefined
  return {
    name: requiredString(value.name, `${path}.name`, limits.identifier),
    description: optionalString(value.description, `${path}.description`, limits.description) ?? '',
    ...(approval ? { approval } : {}),
    ...(skillName ? { skillName } : {})
  }
}

/** Validate and reduce the untrusted website response to the renderer's plain-text contract. */
export function validateOfficialWebsitePluginDetail(
  bytes: Buffer,
  requestedId: string
): PhiPluginCatalogDetail {
  if (!PLUGIN_ID.test(requestedId)) throw new Error('invalid plugin id')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('plugin detail response is not valid JSON')
  }
  return validatePluginDetailValue(value, requestedId)
}

function validatePluginDetailValue(value: unknown, requestedId: string): PhiPluginCatalogDetail {
  if (!PLUGIN_ID.test(requestedId)) throw new Error('invalid plugin id')
  if (!isRecord(value)) throw new Error('plugin detail response must be an object')
  if (value.kind !== 'plugin') throw new Error('plugin detail kind is invalid')
  const id = requiredString(value.slug, 'slug', limits.identifier)
  if (id !== requestedId) throw new Error('plugin detail id does not match the request')
  if (typeof value.official !== 'boolean') throw new Error('official must be a boolean')
  const agents = requiredArray(value.agents, 'agents')
    .slice(0, MAX_ITEMS)
    .map((entry, index) => namedDescription(entry, `agents[${index}]`))
  const skills = requiredArray(value.skills, 'skills')
    .slice(0, MAX_ITEMS)
    .map((entry, index) => namedDescription(entry, `skills[${index}]`))
  const scriptTools = requiredArray(value.scriptTools, 'scriptTools')
    .slice(0, MAX_ITEMS)
    .map(scriptTool)
  return {
    id,
    title: requiredString(value.title, 'title', limits.title),
    summary: optionalString(value.description, 'description', limits.summary) ?? '',
    version: requiredString(value.version, 'version', limits.version),
    source: requiredString(value.source, 'source', limits.source),
    official: value.official,
    agents,
    skills,
    scriptTools,
    environments: value.environment === undefined ? [] : [environment(value.environment)]
  }
}

/** Fetch one catalog detail. Every network or validation failure degrades to unavailable. */
export async function getOfficialWebsitePluginDetail(
  id: string,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiPluginCatalogDetailResult> {
  if (!PLUGIN_ID.test(id)) return { status: 'unavailable' }
  try {
    const value = await fetchOfficialWebsiteJson(
      `/api/plugins/${encodeURIComponent(id)}`,
      MAX_RESPONSE_BYTES,
      { ...options, timeoutMs: options.timeoutMs ?? MAX_TIMEOUT_MS }
    )
    return { status: 'available', detail: validatePluginDetailValue(value, id) }
  } catch {
    return { status: 'unavailable' }
  }
}
