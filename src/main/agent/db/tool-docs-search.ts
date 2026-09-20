import type {
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFieldSchema,
  DbXrefRule
} from './manifest-types'

type DbDocsSearchKind = 'database' | 'domain' | 'field' | 'xref'

export interface DbDocsSearchResult {
  kind: DbDocsSearchKind
  database: string
  domain?: string
  field?: string
  title: string
  snippet: string
  score: number
  matchReasons: string[]
  protocolFamily?: string
  curationTier?: string
  trustTier?: string
  enabledForQuery?: boolean
  type?: string
  namespace?: string
  synonyms?: string[]
  nullable?: boolean
  common?: boolean
  xref?: {
    from: DbXrefRule['from']
    to: DbXrefRule['to']
  }
}

interface DbDocsSearchCandidate {
  result: Omit<DbDocsSearchResult, 'score' | 'matchReasons'>
  searchFields: Array<{ label: string; value: string; weight: number }>
}

export function docsSearchResults(
  entries: DbConnectorCatalogEntry[],
  options: {
    query: string
    database?: string
    domain?: string
    limit: number
  }
): DbDocsSearchResult[] {
  const tokens = tokenizeDocsQuery(options.query)
  return entries
    .filter((entry) => !options.database || entry.manifest.id === options.database)
    .flatMap(docsSearchCandidates)
    .filter((candidate) => !options.domain || candidate.result.domain === options.domain)
    .map((candidate) => ({ candidate, score: scoreDocsCandidate(candidate, tokens) }))
    .filter(({ score }) => tokens.length === 0 || score.score > 0)
    .sort((left, right) => {
      if (right.score.score !== left.score.score) return right.score.score - left.score.score
      return left.candidate.result.title.localeCompare(right.candidate.result.title)
    })
    .slice(0, options.limit)
    .map(({ candidate, score }) => ({
      ...candidate.result,
      score: score.score,
      matchReasons: score.matchReasons
    }))
}

function docsSearchCandidates(entry: DbConnectorCatalogEntry): DbDocsSearchCandidate[] {
  return [
    databaseDocsCandidate(entry),
    ...entry.manifest.domains.flatMap((domain) => [
      domainDocsCandidate(entry, domain),
      ...fieldDocsCandidates(entry, domain)
    ]),
    ...(entry.manifest.xref ?? []).map((xref) => xrefDocsCandidate(entry, xref))
  ]
}

function databaseDocsCandidate(entry: DbConnectorCatalogEntry): DbDocsSearchCandidate {
  const domainIds = entry.manifest.domains.map((domain) => domain.id)
  const title = `${entry.manifest.name} (${entry.manifest.id})`
  const snippet = `Domains: ${domainIds.join(', ')}. Protocol: ${entry.manifest.protocolFamily}.`
  return {
    result: {
      kind: 'database',
      database: entry.manifest.id,
      title,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 80 },
      { label: 'name', value: entry.manifest.name, weight: 60 },
      { label: 'protocol', value: entry.manifest.protocolFamily, weight: 25 },
      { label: 'domains', value: domainIds.join(' '), weight: 20 },
      {
        label: 'domain_summaries',
        value: entry.manifest.domains.map((domain) => domain.summary).join(' '),
        weight: 8
      }
    ]
  }
}

function domainDocsCandidate(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest
): DbDocsSearchCandidate {
  return {
    result: {
      kind: 'domain',
      database: entry.manifest.id,
      domain: domain.id,
      title: `${entry.manifest.id}/${domain.id}`,
      snippet: domain.summary,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 25 },
      { label: 'domain', value: domain.id, weight: 80 },
      { label: 'summary', value: domain.summary, weight: 35 },
      { label: 'common_fields', value: domain.commonFields.join(' '), weight: 30 },
      {
        label: 'fields',
        value: (domain.fields ?? []).map((field) => field.name).join(' '),
        weight: 15
      }
    ]
  }
}

