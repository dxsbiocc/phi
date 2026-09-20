import type {
  DbAdapterQueryResult,
  DbDomainManifest,
  DbFieldSchema,
  DbQueryParams
} from '../manifest-types'
import type { DbEgressTransport } from '../policy'
import type { DefaultProxyMode } from '../../../../shared/appSettingsTypes'

export interface DbAdapterQueryContext {
  defaultProxyMode?: DefaultProxyMode
  proxyTransport?: DbEgressTransport
}

export interface DomainSummary {
  id: string
  summary: string
  commonFields: string[]
}

export interface DbAdapter {
  listDomains(): Promise<DomainSummary[]>
  describeDomain(domain: string): Promise<DbFieldSchema[]>
  query(params: DbQueryParams, context?: DbAdapterQueryContext): Promise<DbAdapterQueryResult>
}

export const DB_STANDARD_RECORD_FIELDS = [
  'source_database',
  'source_domain',
  'stable_id',
  'stable_id_namespace',
  'primary_url'
] as const

export function validateDbQueryWindow(
  params: Pick<DbQueryParams, 'limit' | 'cursor'>,
  cursorKind: 'opaque' | 'offset'
): void {
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 500) {
    throw new Error('database query limit must be an integer between 1 and 500')
  }
  if (params.cursor === undefined) return
  if (!params.cursor.trim()) throw new Error('database query cursor cannot be empty')
  if (cursorKind === 'offset') {
    const offset = Number(params.cursor)
    if (!/^\d+$/.test(params.cursor) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('database query cursor must be a non-negative integer offset')
    }
  }
}

export function validateDbRequestedFields(
  domain: DbDomainManifest,
  fields: string[] | undefined,
  extraAllowedFields: string[] = []
): void {
  if (!fields || fields.length === 0) return
  const allowedFields = new Set([
    ...domain.commonFields,
    ...(domain.fields ?? []).map((field) => field.name),
    ...DB_STANDARD_RECORD_FIELDS,
    ...extraAllowedFields
  ])
  const seenFields = new Set<string>()
  for (const field of fields) {
    if (seenFields.has(field)) throw new Error(`database query contains duplicate field: ${field}`)
    seenFields.add(field)
    if (!allowedFields.has(field)) {
      const allowed = [...allowedFields].sort().join(', ')
      throw new Error(
        `database domain ${domain.id} does not expose field: ${field}${
          allowed ? `; available fields: ${allowed}` : ''
        }`
      )
    }
  }
}

function identityValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined
  } catch {
    return undefined
  }
}

export function normalizeDbRecord(
  row: Record<string, unknown>,
  database: string,
  domain: DbDomainManifest
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...row,
    source_database: database,
    source_domain: domain.id
  }
  const stableId =
    domain.identity?.stableIdFields
      .map((field) => identityValue(row[field]))
      .find((value) => value !== undefined) ?? identityValue(row.stable_id)
  if (stableId) {
    normalized.stable_id = stableId
    if (domain.identity?.namespace) normalized.stable_id_namespace = domain.identity.namespace
  }

  const existingUrl = httpUrl(row.primary_url) ?? httpUrl(row.url)
  const templatedUrl =
    stableId && domain.identity?.primaryUrlTemplate
      ? domain.identity.primaryUrlTemplate.replaceAll('{stable_id}', encodeURIComponent(stableId))
      : undefined
  const primaryUrl = existingUrl ?? templatedUrl
  if (primaryUrl) normalized.primary_url = primaryUrl
  return normalized
}

export function projectDbRow(
  row: Record<string, unknown>,
  fields: string[] | undefined
): Record<string, unknown> {
  if (!fields || fields.length === 0) return row
  const projected = fields.reduce<Record<string, unknown>>((next, field) => {
    if (row[field] !== undefined) next[field] = row[field]
    return next
  }, {})
  for (const field of DB_STANDARD_RECORD_FIELDS) {
    if (row[field] !== undefined) projected[field] = row[field]
  }
  return projected
}

export function domainSummaryFromManifest(domain: DbDomainManifest): DomainSummary {
  return {
    id: domain.id,
    summary: domain.summary,
    commonFields: domain.commonFields
  }
}
