import type {
  PhiPluginCatalogDetail,
  PhiPluginCatalogDetailReason,
  PhiPluginCatalogDetailResult,
  PhiPluginCatalogEnvironment,
  PhiPluginDependency,
  PhiPluginDependencyManifest
} from '../../../shared/phiPluginDetailTypes'
import { errorMessage } from '../../../shared/errorCodes'
import { isRecord } from '../../../shared/guards'
import { writeAppLog } from '../app-logger'
import {
  fetchOfficialWebsiteJson,
  OfficialWebsiteHttpError,
  type OfficialWebsiteRequestOptions
} from './official-website-transport'

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 15_000
const MAX_ITEMS = 256
const MAX_DEPENDENCIES = 2_048
const MAX_TEXT_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 300

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

/**
 * A transport failure is retryable only when it is not a definitive HTTP answer and the caller
 * did not cancel the request. Validation happens after a successful response and never retries.
 */
function isRetryableTransportError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (error instanceof OfficialWebsiteHttpError) return false
  if (error instanceof SyntaxError) return false
  return true
}

function failureReason(error: unknown): PhiPluginCatalogDetailReason {
  return error instanceof OfficialWebsiteHttpError && error.status === 404 ? 'not-found' : 'failed'
}

/** undici reports every transport problem as "fetch failed"; the cause names the real one. */
function describeFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (!(cause instanceof Error)) return errorMessage(error)
  const code = Reflect.get(cause, 'code')
  return `${errorMessage(error)}: ${typeof code === 'string' ? `${code} ` : ''}${cause.message}`
}

function logCatalogDetailFailure(
  id: string,
  reason: PhiPluginCatalogDetailReason,
  error: unknown
): void {
  // A 404 is a definitive answer, not a failure: local-only plugins legitimately reach it.
  if (reason !== 'failed') return
  writeAppLog({
    level: 'warn',
    event: 'plugin_catalog_detail_failed',
    metadata: {
      pluginId: id,
      reason,
      error: describeFailure(error).slice(0, MAX_ERROR_MESSAGE_LENGTH)
    }
  })
}

/**
 * Fetch one catalog detail. A transient network error or timeout is retried once; a 404, an
 * HTTP error, or a malformed/invalid payload is final. Every final failure is logged with the
 * plugin id and a bounded error message, never request credentials.
 */
export async function getOfficialWebsitePluginDetail(
  id: string,
  options: OfficialWebsiteRequestOptions = {}
): Promise<PhiPluginCatalogDetailResult> {
  if (!PLUGIN_ID.test(id)) return { status: 'unavailable', reason: 'not-found' }
  const requestOptions: OfficialWebsiteRequestOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? MAX_TIMEOUT_MS
  }
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let value: unknown
    try {
      value = await fetchOfficialWebsiteJson(
        `/api/plugins/${encodeURIComponent(id)}`,
        MAX_RESPONSE_BYTES,
        requestOptions
      )
    } catch (error) {
      lastError = error
      if (attempt === 0 && isRetryableTransportError(error, options.signal)) continue
      break
    }
    try {
      return { status: 'available', detail: validatePluginDetailValue(value, id) }
    } catch (error) {
      lastError = error
      break
    }
  }

  const reason = failureReason(lastError)
  logCatalogDetailFailure(id, reason, lastError)
  return { status: 'unavailable', reason }
}