function fieldDocsCandidates(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest
): DbDocsSearchCandidate[] {
  const commonFields = new Set(domain.commonFields)
  const candidates = (domain.fields ?? []).map((field) =>
    fieldDocsCandidate(entry, domain, field, commonFields.has(field.name))
  )
  const describedFields = new Set((domain.fields ?? []).map((field) => field.name))
  for (const commonField of domain.commonFields) {
    if (describedFields.has(commonField)) continue
    candidates.push(fieldDocsCandidate(entry, domain, { name: commonField, type: 'string' }, true))
  }
  return candidates
}

function fieldDocsCandidate(
  entry: DbConnectorCatalogEntry,
  domain: DbDomainManifest,
  field: DbFieldSchema,
  common: boolean
): DbDocsSearchCandidate {
  const snippet = field.description ?? `${field.name} is listed as a common field for ${domain.id}.`
  return {
    result: {
      kind: 'field',
      database: entry.manifest.id,
      domain: domain.id,
      field: field.name,
      title: `${entry.manifest.id}/${domain.id}/${field.name}`,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery,
      type: field.type,
      namespace: field.namespace,
      synonyms: field.synonyms,
      nullable: field.nullable,
      common
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 20 },
      { label: 'domain', value: domain.id, weight: 25 },
      { label: 'field', value: field.name, weight: 100 },
      { label: 'type', value: field.type, weight: 10 },
      { label: 'namespace', value: field.namespace ?? '', weight: 70 },
      { label: 'synonyms', value: (field.synonyms ?? []).join(' '), weight: 75 },
      { label: 'description', value: field.description ?? '', weight: 35 },
      { label: 'domain_summary', value: domain.summary, weight: 10 }
    ]
  }
}

function xrefDocsCandidate(
  entry: DbConnectorCatalogEntry,
  xref: DbXrefRule
): DbDocsSearchCandidate {
  const fromDatabase = xref.from.database ?? entry.manifest.id
  const toDatabase = xref.to.database ?? entry.manifest.id
  const title = `${fromDatabase}/${xref.from.domain}.${xref.from.field} -> ${toDatabase}/${xref.to.domain}.${xref.to.field}`
  const snippet = `Cross-reference from ${xref.from.namespace ?? xref.from.field} to ${xref.to.namespace ?? xref.to.field}.`
  return {
    result: {
      kind: 'xref',
      database: entry.manifest.id,
      domain: xref.from.domain,
      title,
      snippet,
      protocolFamily: entry.manifest.protocolFamily,
      curationTier: entry.manifest.curationTier,
      trustTier: entry.trustTier,
      enabledForQuery: entry.enabledForQuery,
      xref: { from: xref.from, to: xref.to }
    },
    searchFields: [
      { label: 'database', value: entry.manifest.id, weight: 20 },
      { label: 'from_database', value: fromDatabase, weight: 20 },
      { label: 'from_domain', value: xref.from.domain, weight: 30 },
      { label: 'from_field', value: xref.from.field, weight: 60 },
      { label: 'from_namespace', value: xref.from.namespace ?? '', weight: 70 },
      { label: 'from_species', value: xref.from.species ?? '', weight: 40 },
      { label: 'to_database', value: toDatabase, weight: 20 },
      { label: 'to_domain', value: xref.to.domain, weight: 30 },
      { label: 'to_field', value: xref.to.field, weight: 60 },
      { label: 'to_namespace', value: xref.to.namespace ?? '', weight: 70 },
      { label: 'to_species', value: xref.to.species ?? '', weight: 40 }
    ]
  }
}

function tokenizeDocsQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;，；/]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function scoreDocsCandidate(
  candidate: DbDocsSearchCandidate,
  tokens: string[]
): { score: number; matchReasons: string[] } {
  if (tokens.length === 0) return { score: 1, matchReasons: ['listed'] }
  let score = 0
  const matchReasons = new Set<string>()
  for (const token of tokens) {
    for (const field of candidate.searchFields) {
      const value = field.value.toLowerCase()
      if (!value) continue
      if (value === token) {
        score += field.weight * 3
        matchReasons.add(`${field.label}:exact`)
      } else if (value.split(/\W+/).includes(token)) {
        score += field.weight * 2
        matchReasons.add(`${field.label}:word`)
      } else if (value.includes(token)) {
        score += field.weight
        matchReasons.add(`${field.label}:partial`)
      }
    }
  }
  return { score, matchReasons: Array.from(matchReasons).sort() }
}
