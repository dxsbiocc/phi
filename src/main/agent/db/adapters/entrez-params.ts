import type { DbConnectorManifest, DbFilter, DbQueryParams } from '../manifest-types'
import { validateDbQueryWindow } from './types'

function valueToTerm(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueToTerm).join(' OR ')
  if (value === undefined || value === null) return ''
  return String(value)
}

function validateEntrezQueryInputs(params: DbQueryParams): void {
  validateDbQueryWindow(params, 'offset')
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery?.trim()) {
    throw new Error('Entrez filters and rawQuery cannot be used together')
  }
  const seenFields = new Set<string>()
  for (const filter of filters) {
    if (seenFields.has(filter.field)) throw new Error(`Entrez duplicate filter: ${filter.field}`)
    seenFields.add(filter.field)
  }
}

export function entrezTermFromFilters(filters: DbFilter[] = []): string {
  return filters
    .map((filter) => {
      const value = valueToTerm(filter.value)
      switch (filter.op) {
        case '=':
          return `${value}[${filter.field}]`
        case 'like':
          return `${value}[${filter.field}]`
        case 'in':
          return Array.isArray(filter.value)
            ? filter.value.map((item) => `${valueToTerm(item)}[${filter.field}]`).join(' OR ')
            : `${value}[${filter.field}]`
        case 'between':
          return Array.isArray(filter.value) && filter.value.length >= 2
            ? `${valueToTerm(filter.value[0])}:${valueToTerm(filter.value[1])}[${filter.field}]`
            : ''
        default:
          throw new Error(`Entrez adapter does not support filter op: ${filter.op}`)
      }
    })
    .filter(Boolean)
    .join(' AND ')
}

export function buildEntrezSearchParams(
  manifest: DbConnectorManifest,
  params: DbQueryParams
): URLSearchParams {
  validateEntrezQueryInputs(params)
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  const query = params.rawQuery ?? entrezTermFromFilters(params.filters)
  if (!query) throw new Error('Entrez query requires filters or rawQuery')

  return new URLSearchParams({
    db: domain.dbParam,
    term: query,
    retmode: 'json',
    retmax: String(params.limit),
    ...(params.cursor ? { retstart: params.cursor } : {})
  })
}

export function buildEntrezSummaryParams(
  manifest: DbConnectorManifest,
  params: Pick<DbQueryParams, 'domain'>,
  ids: string[]
): URLSearchParams {
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  return new URLSearchParams({
    db: domain.dbParam,
    id: ids.join(','),
    retmode: 'json'
  })
}

export function buildEntrezFetchParams(
  manifest: DbConnectorManifest,
  params: Pick<DbQueryParams, 'domain'>,
  ids: string[]
): URLSearchParams {
  const domain = manifest.domains.find((candidate) => candidate.id === params.domain)
  if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
  if (isEntrezFastaDomain(params.domain)) {
    return new URLSearchParams({
      db: domain.dbParam,
      id: ids.join(','),
      rettype: 'fasta',
      retmode: 'text'
    })
  }
  if (params.domain === 'geo') {
    return new URLSearchParams({
      db: domain.dbParam,
      id: ids.join(','),
      retmode: 'text'
    })
  }
  return new URLSearchParams({
    db: domain.dbParam,
    id: ids.join(','),
    retmode: 'xml'
  })
}

export function isEntrezFastaDomain(domain: string): boolean {
  return domain === 'protein' || domain === 'nucleotide'
}
