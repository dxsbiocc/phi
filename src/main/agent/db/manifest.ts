import { createHash } from 'node:crypto'

import { parse as parseYaml } from 'yaml'

import type {
  DbConnectorAuth,
  DbConnectorManifest,
  DbConnectorNetworkPolicy,
  DbConnectorRetryPolicy,
  DbCurationTier,
  DbFieldType,
  DbManifestParseResult,
  DbProtocolFamily
} from './manifest-types'

const SUPPORTED_VERSION = 1
const PROTOCOL_FAMILIES: DbProtocolFamily[] = [
  'entrez',
  'rest-json',
  'sparql',
  'ontology',
  'bulk-index',
  'generic-http'
]
const CURATION_TIERS: DbCurationTier[] = ['curated', 'generic']
const FIELD_TYPES: DbFieldType[] = ['string', 'number', 'boolean', 'date', 'object', 'array']
const AUTH_TYPES: DbConnectorAuth['type'][] = [
  'none',
  'api_key_query_param',
  'api_key_header',
  'bearer_token'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  )
  return values.length === value.length ? values : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    next[key] = item
  }
  return next
}

function primitiveRecord(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) return undefined
  const next: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      return undefined
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return undefined
    next[key] = item
  }
  return next
}

function validateAuth(auth: unknown, errors: string[]): void {
  if (auth === undefined) return
  if (!isRecord(auth)) {
    errors.push('auth 必须是对象')
    return
  }
  if (typeof auth.type !== 'string' || !AUTH_TYPES.includes(auth.type as DbConnectorAuth['type'])) {
    errors.push(`auth.type 必须是以下之一: ${AUTH_TYPES.join(', ')}`)
  }
  if (auth.envVar !== undefined && typeof auth.envVar !== 'string') {
    errors.push('auth.envVar 必须是字符串')
  }
  if (typeof auth.envVar === 'string' && !/^[A-Z_][A-Z0-9_]*$/i.test(auth.envVar)) {
    errors.push('auth.envVar 必须是环境变量名')
  }
  if (auth.paramName !== undefined && typeof auth.paramName !== 'string') {
    errors.push('auth.paramName 必须是字符串')
  }
  if (auth.headerName !== undefined && typeof auth.headerName !== 'string') {
    errors.push('auth.headerName 必须是字符串')
  }
}

function validateNetworkPolicy(
  baseUrl: unknown,
  policy: unknown,
  errors: string[]
): asserts policy is DbConnectorNetworkPolicy {
  if (!isRecord(policy)) {
    errors.push('networkPolicy 必须是对象')
    return
  }
  const allowedHosts = stringArray(policy.allowedHosts)
  if (!allowedHosts || allowedHosts.length === 0) {
    errors.push('networkPolicy.allowedHosts 必须是非空字符串数组')
    return
  }
  if (policy.allowRedirects !== undefined && typeof policy.allowRedirects !== 'boolean') {
    errors.push('networkPolicy.allowRedirects 必须是布尔值')
  }
  if (typeof baseUrl === 'string') {
    try {
      const parsed = new URL(baseUrl)
      if (!allowedHosts.includes(parsed.hostname)) {
        errors.push('networkPolicy.allowedHosts 必须包含 baseUrl 的 hostname')
      }
    } catch {
      // baseUrl validation reports this separately.
    }
  }
}

function validateRetryPolicy(policy: unknown, errors: string[]): void {
  if (policy === undefined) return
  if (!isRecord(policy)) {
    errors.push('retryPolicy 必须是对象')
    return
  }
  for (const key of ['maxAttempts', 'baseDelayMs', 'maxDelayMs'] satisfies Array<
    keyof DbConnectorRetryPolicy
  >) {
    if (
      policy[key] !== undefined &&
      (typeof policy[key] !== 'number' || policy[key] < 0 || !Number.isFinite(policy[key]))
    ) {
      errors.push(`retryPolicy.${key} 必须是非负数字`)
    }
  }
}

function validateField(field: unknown, path: string, errors: string[]): void {
  if (!isRecord(field)) {
    errors.push(`${path} 必须是对象`)
    return
  }
  if (typeof field.name !== 'string' || !field.name.trim()) {
    errors.push(`${path}.name 不能为空`)
  }
  if (typeof field.type !== 'string' || !FIELD_TYPES.includes(field.type as DbFieldType)) {
    errors.push(`${path}.type 必须是以下之一: ${FIELD_TYPES.join(', ')}`)
  }
  if (field.description !== undefined && typeof field.description !== 'string') {
    errors.push(`${path}.description 必须是字符串`)
  }
  if (field.synonyms !== undefined && !stringArray(field.synonyms)) {
    errors.push(`${path}.synonyms 必须是字符串数组`)
  }
  if (field.namespace !== undefined && typeof field.namespace !== 'string') {
    errors.push(`${path}.namespace 必须是字符串`)
  }
  if (field.nullable !== undefined && typeof field.nullable !== 'boolean') {
    errors.push(`${path}.nullable 必须是布尔值`)
  }
}

