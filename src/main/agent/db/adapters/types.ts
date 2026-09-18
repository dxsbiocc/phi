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

export function domainSummaryFromManifest(domain: DbDomainManifest): DomainSummary {
  return {
    id: domain.id,
    summary: domain.summary,
    commonFields: domain.commonFields
  }
}