function validateRecordIdentity(
  identity: unknown,
  path: string,
  knownFields: Set<string>,
  errors: string[]
): void {
  if (identity === undefined) return
  if (!isRecord(identity)) {
    errors.push(`${path}.identity 必须是对象`)
    return
  }
  const stableIdFields = stringArray(identity.stableIdFields)
  if (!stableIdFields || stableIdFields.length === 0) {
    errors.push(`${path}.identity.stableIdFields 必须是非空字符串数组`)
  } else {
    for (const field of stableIdFields) {
      if (!knownFields.has(field)) {
        errors.push(`${path}.identity.stableIdFields 引用了未声明字段: ${field}`)
      }
    }
  }
  if (
    identity.namespace !== undefined &&
    (typeof identity.namespace !== 'string' || !identity.namespace.trim())
  ) {
    errors.push(`${path}.identity.namespace 必须是非空字符串`)
  }
  if (identity.primaryUrlTemplate !== undefined) {
    if (typeof identity.primaryUrlTemplate !== 'string') {
      errors.push(`${path}.identity.primaryUrlTemplate 必须是字符串`)
    } else {
      const tokens = [...identity.primaryUrlTemplate.matchAll(/\{([^{}]+)\}/g)].map(
        (match) => match[1]
      )
      if (tokens.length === 0 || tokens.some((token) => token !== 'stable_id')) {
        errors.push(`${path}.identity.primaryUrlTemplate 只支持 {stable_id} 占位符`)
      }
      try {
        const parsed = new URL(
          identity.primaryUrlTemplate.replaceAll('{stable_id}', 'example-identifier')
        )
        if (parsed.protocol !== 'https:') {
          errors.push(`${path}.identity.primaryUrlTemplate 必须使用 https`)
        }
      } catch {
        errors.push(`${path}.identity.primaryUrlTemplate 必须是合法 URL 模板`)
      }
    }
  }
}

function validateRestJsonDomain(
  rest: unknown,
  path: string,
  protocolFamily: DbProtocolFamily,
  errors: string[]
): void {
  if (rest === undefined) {
    if (protocolFamily === 'rest-json') {
      errors.push(`${path}.rest 是 rest-json connector 的必填配置`)
    }
    return
  }
  if (!isRecord(rest)) {
    errors.push(`${path}.rest 必须是对象`)
    return
  }
  if (!isRecord(rest.request)) {
    errors.push(`${path}.rest.request 必须是对象`)
    return
  }

  const request = isRecord(rest.request) ? rest.request : {}
  if (typeof request.path !== 'string' || !request.path.trim()) {
    errors.push(`${path}.rest.request.path 不能为空`)
  }
  if (request.method !== undefined && request.method !== 'GET' && request.method !== 'POST') {
    errors.push(`${path}.rest.request.method 只支持 GET 或 POST`)
  }
  if (request.idempotent !== undefined && typeof request.idempotent !== 'boolean') {
    errors.push(`${path}.rest.request.idempotent 必须是布尔值`)
  }
  if (request.queryParams !== undefined && !primitiveRecord(request.queryParams)) {
    errors.push(`${path}.rest.request.queryParams 必须是字符串/数字/布尔值对象`)
  }
  if (request.filterParamMap !== undefined && !stringRecord(request.filterParamMap)) {
    errors.push(`${path}.rest.request.filterParamMap 必须是字符串对象`)
  }
  if (request.jsonBodyParamMap !== undefined && !stringRecord(request.jsonBodyParamMap)) {
    errors.push(`${path}.rest.request.jsonBodyParamMap 必须是字符串对象`)
  }
  if (request.jsonBodyArrayFields !== undefined && !stringArray(request.jsonBodyArrayFields)) {
    errors.push(`${path}.rest.request.jsonBodyArrayFields 必须是字符串数组`)
  }
  if (
    request.jsonBodyOptionalFields !== undefined &&
    !stringArray(request.jsonBodyOptionalFields)
  ) {
    errors.push(`${path}.rest.request.jsonBodyOptionalFields 必须是字符串数组`)
  }
  for (const key of ['rawQueryParam', 'limitParam', 'cursorParam']) {
    if (request[key] !== undefined && typeof request[key] !== 'string') {
      errors.push(`${path}.rest.request.${key} 必须是字符串`)
    }
  }

  if (rest.response === undefined) return
  if (!isRecord(rest.response)) {
    errors.push(`${path}.rest.response 必须是对象`)
    return
  }
  const response = rest.response
  for (const key of ['rowsPath', 'totalRowsPath', 'nextCursorPath']) {
    if (response[key] !== undefined && typeof response[key] !== 'string') {
      errors.push(`${path}.rest.response.${key} 必须是字符串`)
    }
  }
  if (response.fieldMap !== undefined && !stringRecord(response.fieldMap)) {
    errors.push(`${path}.rest.response.fieldMap 必须是字符串对象`)
  }
}

function validateSparqlDomain(
  sparql: unknown,
  path: string,
  protocolFamily: DbProtocolFamily,
  errors: string[]
): void {
  if (sparql === undefined) {
    if (protocolFamily === 'sparql') {
      errors.push(`${path}.sparql 是 sparql connector 的必填配置`)
    }
    return
  }
  if (!isRecord(sparql)) {
    errors.push(`${path}.sparql 必须是对象`)
    return
  }
  if (typeof sparql.query !== 'string' || !sparql.query.trim()) {
    errors.push(`${path}.sparql.query 不能为空`)
  }
  if (sparql.prefixes !== undefined && !stringRecord(sparql.prefixes)) {
    errors.push(`${path}.sparql.prefixes 必须是字符串对象`)
  }
}

function validateManifestShape(raw: unknown): { errors: string[]; manifest?: DbConnectorManifest } {
  const errors: string[] = []
  if (!isRecord(raw)) return { errors: ['connector manifest 根节点必须是对象'] }

  if (raw.phiDbConnectorVersion !== SUPPORTED_VERSION) {
    errors.push(`不支持的 phiDbConnectorVersion: ${String(raw.phiDbConnectorVersion)}`)
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(raw.id)) {
    errors.push('id 必须是形如 "<protocol-family>/<short-id>" 的规范化 id')
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    errors.push('name 不能为空')
  }
  if (
    typeof raw.protocolFamily !== 'string' ||
    !PROTOCOL_FAMILIES.includes(raw.protocolFamily as DbProtocolFamily)
  ) {
    errors.push(`protocolFamily 必须是以下之一: ${PROTOCOL_FAMILIES.join(', ')}`)
  }
  if (
    typeof raw.curationTier !== 'string' ||
    !CURATION_TIERS.includes(raw.curationTier as DbCurationTier)
  ) {
    errors.push(`curationTier 必须是以下之一: ${CURATION_TIERS.join(', ')}`)
  }
  if (
    raw.trustTier !== undefined ||
    raw.installedAt !== undefined ||
    raw.sourcePath !== undefined
  ) {
    errors.push('trustTier/installedAt/sourcePath 只能来自 .source.json，不能写在 connector.yaml')
  }
  if (typeof raw.baseUrl !== 'string') {
    errors.push('baseUrl 必须是字符串')
  } else {
    try {
      const parsed = new URL(raw.baseUrl)
      if (parsed.protocol !== 'https:') errors.push('baseUrl 默认必须使用 https')
    } catch {
      errors.push('baseUrl 必须是合法 URL')
    }
  }

  validateNetworkPolicy(raw.baseUrl, raw.networkPolicy, errors)
  validateAuth(raw.auth, errors)
  validateRetryPolicy(raw.retryPolicy, errors)

  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    errors.push('domains 必须是非空数组')
  } else {
    const domainIds = new Set<string>()
    raw.domains.forEach((domain, index) => {
      const path = `domains[${index}]`
      if (!isRecord(domain)) {
        errors.push(`${path} 必须是对象`)
        return
      }
      if (typeof domain.id !== 'string' || !/^[a-z0-9_-]+$/.test(domain.id)) {
        errors.push(`${path}.id 必须是规范化字符串`)
      } else if (domainIds.has(domain.id)) {
        errors.push(`${path}.id 重复: ${domain.id}`)
      } else {
        domainIds.add(domain.id)
      }
      if (domain.dbParam !== undefined && typeof domain.dbParam !== 'string') {
        errors.push(`${path}.dbParam 必须是字符串`)
      }
      if (typeof domain.summary !== 'string' || !domain.summary.trim()) {
        errors.push(`${path}.summary 不能为空`)
      }
      if (!stringArray(domain.commonFields)) {
        errors.push(`${path}.commonFields 必须是字符串数组`)
      }
      if (domain.fields !== undefined) {
        if (!Array.isArray(domain.fields)) {
          errors.push(`${path}.fields 必须是数组`)
        } else {
          domain.fields.forEach((field, fieldIndex) =>
            validateField(field, `${path}.fields[${fieldIndex}]`, errors)
          )
        }
      }
      const knownFields = new Set(stringArray(domain.commonFields) ?? [])
      if (Array.isArray(domain.fields)) {
        for (const field of domain.fields) {
          if (isRecord(field) && typeof field.name === 'string') knownFields.add(field.name)
        }
      }
      validateRecordIdentity(domain.identity, path, knownFields, errors)
      validateRestJsonDomain(
        domain.rest,
        path,
        typeof raw.protocolFamily === 'string'
          ? (raw.protocolFamily as DbProtocolFamily)
          : 'generic-http',
        errors
      )
      validateSparqlDomain(
        domain.sparql,
        path,
        typeof raw.protocolFamily === 'string'
          ? (raw.protocolFamily as DbProtocolFamily)
          : 'generic-http',
        errors
      )
    })
  }

  if (errors.length > 0) return { errors }
  return { errors: [], manifest: raw as unknown as DbConnectorManifest }
}

export function parseDbConnectorManifest(rawYamlText: string): DbManifestParseResult {
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
  if (!manifest) return { valid: false, errors }
  return { valid: true, errors: [], manifest }
}

export function canonicalDbConnectorDigest(manifest: DbConnectorManifest): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(manifest)))
    .digest('hex')}`
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((next, key) => {
        next[key] = sortKeysDeep(value[key])
        return next
      }, {})
  }
  return value
}
