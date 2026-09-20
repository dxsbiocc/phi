import type {
  DbAdapterQueryResult,
  DbConnectorManifest,
  DbDownloadFileCandidate,
  DbFieldSchema,
  DbFilter,
  DbQueryParams
} from '../manifest-types'
import { executeDbHttpRequest, type DbEgressTransport, type DbSleep } from '../policy'
import type { DbAdapter, DbAdapterQueryContext, DomainSummary } from './types'
import {
  domainSummaryFromManifest,
  normalizeDbRecord,
  projectDbRow,
  validateDbQueryWindow,
  validateDbRequestedFields
} from './types'

interface EntrezAdapterOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface EntrezSearchResult {
  ids: string[]
  totalRows?: number
  nextCursor?: string
}

interface EntrezQueryResponse {
  attempts: number
  retried: boolean
  lastStatus: number
  transportName: string
  defaultProxyMode: NonNullable<DbAdapterQueryContext['defaultProxyMode']>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

export class EntrezAdapter implements DbAdapter {
  constructor(
    private readonly manifest: DbConnectorManifest,
    private readonly options: EntrezAdapterOptions = {}
  ) {}

  async listDomains(): Promise<DomainSummary[]> {
    return this.manifest.domains.map(domainSummaryFromManifest)
  }

  async describeDomain(domain: string): Promise<DbFieldSchema[]> {
    return this.manifest.domains.find((candidate) => candidate.id === domain)?.fields ?? []
  }

  async query(
    params: DbQueryParams,
    context: DbAdapterQueryContext = {}
  ): Promise<DbAdapterQueryResult> {
    const domain = this.manifest.domains.find((candidate) => candidate.id === params.domain)
    if (!domain?.dbParam) throw new Error(`Unknown Entrez domain: ${params.domain}`)
    validateDbRequestedFields(domain, params.fields)
    const searchParams = buildEntrezSearchParams(this.manifest, params)
    const response = await executeDbHttpRequest({
      manifest: this.manifest,
      path: 'esearch.fcgi',
      searchParams,
      method: 'GET',
      defaultProxyMode: context.defaultProxyMode,
      transport: this.options.transport,
      proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
      sleep: this.options.sleep,
      timeoutMs: this.options.timeoutMs,
      idempotent: true
    })
    const searchResult = parseEntrezSearchResponse(await response.response.json(), params)
    const summaryResponse =
      searchResult.ids.length === 0
        ? undefined
        : await executeDbHttpRequest({
            manifest: this.manifest,
            path: 'esummary.fcgi',
            searchParams: buildEntrezSummaryParams(this.manifest, params, searchResult.ids),
            method: 'GET',
            defaultProxyMode: context.defaultProxyMode,
            transport: this.options.transport,
            proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
            sleep: this.options.sleep,
            timeoutMs: this.options.timeoutMs,
            idempotent: true
          })
    const rows = summaryResponse
      ? parseEntrezSummaryResponse(
          await summaryResponse.response.json(),
          searchResult.ids,
          params.domain
        )
      : []
    const fetchResponse =
      shouldFetchEntrezDomain(params.domain) && searchResult.ids.length > 0
        ? await executeDbHttpRequest({
            manifest: this.manifest,
            path: 'efetch.fcgi',
            searchParams: buildEntrezFetchParams(this.manifest, params, searchResult.ids),
            method: 'GET',
            defaultProxyMode: context.defaultProxyMode,
            transport: this.options.transport,
            proxyTransport: context.proxyTransport ?? this.options.proxyTransport,
            sleep: this.options.sleep,
            timeoutMs: this.options.timeoutMs,
            idempotent: true
          })
        : undefined
    const rowsWithFetch = fetchResponse
      ? addEntrezFetchFields(params.domain, rows, await fetchResponse.response.text())
      : rows
    const projectedRows = rowsWithFetch.map((row) =>
      projectDbRow(normalizeDbRecord(row, this.manifest.id, domain), params.fields)
    )
    const provenance = combineEntrezQueryResponses(response, summaryResponse, fetchResponse)
    return {
      rows: projectedRows,
      totalRows: searchResult.totalRows,
      truncated: Boolean(searchResult.nextCursor),
      nextCursor: searchResult.nextCursor,
      provenance: {
        database: this.manifest.id,
        domain: params.domain,
        retrievedAt: (this.options.now?.() ?? new Date()).toISOString(),
        rawQueryUsed: Boolean(params.rawQuery),
        attempts: provenance.attempts,
        retried: provenance.retried,
        lastStatus: provenance.lastStatus,
        transportName: provenance.transportName,
        defaultProxyMode: provenance.defaultProxyMode
      }
    }
  }
}

function parseEntrezSearchResponse(payload: unknown, params: DbQueryParams): EntrezSearchResult {
  if (!isRecord(payload) || !isRecord(payload.esearchresult)) {
    throw new Error('Unexpected Entrez esearch response shape')
  }
  const result = payload.esearchresult
  const ids = Array.isArray(result.idlist)
    ? result.idlist.filter((item): item is string => typeof item === 'string')
    : []
  const totalRows = parseOptionalNumber(result.count)
  const start = parseOptionalNumber(params.cursor) ?? 0
  const nextStart = start + ids.length
  const nextCursor =
    totalRows !== undefined && ids.length > 0 && nextStart < totalRows
      ? String(nextStart)
      : undefined

  return {
    ids,
    totalRows,
    nextCursor
  }
}

function parseEntrezSummaryResponse(
  payload: unknown,
  ids: string[],
  domain: string
): Record<string, unknown>[] {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new Error('Unexpected Entrez esummary response shape')
  }
  const result = payload.result
  return ids.map((uid) => {
    const summary = result[uid]
    return normalizeEntrezSummaryRow(uid, isRecord(summary) ? summary : {}, domain)
  })
}

function combineEntrezQueryResponses(
  first: EntrezQueryResponse,
  ...rest: Array<EntrezQueryResponse | undefined>
): EntrezQueryResponse {
  const responses = [first, ...rest].filter(
    (response): response is EntrezQueryResponse => response !== undefined
  )
  const last = responses[responses.length - 1]
  return {
    attempts: responses.reduce((total, response) => total + response.attempts, 0),
    retried: responses.some((response) => response.retried),
    lastStatus: last.lastStatus,
    transportName: last.transportName,
    defaultProxyMode: last.defaultProxyMode
  }
}

function normalizeEntrezSummaryRow(
  uid: string,
  summary: Record<string, unknown>,
  domain: string
): Record<string, unknown> {
  const row: Record<string, unknown> = { uid }
  if (domain === 'gene') addGeneSummaryFields(row, summary)
  if (domain === 'pubmed') addPubmedSummaryFields(row, summary)
  if (domain === 'protein') addProteinSummaryFields(row, summary)
  if (domain === 'nucleotide') addNucleotideSummaryFields(row, summary)
  if (domain === 'biosample') addBioSampleSummaryFields(row, summary)
  if (domain === 'sra') addSraSummaryFields(row, summary)
  if (domain === 'geo') addGeoSummaryFields(row, summary)
  if (domain === 'bioproject') addBioProjectSummaryFields(row, summary)
  if (domain === 'taxonomy') addTaxonomySummaryFields(row, summary)
  if (domain === 'clinvar') addClinvarSummaryFields(row, summary)

  for (const [key, value] of Object.entries(summary)) {
    if (key === 'uid' || key === 'error') continue
    if (domain === 'sra' && (key === 'expxml' || key === 'runs')) continue
    if (row[key] === undefined) row[key] = value
  }
  return row
}

function addGeneSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const symbol = firstString(summary.name, summary.nomenclaturesymbol)
  if (symbol) row.symbol = symbol
  const description = firstString(summary.description, summary.summary)
  if (description) row.description = description
  const chromosome = firstString(summary.chromosome)
  if (chromosome) row.chromosome = chromosome
  const aliases = aliasesFrom(summary.otheraliases)
  if (aliases.length > 0) row.aliases = aliases
  const mapLocation = firstString(summary.maplocation)
  if (mapLocation) row.mapLocation = mapLocation
  if (isRecord(summary.organism)) {
    row.organism = {
      scientificName: summary.organism.scientificname,
      commonName: summary.organism.commonname,
      taxId: summary.organism.taxid
    }
  }
}

function addPubmedSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const pubdate = firstString(summary.pubdate, summary.epubdate)
  if (pubdate) row.pubdate = pubdate
  const journal = firstString(summary.fulljournalname, summary.source)
  if (journal) row.journal = journal
  const authors = authorNames(summary.authors)
  if (authors.length > 0) row.authors = authors
  const doi = articleId(summary.articleids, 'doi')
  if (doi) row.doi = doi
}

function addProteinSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accessionversion, summary.caption, summary.accession)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
}

function addNucleotideSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accessionversion, summary.caption, summary.accession)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
  const sequenceLength = parseOptionalNumber(summary.slen) ?? parseOptionalNumber(summary.length)
  if (sequenceLength !== undefined) row.sequence_length = sequenceLength
  const moleculeType = firstString(summary.moltype, summary.biomol)
  if (moleculeType) row.molecule_type = moleculeType
}

function addBioSampleSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accession, summary.accessionversion, summary.caption)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname, summary.organism_name)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const sampleName = firstString(summary.samplename, summary.sample_name)
  if (sampleName) row.sample_name = sampleName
  const owner = firstString(summary.owner, summary.ownername, summary.owner_name)
  if (owner) row.owner = owner
  const packageName = firstString(summary.package, summary.package_name)
  if (packageName) row.package = packageName
  const model = firstString(summary.model)
  if (model) row.model = model
}

function addSraSummaryFields(row: Record<string, unknown>, summary: Record<string, unknown>): void {
  const accession = firstString(
    summary.accession,
    summary.experiment_accession,
    summary.run_accession,
    summary.study_accession,
    summary.caption
  )
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.exptitle, summary.studytitle)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const experimentAccession = firstString(summary.experiment_accession, summary.experiment)
  if (experimentAccession) row.experiment_accession = experimentAccession
  const studyAccession = firstString(summary.study_accession, summary.study)
  if (studyAccession) row.study_accession = studyAccession
  const sampleAccession = firstString(summary.sample_accession, summary.sample)
  if (sampleAccession) row.sample_accession = sampleAccession
  const biosampleAccession = firstString(summary.biosample_accession, summary.biosample)
  if (biosampleAccession) row.biosample_accession = biosampleAccession
  addSraEmbeddedSummaryFields(row, summary)
}

function addSraEmbeddedSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const expxml = firstString(summary.expxml)
  if (expxml) {
    const experimentTag = expxml.match(/<Experiment\b[^>]*>/i)?.[0] ?? ''
    const studyTag = expxml.match(/<Study\b[^>]*>/i)?.[0] ?? ''
    const sampleTag = expxml.match(/<Sample\b[^>]*>/i)?.[0] ?? ''
    const organismTag = expxml.match(/<Organism\b[^>]*>/i)?.[0] ?? ''
    const platformTag = expxml.match(/<Platform\b[^>]*>/i)?.[0] ?? ''
    const experimentAccession = xmlAttr(experimentTag, 'acc')
    const studyAccession = xmlAttr(studyTag, 'acc')
    const sampleAccession = xmlAttr(sampleTag, 'acc')
    if (experimentAccession) {
      if (!row.accession) row.accession = experimentAccession
      if (!row.experiment_accession) row.experiment_accession = experimentAccession
    }
    if (studyAccession && !row.study_accession) row.study_accession = studyAccession
    if (sampleAccession && !row.sample_accession) row.sample_accession = sampleAccession
    if (!row.biosample_accession) {
      const biosample = firstSraTagText(expxml, 'Biosample')
      if (biosample) row.biosample_accession = biosample
    }
    if (!row.bioproject_accession) {
      const bioproject = firstSraTagText(expxml, 'Bioproject')
      if (bioproject) row.bioproject_accession = bioproject
    }
    if (!row.title) {
      const title = firstSraTagText(expxml, 'Title')
      if (title) row.title = title
    }
    if (!row.organism) {
      const organism = xmlAttr(organismTag, 'ScientificName')
      if (organism) row.organism = organism
    }
    if (!row.tax_id) {
      const taxId = parseOptionalNumber(xmlAttr(organismTag, 'taxid'))
      if (taxId !== undefined) row.tax_id = taxId
    }
    if (!row.platform) {
      const platform = normalizeXmlText(
        expxml.match(/<Platform\b[^>]*>([\s\S]*?)<\/Platform>/i)?.[1] ?? ''
      )
      if (platform) row.platform = platform
    }
    if (!row.instrument_model) {
      const instrumentModel = xmlAttr(platformTag, 'instrument_model')
      if (instrumentModel) row.instrument_model = instrumentModel
    }
  }

  const runsXml = firstString(summary.runs)
  if (runsXml) {
    const runAccessions = uniqueStrings(
      [...runsXml.matchAll(/<Run\b[^>]*>/gi)]
        .map((match) => xmlAttr(match[0], 'acc'))
        .filter((value): value is string => value !== undefined)
    )
    if (runAccessions.length > 0) row.run_accessions = runAccessions
  }
  delete row.expxml
  delete row.runs
}

function addGeoSummaryFields(row: Record<string, unknown>, summary: Record<string, unknown>): void {
  const accession =
    firstString(summary.accession) ??
    prefixedGeoAccession('GSE', summary.gse) ??
    prefixedGeoAccession('GDS', summary.gds) ??
    prefixedGeoAccession('GPL', summary.gpl)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.seriestitle, summary.platformtitle)
  if (title) row.title = title
  const summaryText = firstString(summary.summary)
  if (summaryText) row.summary = summaryText
  const organism = firstString(summary.taxon, summary.platformtaxa, summary.samplestaxa)
  if (organism) row.organism = organism
  const entryType = firstString(summary.entrytype)
  if (entryType) row.entry_type = entryType
  const gdsType = firstString(summary.gdstype, summary.ptechtype, summary.valtype)
  if (gdsType) row.gds_type = gdsType
  const seriesAccession = prefixedGeoAccession('GSE', summary.gse)
  if (seriesAccession) row.series_accession = seriesAccession
  const platformAccession = prefixedGeoAccession('GPL', summary.gpl)
  if (platformAccession) row.platform_accession = platformAccession
  const datasetAccession = prefixedGeoAccession('GDS', summary.gds)
  if (datasetAccession) row.dataset_accession = datasetAccession
  const samples = geoSamplesFromSummary(summary.samples)
  if (samples.length > 0) {
    row.samples = samples
    row.sample_accessions = uniqueStrings(
      samples.map((sample) => sample.accession).filter(Boolean) as string[]
    )
  }
  const sampleCount = parseOptionalNumber(summary.n_samples)
  if (sampleCount !== undefined) row.sample_count = sampleCount
  const pubmedIds = geoStringArray(summary.pubmedids)
  if (pubmedIds.length > 0) row.pubmed_ids = pubmedIds
  const bioproject = firstString(summary.bioproject)
  if (bioproject) row.bioproject_accession = bioproject
  const ftpLink = firstString(summary.ftplink)
  if (ftpLink) row.ftp_link = ftpLink
  const geo2rAvailable = parseGeoBoolean(summary.geo2r)
  if (geo2rAvailable !== undefined) row.geo2r_available = geo2rAvailable
  const publishedDate = firstString(summary.pdat)
  if (publishedDate) row.published_date = publishedDate
  addGeoDownloadUrls(row, seriesAccession ?? accession)
}

function addBioProjectSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.project_acc, summary.accession)
  if (accession) row.accession = accession
  const projectId = parseOptionalNumber(summary.project_id)
  if (projectId !== undefined) row.project_id = projectId
  const title = firstString(summary.project_title, summary.title)
  if (title) row.title = title
  const name = firstString(summary.project_name, summary.name)
  if (name) row.name = name
  const description = firstString(summary.project_description, summary.description)
  if (description) row.description = description
  const organism = firstString(summary.organism_name, summary.organism)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const projectType = firstString(summary.project_type)
  if (projectType) row.project_type = projectType
  const dataType = firstString(summary.project_data_type)
  if (dataType) row.data_type = dataType
  const targetScope = firstString(summary.project_target_scope)
  if (targetScope) row.target_scope = targetScope
  const targetMaterial = firstString(summary.project_target_material)
  if (targetMaterial) row.target_material = targetMaterial
  const targetCapture = firstString(summary.project_target_capture)
  if (targetCapture) row.target_capture = targetCapture
  const methodType = firstString(summary.project_methodtype)
  if (methodType) row.method_type = methodType
  const objectives = bioProjectObjectivesFromSummary(summary.project_objectives_list)
  if (objectives.length > 0) row.objectives = objectives
  const relevance = bioProjectRelevanceFromSummary(summary)
  if (Object.keys(relevance).length > 0) row.relevance = relevance
  const submitterOrganization = firstString(
    summary.submitter_organization,
    Array.isArray(summary.submitter_organization_list)
      ? summary.submitter_organization_list[0]
      : undefined
  )
  if (submitterOrganization) row.submitter_organization = submitterOrganization
  const registrationDate = firstString(summary.registration_date)
  if (registrationDate) row.registration_date = registrationDate
  const supergroup = firstString(summary.supergroup)
  if (supergroup) row.supergroup = supergroup
  const sequencingStatus = firstString(summary.sequencing_status)
  if (sequencingStatus) row.sequencing_status = sequencingStatus
}

function addTaxonomySummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const scientificName = firstString(summary.scientificname, summary.scientific_name, summary.title)
  if (scientificName) row.scientific_name = scientificName
  const commonName = firstString(summary.commonname, summary.common_name)
  if (commonName) row.common_name = commonName
  const rank = firstString(summary.rank)
  if (rank) row.rank = rank
  const division = firstString(summary.division)
  if (division) row.division = division
  const lineage = firstString(summary.lineage)
  if (lineage) row.lineage = lineage
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(row.uid)
  if (taxId !== undefined) row.tax_id = taxId
  const parentTaxId =
    parseOptionalNumber(summary.parent_tax_id) ??
    parseOptionalNumber(summary.parenttaxid) ??
    parseOptionalNumber(summary.parentid)
  if (parentTaxId !== undefined) row.parent_tax_id = parentTaxId
}

function addClinvarSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const accession = firstString(summary.accession)
  if (accession) row.accession = accession
  const variationId = firstString(summary.variation_id, summary.variationid, summary.uid)
  if (variationId) row.variation_id = variationId
  const clinicalSignificance = firstString(
    summary.clinical_significance,
    summary.clinicalsignificance,
    isRecord(summary.clinical_significance) ? summary.clinical_significance.description : undefined
  )
  if (clinicalSignificance) row.clinical_significance = clinicalSignificance
  const gene = firstString(summary.gene, summary.genesymbol)
  if (gene) row.gene = gene
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function aliasesFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (isRecord(item)) return firstString(item.name)
      return undefined
    })
    .filter((item): item is string => item !== undefined)
}

function articleId(value: unknown, idType: string): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (!isRecord(item)) continue
    if (firstString(item.idtype)?.toLowerCase() === idType) return firstString(item.value, item.id)
  }
  return undefined
}

function shouldFetchEntrezDomain(domain: string): boolean {
  return (
    domain === 'gene' ||
    domain === 'pubmed' ||
    domain === 'biosample' ||
    domain === 'sra' ||
    domain === 'geo' ||
    domain === 'bioproject' ||
    domain === 'taxonomy' ||
    domain === 'clinvar' ||
    isEntrezFastaDomain(domain)
  )
}

function isEntrezFastaDomain(domain: string): boolean {
  return domain === 'protein' || domain === 'nucleotide'
}

function addEntrezFetchFields(
  domain: string,
  rows: Record<string, unknown>[],
  payload: string
): Record<string, unknown>[] {
  if (domain === 'gene') return addGeneFetchDetails(rows, payload)
  if (domain === 'pubmed') return addPubmedFetchDetails(rows, payload)
  if (domain === 'biosample') return addBioSampleFetchDetails(rows, payload)
  if (domain === 'sra') return addSraFetchDetails(rows, payload)
  if (domain === 'geo') return addGeoFetchDetails(rows, payload)
  if (domain === 'bioproject') return addBioProjectFetchDetails(rows, payload)
  if (domain === 'taxonomy') return addTaxonomyFetchDetails(rows, payload)
  if (domain === 'clinvar') return addClinvarFetchDetails(rows, payload)
  if (isEntrezFastaDomain(domain)) return addFastaSequences(rows, payload)
  return rows
}

interface GeneFetchDetails {
  symbol?: string
  description?: string
  summary?: string
  aliases?: string[]
  mapLocation?: string
  gene_type?: string
  organism?: {
    scientificName?: string
    taxId?: number
  }
  tax_id?: number
}

function addGeneFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseGeneFetchXml(xml)
  return rows.map((row) => {
    const uid = firstString(row.uid)
    const match = uid ? details.get(uid) : undefined
    return match ? mergeGeneDetails(row, match) : row
  })
}

function mergeGeneDetails(
  row: Record<string, unknown>,
  details: GeneFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'aliases') {
        const aliases = uniqueStrings([...aliasesFrom(merged.aliases), ...value])
        if (aliases.length > 0) merged.aliases = aliases
      }
      continue
    }
    if (key === 'organism' && isRecord(value)) {
      merged.organism = isRecord(merged.organism) ? { ...value, ...merged.organism } : value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseGeneFetchXml(xml: string): Map<string, GeneFetchDetails> {
  const details = new Map<string, GeneFetchDetails>()
  for (const match of xml.matchAll(/<Entrezgene\b[\s\S]*?<\/Entrezgene>/g)) {
    const record = match[0]
    const uid = firstGeneTagText(record, 'Gene-track_geneid')
    if (!uid) continue
    details.set(uid, parseGeneRecord(record))
  }
  return details
}

function parseGeneRecord(record: string): GeneFetchDetails {
  const taxId = parseGeneTaxId(record)
  const scientificName = firstGeneTagText(record, 'Org-ref_taxname')
  const organism =
    scientificName || taxId !== undefined
      ? {
          scientificName,
          taxId
        }
      : undefined
  const geneTypeTag = record.match(/<Entrezgene_type\b[^>]*>/)?.[0] ?? ''
  return {
    symbol: firstGeneTagText(record, 'Gene-ref_locus'),
    description: firstGeneTagText(record, 'Gene-ref_desc'),
    summary: firstGeneTagText(record, 'Entrezgene_summary'),
    aliases: uniqueStrings(
      [...record.matchAll(/<Gene-ref_syn_E\b[^>]*>([\s\S]*?)<\/Gene-ref_syn_E>/g)]
        .map((match) => normalizeXmlText(match[1]))
        .filter(Boolean)
    ),
    mapLocation:
      firstGeneTagText(record, 'Maps_display-str') ?? firstGeneTagText(record, 'Gene-ref_maploc'),
    gene_type: xmlAttr(geneTypeTag, 'value'),
    organism,
    tax_id: taxId
  }
}

function firstGeneTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function parseGeneTaxId(record: string): number | undefined {
  const match = record.match(
    /<Dbtag_db>\s*taxon\s*<\/Dbtag_db>[\s\S]*?<Object-id_id>(\d+)<\/Object-id_id>/
  )
  return parseOptionalNumber(match?.[1])
}

interface PubmedFetchDetails {
  abstract?: string
  mesh_terms?: string[]
  keywords?: string[]
  publication_types?: string[]
}

function addPubmedFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parsePubmedFetchXml(xml)
  return rows.map((row) => {
    const match = typeof row.uid === 'string' ? details.get(row.uid) : undefined
    return match ? mergePubmedDetails(row, match) : row
  })
}

function mergePubmedDetails(
  row: Record<string, unknown>,
  details: PubmedFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function addFastaSequences(
  rows: Record<string, unknown>[],
  fasta: string
): Record<string, unknown>[] {
  const sequences = parseFastaSequences(fasta)
  return rows.map((row) => {
    const sequence = lookupFastaSequence(row, sequences)
    return sequence ? { ...row, sequence } : row
  })
}

function lookupFastaSequence(
  row: Record<string, unknown>,
  sequences: Map<string, string>
): string | undefined {
  const candidates = [firstString(row.accession), firstString(row.uid)].filter(
    (value): value is string => value !== undefined
  )
  for (const candidate of candidates) {
    const exact = sequences.get(candidate)
    if (exact) return exact
    const versionless = stripAccessionVersion(candidate)
    if (versionless !== candidate) {
      const match = sequences.get(versionless)
      if (match) return match
    }
  }
  return undefined
}

function parseFastaSequences(fasta: string): Map<string, string> {
  const sequences = new Map<string, string>()
  let header: string | undefined
  let parts: string[] = []
  const flush = (): void => {
    if (!header) return
    const sequence = parts.join('').replace(/\s+/g, '')
    if (!sequence) return
    for (const key of fastaHeaderKeys(header)) {
      if (!sequences.has(key)) sequences.set(key, sequence)
    }
  }

  for (const rawLine of fasta.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('>')) {
      flush()
      header = line.slice(1).trim()
      parts = []
    } else if (header) {
      parts.push(line)
    }
  }
  flush()
  return sequences
}

function fastaHeaderKeys(header: string): string[] {
  const keys = new Set<string>()
  const firstToken = header.split(/\s+/)[0]
  addFastaKey(keys, firstToken)
  for (const token of firstToken.split('|')) addFastaKey(keys, token)
  for (const match of header.matchAll(/[A-Z]{1,3}_\d+(?:\.\d+)?/g)) {
    addFastaKey(keys, match[0])
  }
  return Array.from(keys)
}

function addFastaKey(keys: Set<string>, value: string): void {
  const key = value.trim()
  if (!key) return
  keys.add(key)
  keys.add(stripAccessionVersion(key))
}

function stripAccessionVersion(value: string): string {
  return value.replace(/\.\d+$/, '')
}

interface BioSampleFetchDetails {
  uid?: string
  accession?: string
  title?: string
  organism?: string
  tax_id?: number
  sample_name?: string
  owner?: string
  package?: string
  model?: string
  attributes?: Record<string, string>
  collection_date?: string
  geo_loc_name?: string
  tissue?: string
  isolation_source?: string
}

function addBioSampleFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseBioSampleFetchXml(xml)
  return rows.map((row) => {
    const match = lookupBioSampleDetails(row, details)
    return match ? mergeBioSampleDetails(row, match) : row
  })
}

function lookupBioSampleDetails(
  row: Record<string, unknown>,
  details: Map<string, BioSampleFetchDetails>
): BioSampleFetchDetails | undefined {
  const candidates = [firstString(row.uid), firstString(row.accession)].filter(
    (value): value is string => value !== undefined
  )
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeBioSampleDetails(
  row: Record<string, unknown>,
  details: BioSampleFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (key === 'attributes' && isRecord(value)) {
      merged.attributes = isRecord(merged.attributes) ? { ...value, ...merged.attributes } : value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseBioSampleFetchXml(xml: string): Map<string, BioSampleFetchDetails> {
  const details = new Map<string, BioSampleFetchDetails>()
  for (const match of xml.matchAll(/<BioSample\b[\s\S]*?<\/BioSample>/g)) {
    const parsed = parseBioSampleRecord(match[0])
    for (const key of bioSampleDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function parseBioSampleRecord(record: string): BioSampleFetchDetails {
  const openingTag = record.match(/^<BioSample\b[^>]*>/)?.[0] ?? ''
  const attributes = parseBioSampleAttributes(record)
  const organismTag = record.match(/<Organism\b[^>]*>/)?.[0] ?? ''
  const packageTag = record.match(/<Package\b[^>]*>/)?.[0] ?? ''
  const accession =
    xmlAttr(openingTag, 'access') ??
    firstBioSampleId(record, 'BioSample') ??
    firstBioSampleTagText(record, 'Accession')
  return {
    uid: xmlAttr(openingTag, 'id'),
    accession,
    title: firstBioSampleTagText(record, 'Title'),
    organism: firstBioSampleTagText(record, 'Organism') ?? xmlAttr(organismTag, 'taxonomy_name'),
    tax_id: parseOptionalNumber(xmlAttr(organismTag, 'taxonomy_id')),
    sample_name:
      firstBioSampleId(record, 'Sample name') ??
      firstBioSampleId(record, 'SampleName') ??
      attributes.sample_name,
    owner: firstBioSampleTagText(record, 'Name'),
    package: xmlAttr(packageTag, 'display_name') ?? firstBioSampleTagText(record, 'Package'),
    model: firstBioSampleTagText(record, 'Model'),
    attributes,
    collection_date: attributes.collection_date,
    geo_loc_name: attributes.geo_loc_name,
    tissue: attributes.tissue,
    isolation_source: attributes.isolation_source
  }
}

function bioSampleDetailKeys(details: BioSampleFetchDetails): string[] {
  return uniqueStrings([details.uid, details.accession].filter(Boolean) as string[])
}

function firstBioSampleTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function firstBioSampleId(record: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<Id\\b[^>]*\\bdb="${escaped}"[^>]*>([\\s\\S]*?)</Id>`),
    new RegExp(`<Id\\b[^>]*\\bdb_label="${escaped}"[^>]*>([\\s\\S]*?)</Id>`)
  ]
  for (const pattern of patterns) {
    const match = record.match(pattern)
    const value = match ? normalizeXmlText(match[1]) : undefined
    if (value) return value
  }
  return undefined
}

function parseBioSampleAttributes(record: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of record.matchAll(/<Attribute\b([^>]*)>([\s\S]*?)<\/Attribute>/g)) {
    const name = bioSampleAttributeName(match[1])
    const value = normalizeXmlText(match[2])
    if (name && value && attributes[name] === undefined) attributes[name] = value
  }
  return attributes
}

function bioSampleAttributeName(attributeTagBody: string): string | undefined {
  const raw =
    attributeTagBody.match(/\battribute_name="([^"]+)"/)?.[1] ??
    attributeTagBody.match(/\bharmonized_name="([^"]+)"/)?.[1]
  if (!raw) return undefined
  return decodeXmlEntities(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

interface SraRunDetails {
  accession?: string
  total_spots?: number
  total_bases?: number
  size?: number
  published?: string
}

type SraDownloadFile = DbDownloadFileCandidate

interface SraFetchDetails {
  accession?: string
  title?: string
  study_accession?: string
  experiment_accession?: string
  sample_accession?: string
  biosample_accession?: string
  bioproject_accession?: string
  organism?: string
  tax_id?: number
  platform?: string
  instrument_model?: string
  library_strategy?: string
  library_source?: string
  library_selection?: string
  library_layout?: string
  run_accessions?: string[]
  runs?: SraRunDetails[]
  download_urls?: Record<string, Record<string, string>>
  download_files?: SraDownloadFile[]
}

function addSraFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseSraFetchXml(xml)
  return rows.map((row) => {
    const match = lookupSraDetails(row, details)
    return match ? mergeSraDetails(row, match) : row
  })
}

function lookupSraDetails(
  row: Record<string, unknown>,
  details: Map<string, SraFetchDetails>
): SraFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.study_accession),
    firstString(row.experiment_accession),
    firstString(row.sample_accession),
    firstString(row.biosample_accession),
    ...(Array.isArray(row.run_accessions)
      ? row.run_accessions.filter((item): item is string => typeof item === 'string')
      : [])
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeSraDetails(
  row: Record<string, unknown>,
  details: SraFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'run_accessions') {
        const existing = Array.isArray(merged.run_accessions)
          ? merged.run_accessions.filter((item): item is string => typeof item === 'string')
          : []
        const runAccessions = uniqueStrings([...existing, ...value])
        if (runAccessions.length > 0) merged.run_accessions = runAccessions
        continue
      }
      if (merged[key] === undefined || merged[key] === '') merged[key] = value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseSraFetchXml(xml: string): Map<string, SraFetchDetails> {
  const details = new Map<string, SraFetchDetails>()
  for (const match of xml.matchAll(/<EXPERIMENT_PACKAGE\b[\s\S]*?<\/EXPERIMENT_PACKAGE>/g)) {
    const parsed = parseSraExperimentPackage(match[0])
    for (const key of sraDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function parseSraExperimentPackage(record: string): SraFetchDetails {
  const experimentScope = firstSraScope(record, 'EXPERIMENT') ?? record
  const sampleScope = firstSraScope(record, 'SAMPLE') ?? record
  const experimentTag = experimentScope.match(/^<EXPERIMENT\b[^>]*>/)?.[0] ?? ''
  const studyRefTag = record.match(/<STUDY_REF\b[^>]*>/)?.[0] ?? ''
  const sampleDescriptorTag = record.match(/<SAMPLE_DESCRIPTOR\b[^>]*>/)?.[0] ?? ''
  const sampleTag = sampleScope.match(/^<SAMPLE\b[^>]*>/)?.[0] ?? ''
  const platformScope = firstSraScope(experimentScope, 'PLATFORM')
  const runs = parseSraRuns(record)
  const experimentAccession = xmlAttr(experimentTag, 'accession')
  const runAccessions = uniqueStrings(runs.map((run) => run.accession).filter(Boolean) as string[])
  return {
    accession: experimentAccession,
    title: firstSraTagText(experimentScope, 'TITLE'),
    study_accession:
      xmlAttr(studyRefTag, 'accession') ??
      xmlAttr(record.match(/^<STUDY\b[^>]*>/)?.[0] ?? '', 'accession'),
    experiment_accession: experimentAccession,
    sample_accession: xmlAttr(sampleDescriptorTag, 'accession') ?? xmlAttr(sampleTag, 'accession'),
    biosample_accession: sraExternalAccession(sampleScope, 'BioSample'),
    bioproject_accession: sraExternalAccession(record, 'BioProject'),
    organism: firstSraTagText(sampleScope, 'SCIENTIFIC_NAME'),
    tax_id: parseOptionalNumber(firstSraTagText(sampleScope, 'TAXON_ID')),
    platform: sraPlatform(platformScope),
    instrument_model: firstSraTagText(platformScope ?? '', 'INSTRUMENT_MODEL'),
    library_strategy: firstSraTagText(experimentScope, 'LIBRARY_STRATEGY'),
    library_source: firstSraTagText(experimentScope, 'LIBRARY_SOURCE'),
    library_selection: firstSraTagText(experimentScope, 'LIBRARY_SELECTION'),
    library_layout: sraLibraryLayout(experimentScope),
    run_accessions: runAccessions,
    runs,
    download_urls: sraDownloadUrls(runAccessions),
    download_files: parseSraDownloadFiles(record, runAccessions)
  }
}

function sraDetailKeys(details: SraFetchDetails): string[] {
  return uniqueStrings(
    [
      details.accession,
      details.study_accession,
      details.experiment_accession,
      details.sample_accession,
      details.biosample_accession,
      ...(details.run_accessions ?? [])
    ].filter(Boolean) as string[]
  )
}

function firstSraScope(record: string, tag: string): string | undefined {
  return record.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`))?.[0]
}

function firstSraTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function sraExternalAccession(record: string, namespace: string): string | undefined {
  const match = record.match(
    new RegExp(`<EXTERNAL_ID\\b[^>]*namespace="${namespace}"[^>]*>([\\s\\S]*?)</EXTERNAL_ID>`)
  )
  return match ? normalizeXmlText(match[1]) : undefined
}

function sraPlatform(platformScope: string | undefined): string | undefined {
  if (!platformScope) return undefined
  const inner = platformScope.replace(/^<PLATFORM\b[^>]*>/, '')
  const match = inner.match(/<([A-Z0-9_]+)\b/)
  return match?.[1]
}

function sraLibraryLayout(experimentScope: string): string | undefined {
  const layoutScope = firstSraScope(experimentScope, 'LIBRARY_LAYOUT')
  if (!layoutScope) return undefined
  const inner = layoutScope.replace(/^<LIBRARY_LAYOUT\b[^>]*>/, '')
  return inner.match(/<([A-Z0-9_]+)\b/)?.[1]
}

function parseSraRuns(record: string): SraRunDetails[] {
  return [...record.matchAll(/<RUN\b[^>]*>/g)]
    .map((match) => {
      const tag = match[0]
      return {
        accession: xmlAttr(tag, 'accession'),
        total_spots: parseOptionalNumber(xmlAttr(tag, 'total_spots')),
        total_bases: parseOptionalNumber(xmlAttr(tag, 'total_bases')),
        size: parseOptionalNumber(xmlAttr(tag, 'size')),
        published: xmlAttr(tag, 'published')
      }
    })
    .filter((run) => run.accession !== undefined)
}

function sraRunBrowserUrl(accession: string): string {
  return `https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=${encodeURIComponent(accession)}`
}

function sraRecordUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/sra/${encodeURIComponent(accession)}`
}

function sraDownloadUrls(
  runAccessions: string[]
): Record<string, Record<string, string>> | undefined {
  if (runAccessions.length === 0) return undefined
  return {
    run_browser: Object.fromEntries(
      runAccessions.map((accession) => [accession, sraRunBrowserUrl(accession)])
    ),
    sra_record: Object.fromEntries(
      runAccessions.map((accession) => [accession, sraRecordUrl(accession)])
    )
  }
}

function parseSraDownloadFiles(record: string, runAccessions: string[]): SraDownloadFile[] {
  const files: SraDownloadFile[] = []
  for (const runMatch of record.matchAll(/<RUN\b[\s\S]*?<\/RUN>|<RUN\b[^>]*\/>/g)) {
    const runRecord = runMatch[0]
    const runTag = runRecord.match(/^<RUN\b[^>]*\/?>/)?.[0] ?? ''
    const runAccession = xmlAttr(runTag, 'accession')
    for (const fileMatch of runRecord.matchAll(/<SRAFile\b[^>]*>/g)) {
      const tag = fileMatch[0]
      const url = xmlAttr(tag, 'url')
      if (!url) continue
      files.push({
        kind: 'sra_file',
        ...(runAccession ? { accession: runAccession } : {}),
        url,
        format: 'sra',
        ...(xmlAttr(tag, 'filename') ? { filename: xmlAttr(tag, 'filename') } : {}),
        ...(parseOptionalNumber(xmlAttr(tag, 'size')) !== undefined
          ? { size: parseOptionalNumber(xmlAttr(tag, 'size')) }
          : {}),
        ...(xmlAttr(tag, 'md5') ? { md5: xmlAttr(tag, 'md5') } : {}),
        ...(xmlAttr(tag, 'semantic_name') ? { semantic_name: xmlAttr(tag, 'semantic_name') } : {}),
        ...(xmlAttr(tag, 'supertype') ? { supertype: xmlAttr(tag, 'supertype') } : {}),
        ...(xmlAttr(tag, 'cluster') ? { cluster: xmlAttr(tag, 'cluster') } : {}),
        availability: 'direct_url',
        source: 'sra_efetch_xml'
      })
    }
  }

  for (const accession of runAccessions) {
    files.push({
      kind: 'sra_run_browser',
      accession,
      url: sraRunBrowserUrl(accession),
      format: 'html',
      availability: 'landing_page',
      source: 'derived_from_run_accession'
    })
  }

  return uniqueSraDownloadFiles(files)
}

function uniqueSraDownloadFiles(files: SraDownloadFile[]): SraDownloadFile[] {
  const seen = new Set<string>()
  const unique: SraDownloadFile[] = []
  for (const file of files) {
    const key = `${file.kind}:${file.accession ?? ''}:${file.url}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(file)
  }
  return unique
}

interface GeoSampleDetails {
  accession?: string
  title?: string
}

interface GeoDownloadUrls {
  series_ftp: string
  series_https: string
  matrix_dir: string
  matrix: string
  soft_dir: string
  soft_family: string
  miniml_dir: string
  miniml_family: string
  supplementary_dir: string
  raw_tar: string
}

interface GeoDownloadFile extends DbDownloadFileCandidate {
  label: string
  accession: string
  format: string
  source: 'derived_from_gse_accession'
}

interface GeoFetchDetails {
  uid?: string
  accession?: string
  title?: string
  fetch_summary?: string
  organism?: string
  entry_type?: string
  gds_type?: string
  series_accession?: string
  platform_accession?: string
  dataset_accession?: string
  sample_accessions?: string[]
  sample_count?: number
  ftp_link?: string
  download_urls?: GeoDownloadUrls
  download_files?: GeoDownloadFile[]
}

function addGeoFetchDetails(
  rows: Record<string, unknown>[],
  text: string
): Record<string, unknown>[] {
  const details = parseGeoFetchText(text)
  return rows.map((row) => {
    const match = lookupGeoDetails(row, details)
    return match ? mergeGeoDetails(row, match) : row
  })
}

function lookupGeoDetails(
  row: Record<string, unknown>,
  details: Map<string, GeoFetchDetails>
): GeoFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.series_accession),
    firstString(row.platform_accession),
    firstString(row.dataset_accession),
    ...(Array.isArray(row.sample_accessions)
      ? row.sample_accessions.filter((item): item is string => typeof item === 'string')
      : [])
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeGeoDetails(
  row: Record<string, unknown>,
  details: GeoFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'sample_accessions') {
        const existing = Array.isArray(merged.sample_accessions)
          ? merged.sample_accessions.filter((item): item is string => typeof item === 'string')
          : []
        const sampleAccessions = uniqueStrings([...existing, ...value])
        if (sampleAccessions.length > 0) merged.sample_accessions = sampleAccessions
        continue
      }
      if (merged[key] === undefined || merged[key] === '') merged[key] = value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseGeoFetchText(text: string): Map<string, GeoFetchDetails> {
  const details = new Map<string, GeoFetchDetails>()
  for (const record of geoTextRecords(text)) {
    const parsed = parseGeoTextRecord(record)
    for (const key of geoDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function geoTextRecords(text: string): string[] {
  const matches = [...text.matchAll(/(^|\n)\d+\.\s+/g)]
  if (matches.length === 0) return text.trim() ? [text.trim()] : []
  return matches
    .map((match, index) => {
      const start = match.index + (match[1] ? 1 : 0)
      const end = matches[index + 1]?.index ?? text.length
      return text.slice(start, end).trim()
    })
    .filter(Boolean)
}

function parseGeoTextRecord(record: string): GeoFetchDetails {
  const firstLine = record
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  const title = firstLine?.replace(/^\d+\.\s+/, '').trim()
  const accession = geoTextAccession(record)
  const details: GeoFetchDetails = {
    uid: record.match(/\bID:\s*(\d+)\b/)?.[1],
    accession,
    title,
    fetch_summary: geoTextSummary(record),
    organism: geoTextValue(record, 'Organism'),
    gds_type: geoTextValue(record, 'Type'),
    platform_accession: geoTextPlatformAccession(record),
    sample_count: geoTextSampleCount(record),
    ftp_link: record.match(/FTP download:\s*(?:GEO\s*)?(ftp:\/\/\S+)/i)?.[1]
  }
  addGeoAccessionLinks(details, accession)
  addGeoDownloadUrls(details, details.series_accession ?? accession)
  return details
}

function geoDetailKeys(details: GeoFetchDetails): string[] {
  return uniqueStrings(
    [
      details.uid,
      details.accession,
      details.series_accession,
      details.platform_accession,
      details.dataset_accession,
      ...(details.sample_accessions ?? [])
    ].filter(Boolean) as string[]
  )
}

function addGeoAccessionLinks(details: GeoFetchDetails, accession: string | undefined): void {
  const prefix = geoAccessionPrefix(accession)
  if (!prefix || !accession) return
  details.entry_type ??= prefix
  if (prefix === 'GSE') details.series_accession ??= accession
  if (prefix === 'GPL') details.platform_accession ??= accession
  if (prefix === 'GDS') details.dataset_accession ??= accession
  if (prefix === 'GSM') details.sample_accessions = uniqueStrings([accession])
}

function addGeoDownloadUrls(
  details: GeoFetchDetails | Record<string, unknown>,
  accession: string | undefined
): void {
  const downloadUrls = geoSeriesDownloadUrls(accession)
  if (!downloadUrls) return
  details.download_urls ??= downloadUrls
  details.download_files ??= geoSeriesDownloadFiles(downloadUrls, accession)
}

function geoSeriesDownloadUrls(accession: string | undefined): GeoDownloadUrls | undefined {
  const series = accession?.match(/^(GSE)(\d+)$/i)
  if (!series) return undefined
  const gse = `${series[1].toUpperCase()}${series[2]}`
  const bucket = geoSeriesBucket(gse)
  const seriesPath = `/geo/series/${bucket}/${gse}`
  const ftpBase = `ftp://ftp.ncbi.nlm.nih.gov${seriesPath}`
  const httpsBase = `https://ftp.ncbi.nlm.nih.gov${seriesPath}`
  return {
    series_ftp: `${ftpBase}/`,
    series_https: `${httpsBase}/`,
    matrix_dir: `${httpsBase}/matrix/`,
    matrix: `${httpsBase}/matrix/${gse}_series_matrix.txt.gz`,
    soft_dir: `${httpsBase}/soft/`,
    soft_family: `${httpsBase}/soft/${gse}_family.soft.gz`,
    miniml_dir: `${httpsBase}/miniml/`,
    miniml_family: `${httpsBase}/miniml/${gse}_family.xml.tgz`,
    supplementary_dir: `${httpsBase}/suppl/`,
    raw_tar: `${httpsBase}/suppl/${gse}_RAW.tar`
  }
}

function geoSeriesDownloadFiles(
  urls: GeoDownloadUrls,
  accession: string | undefined
): GeoDownloadFile[] {
  const seriesAccession = accession?.toUpperCase() ?? ''
  return [
    {
      kind: 'series_matrix',
      label: 'Series Matrix',
      accession: seriesAccession,
      url: urls.matrix,
      format: 'txt',
      compression: 'gzip',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'series_matrix_directory',
      label: 'Series Matrix Directory',
      accession: seriesAccession,
      url: urls.matrix_dir,
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'soft_family',
      label: 'SOFT Family',
      accession: seriesAccession,
      url: urls.soft_family,
      format: 'soft',
      compression: 'gzip',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'miniml_family',
      label: 'MINiML Family',
      accession: seriesAccession,
      url: urls.miniml_family,
      format: 'xml',
      compression: 'tgz',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'supplementary_directory',
      label: 'Supplementary Directory',
      accession: seriesAccession,
      url: urls.supplementary_dir,
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'raw_tar',
      label: 'Raw Supplementary Archive',
      accession: seriesAccession,
      url: urls.raw_tar,
      format: 'tar',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    }
  ]
}

function geoSeriesBucket(accession: string): string {
  return accession.replace(/\d{1,3}$/, 'nnn')
}

function geoTextAccession(record: string): string | undefined {
  return record.match(/\bAccession:\s*((?:GSE|GSM|GPL|GDS)\d+)\b/i)?.[1]?.toUpperCase()
}

function geoTextPlatformAccession(record: string): string | undefined {
  return record.match(/\bPlatform:\s*((?:GPL)\d+)\b/i)?.[1]?.toUpperCase()
}

function geoTextSampleCount(record: string): number | undefined {
  return parseOptionalNumber(record.match(/\bPlatform:.*?\b(\d+)\s+Samples?\b/i)?.[1])
}

function geoTextValue(record: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = record.match(new RegExp(`(?:^|\\n)${escaped}:\\s*([^\\n]+)`, 'i'))
  return match ? normalizeXmlText(match[1]) : undefined
}

function geoTextSummary(record: string): string | undefined {
  const lines = record
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const summaryLines: string[] = []
  for (const line of lines.slice(1)) {
    if (/^(Organism|Type|Platform|FTP download|Series|DataSet|Dataset|Sample)\b/i.test(line)) {
      break
    }
    summaryLines.push(line)
  }
  const summary = summaryLines.join(' ')
  return summary ? normalizeXmlText(summary) : undefined
}

function prefixedGeoAccession(
  prefix: 'GSE' | 'GSM' | 'GPL' | 'GDS',
  value: unknown
): string | undefined {
  const raw = firstString(value)?.trim()
  if (!raw) return undefined
  const upper = raw.toUpperCase()
  if (upper.startsWith(prefix)) return upper
  return /^\d+$/.test(raw) ? `${prefix}${raw}` : raw
}

function geoAccessionPrefix(
  accession: string | undefined
): 'GSE' | 'GSM' | 'GPL' | 'GDS' | undefined {
  return accession?.match(/^(GSE|GSM|GPL|GDS)\d+$/i)?.[1]?.toUpperCase() as
    'GSE' | 'GSM' | 'GPL' | 'GDS' | undefined
}

function geoSamplesFromSummary(value: unknown): GeoSampleDetails[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): GeoSampleDetails | undefined => {
      if (typeof item === 'string') return { accession: item }
      if (!isRecord(item)) return undefined
      const accession = firstString(item.accession)
      const title = firstString(item.title)
      return accession || title ? { accession, title } : undefined
    })
    .filter((item): item is GeoSampleDetails => item !== undefined)
}

function geoStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(
      value.map((item) => firstString(item)).filter((item): item is string => item !== undefined)
    )
  }
  if (typeof value === 'string') {
    return uniqueStrings(value.split(/[,;]/).map((item) => item.trim()))
  }
  return []
}

function parseGeoBoolean(value: unknown): boolean | undefined {
  const text = firstString(value)?.toLowerCase()
  if (text === 'yes' || text === 'true' || text === '1') return true
  if (text === 'no' || text === 'false' || text === '0') return false
  return undefined
}

interface BioProjectFetchDetails {
  uid?: string
  accession?: string
  project_id?: number
  title?: string
  name?: string
  description?: string
  organism?: string
  tax_id?: number
  project_type?: string
  data_type?: string
  target_scope?: string
  target_material?: string
  target_capture?: string
  method_type?: string
  objectives?: string[]
  relevance?: Record<string, string>
  submitter_organization?: string
  release_date?: string
  submitted_date?: string
  last_update?: string
  submission_id?: string
  access?: string
  geo_accessions?: string[]
  pubmed_ids?: string[]
  supergroup?: string
}

function addBioProjectFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseBioProjectFetchXml(xml)
  return rows.map((row) => {
    const match = lookupBioProjectDetails(row, details)
    return match ? mergeBioProjectDetails(row, match) : row
  })
}

function lookupBioProjectDetails(
  row: Record<string, unknown>,
  details: Map<string, BioProjectFetchDetails>
): BioProjectFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.project_id)
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeBioProjectDetails(
  row: Record<string, unknown>,
  details: BioProjectFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      const existing = Array.isArray(merged[key])
        ? merged[key].filter((item): item is string => typeof item === 'string')
        : []
      const combined = uniqueStrings([...existing, ...value])
      if (combined.length > 0) merged[key] = combined
      continue
    }
    if (key === 'relevance' && isRecord(value)) {
      merged.relevance = isRecord(merged.relevance) ? { ...value, ...merged.relevance } : value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseBioProjectFetchXml(xml: string): Map<string, BioProjectFetchDetails> {
  const details = new Map<string, BioProjectFetchDetails>()
  for (const match of xml.matchAll(/<DocumentSummary\b[\s\S]*?<\/DocumentSummary>/g)) {
    const parsed = parseBioProjectRecord(match[0])
    for (const key of bioProjectDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function parseBioProjectRecord(record: string): BioProjectFetchDetails {
  const openingTag = record.match(/^<DocumentSummary\b[^>]*>/)?.[0] ?? ''
  const archiveTag = record.match(/<ArchiveID\b[^>]*>/)?.[0] ?? ''
  const projectDescr = firstBioProjectScope(record, 'ProjectDescr') ?? record
  const projectType = firstBioProjectScope(record, 'ProjectTypeSubmission') ?? record
  const submissionScope = firstBioProjectScope(record, 'Submission') ?? ''
  const targetTag = projectType.match(/<Target\b[^>]*>/)?.[0] ?? ''
  const organismTag = projectType.match(/<Organism\b[^>]*>/)?.[0] ?? ''
  const methodTag = projectType.match(/<Method\b[^>]*>/)?.[0] ?? ''
  const submissionTag = submissionScope.match(/^<Submission\b[^>]*>/)?.[0] ?? ''
  const accession = xmlAttr(archiveTag, 'accession')
  const projectId =
    parseOptionalNumber(xmlAttr(archiveTag, 'id')) ??
    parseOptionalNumber(xmlAttr(openingTag, 'uid'))
  return {
    uid: xmlAttr(openingTag, 'uid'),
    accession,
    project_id: projectId,
    title: firstBioProjectTagText(projectDescr, 'Title'),
    name: firstBioProjectTagText(projectDescr, 'Name'),
    description: firstBioProjectTagText(projectDescr, 'Description'),
    organism: firstBioProjectTagText(projectType, 'OrganismName'),
    tax_id:
      parseOptionalNumber(xmlAttr(organismTag, 'taxID')) ??
      parseOptionalNumber(xmlAttr(organismTag, 'species')),
    data_type: firstBioProjectTagText(projectType, 'DataType'),
    target_scope: normalizeBioProjectEnum(xmlAttr(targetTag, 'sample_scope')),
    target_material: normalizeBioProjectEnum(xmlAttr(targetTag, 'material')),
    target_capture: normalizeBioProjectEnum(xmlAttr(targetTag, 'capture')),
    method_type: normalizeBioProjectEnum(xmlAttr(methodTag, 'method_type')),
    objectives: bioProjectObjectivesFromXml(projectType),
    relevance: bioProjectRelevanceFromXml(projectDescr),
    submitter_organization: firstBioProjectOrganizationName(submissionScope),
    release_date: firstBioProjectTagText(projectDescr, 'ProjectReleaseDate'),
    submitted_date: xmlAttr(submissionTag, 'submitted'),
    last_update: xmlAttr(submissionTag, 'last_update'),
    submission_id: xmlAttr(submissionTag, 'submission_id'),
    access: firstBioProjectTagText(submissionScope, 'Access'),
    geo_accessions: bioProjectDbXrefs(record, 'GEO'),
    pubmed_ids: bioProjectPubmedIds(projectDescr),
    supergroup: normalizeBioProjectEnum(firstBioProjectTagText(projectType, 'Supergroup'))
  }
}

function bioProjectDetailKeys(details: BioProjectFetchDetails): string[] {
  return uniqueStrings(
    [details.uid, details.accession, details.project_id?.toString()].filter(Boolean) as string[]
  )
}

function firstBioProjectScope(record: string, tag: string): string | undefined {
  return record.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`))?.[0]
}

function firstBioProjectTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function firstBioProjectOrganizationName(record: string): string | undefined {
  const organizationScope = firstBioProjectScope(record, 'Organization')
  return organizationScope ? firstBioProjectTagText(organizationScope, 'Name') : undefined
}

function bioProjectDbXrefs(record: string, db: string): string[] {
  const accessions: string[] = []
  const pattern = new RegExp(
    `<dbXREF\\b[^>]*\\bdb="${db}"[^>]*>[\\s\\S]*?<ID\\b[^>]*>([\\s\\S]*?)</ID>[\\s\\S]*?</dbXREF>`,
    'g'
  )
  for (const match of record.matchAll(pattern)) {
    const accession = normalizeXmlText(match[1])
    if (accession) accessions.push(accession)
  }
  return uniqueStrings(accessions)
}

function bioProjectPubmedIds(record: string): string[] {
  return uniqueStrings(
    [...record.matchAll(/<Publication\b[^>]*\bid="([^"]+)"/g)]
      .map((match) => decodeXmlEntities(match[1]).trim())
      .filter(Boolean)
  )
}

function bioProjectObjectivesFromSummary(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(
    value
      .map((item) => {
        if (typeof item === 'string') return item
        if (!isRecord(item)) return undefined
        return firstString(item.project_objectivestype, item.project_objectives)
      })
      .filter((item): item is string => item !== undefined)
  )
}

function bioProjectObjectivesFromXml(record: string): string[] {
  const objectives = [...record.matchAll(/<Data\b[^>]*\bdata_type="([^"]+)"[^>]*\/?>/g)]
    .map((match) => normalizeBioProjectEnum(decodeXmlEntities(match[1]).trim()))
    .filter((item): item is string => item !== undefined)
  return uniqueStrings(objectives)
}

function bioProjectRelevanceFromSummary(summary: Record<string, unknown>): Record<string, string> {
  const relevanceKeys = [
    'agricultural',
    'medical',
    'industrial',
    'environmental',
    'evolution',
    'model',
    'other'
  ]
  const relevance: Record<string, string> = {}
  for (const key of relevanceKeys) {
    const value = firstString(summary[`relevance_${key}`])
    if (value) relevance[key] = value
  }
  return relevance
}

function bioProjectRelevanceFromXml(record: string): Record<string, string> | undefined {
  const relevanceScope = firstBioProjectScope(record, 'Relevance')
  if (!relevanceScope) return undefined
  const relevance: Record<string, string> = {}
  for (const match of relevanceScope.matchAll(/<([A-Za-z]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const key = match[1].trim().toLowerCase()
    if (key === 'relevance') continue
    const value = normalizeXmlText(match[2])
    if (key && value) relevance[key] = value
  }
  return Object.keys(relevance).length > 0 ? relevance : undefined
}

function normalizeBioProjectEnum(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/^e(?=[A-Z])/, '').trim()
  return normalized || undefined
}

interface TaxonomyCodeDetails {
  id?: number
  name?: string
}

interface TaxonomyFetchDetails {
  tax_id?: number
  scientific_name?: string
  common_name?: string
  rank?: string
  division?: string
  lineage?: string
  parent_tax_id?: number
  synonyms?: string[]
  genetic_code?: TaxonomyCodeDetails
  mitochondrial_genetic_code?: TaxonomyCodeDetails
}

function addTaxonomyFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseTaxonomyFetchXml(xml)
  return rows.map((row) => {
    const uid = firstString(row.uid)
    const match = uid ? details.get(uid) : undefined
    return match ? mergeTaxonomyDetails(row, match) : row
  })
}

function mergeTaxonomyDetails(
  row: Record<string, unknown>,
  details: TaxonomyFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'synonyms') {
        const existing = Array.isArray(merged.synonyms)
          ? merged.synonyms.filter((item): item is string => typeof item === 'string')
          : []
        const synonyms = uniqueStrings([...existing, ...value])
        if (synonyms.length > 0) merged.synonyms = synonyms
      }
      continue
    }
    if (isRecord(value)) {
      if (merged[key] === undefined || merged[key] === '') merged[key] = value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseTaxonomyFetchXml(xml: string): Map<string, TaxonomyFetchDetails> {
  const details = new Map<string, TaxonomyFetchDetails>()
  for (const record of taxonomyXmlRecords(xml)) {
    const parsed = parseTaxonomyRecord(record)
    if (parsed.tax_id === undefined) continue
    details.set(String(parsed.tax_id), parsed)
  }
  return details
}

function taxonomyXmlRecords(xml: string): string[] {
  const records: string[] = []
  const tagPattern = /<\/?Taxon\b[^>]*>/g
  let depth = 0
  let start: number | undefined
  for (const match of xml.matchAll(tagPattern)) {
    const tag = match[0]
    if (tag.startsWith('</')) {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start !== undefined) {
        records.push(xml.slice(start, match.index + tag.length))
        start = undefined
      }
    } else {
      if (depth === 0) start = match.index
      depth += 1
    }
  }
  return records
}

function parseTaxonomyRecord(record: string): TaxonomyFetchDetails {
  const taxId = parseOptionalNumber(firstTaxonomyTagText(record, 'TaxId'))
  return {
    tax_id: taxId,
    scientific_name: firstTaxonomyTagText(record, 'ScientificName'),
    common_name:
      firstTaxonomyTagText(record, 'GenbankCommonName') ??
      firstTaxonomyTagText(record, 'CommonName'),
    rank: firstTaxonomyTagText(record, 'Rank'),
    division: firstTaxonomyTagText(record, 'Division'),
    lineage: firstTaxonomyTagText(record, 'Lineage'),
    parent_tax_id: parseOptionalNumber(firstTaxonomyTagText(record, 'ParentTaxId')),
    synonyms: uniqueStrings(
      [
        ...record.matchAll(
          /<(?:Synonym|EquivalentName|GenbankSynonym)\b[^>]*>([\s\S]*?)<\/(?:Synonym|EquivalentName|GenbankSynonym)>/g
        )
      ]
        .map((match) => normalizeXmlText(match[1]))
        .filter(Boolean)
    ),
    genetic_code: parseTaxonomyCode(record, 'GeneticCode'),
    mitochondrial_genetic_code: parseTaxonomyCode(record, 'MitoGeneticCode')
  }
}

function firstTaxonomyTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function parseTaxonomyCode(record: string, parentTag: string): TaxonomyCodeDetails | undefined {
  const scope = record.match(new RegExp(`<${parentTag}\\b[\\s\\S]*?</${parentTag}>`))?.[0]
  if (!scope) return undefined
  const id = parseOptionalNumber(firstTaxonomyTagText(scope, 'GCId'))
  const name = firstTaxonomyTagText(scope, 'GCName')
  return id !== undefined || name ? { id, name } : undefined
}

interface ClinvarFetchDetails {
  accession?: string
  variation_id?: string
  clinical_significance?: string
  condition?: string[]
  review_status?: string
  last_evaluated?: string
  molecular_consequence?: string[]
  variant_type?: string
}

function addClinvarFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseClinvarFetchXml(xml)
  return rows.map((row) => {
    const match = lookupClinvarDetails(row, details)
    return match ? mergeClinvarDetails(row, match) : row
  })
}

function lookupClinvarDetails(
  row: Record<string, unknown>,
  details: Map<string, ClinvarFetchDetails>
): ClinvarFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.variation_id)
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate) ?? details.get(stripAccessionVersion(candidate))
    if (match) return match
  }
  return undefined
}

function mergeClinvarDetails(
  row: Record<string, unknown>,
  details: ClinvarFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseClinvarFetchXml(xml: string): Map<string, ClinvarFetchDetails> {
  const details = new Map<string, ClinvarFetchDetails>()
  for (const record of clinvarXmlRecords(xml)) {
    const parsed = parseClinvarRecord(record)
    const keys = clinvarDetailKeys(parsed)
    for (const key of keys) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function clinvarXmlRecords(xml: string): string[] {
  const records = [
    ...xml.matchAll(/<VariationArchive\b[\s\S]*?<\/VariationArchive>/g),
    ...xml.matchAll(/<ClinVarSet\b[\s\S]*?<\/ClinVarSet>/g)
  ].map((match) => match[0])
  return records.length > 0 ? records : [xml]
}

function parseClinvarRecord(record: string): ClinvarFetchDetails {
  const openingTag = record.match(/^<\w+\b[^>]*>/)?.[0] ?? ''
  const clinicalSignificance =
    firstClinvarTagText(record, 'Description', 'GermlineClassification') ??
    firstClinvarTagText(record, 'Description', 'ClinicalSignificance')
  return {
    accession: xmlAttr(openingTag, 'Accession'),
    variation_id:
      xmlAttr(openingTag, 'VariationID') ??
      xmlAttr(openingTag, 'VariationId') ??
      record.match(/\bVariationID="([^"]+)"/)?.[1],
    clinical_significance: clinicalSignificance,
    condition: uniqueStrings(
      [...record.matchAll(/<ElementValue\b[^>]*Type="Preferred"[^>]*>([\s\S]*?)<\/ElementValue>/g)]
        .map((match) => normalizeXmlText(match[1]))
        .filter(Boolean)
    ),
    review_status:
      firstClinvarTagText(record, 'ReviewStatus', 'GermlineClassification') ??
      firstClinvarTagText(record, 'ReviewStatus', 'ClinicalSignificance'),
    last_evaluated: record.match(
      /<(?:GermlineClassification|ClinicalSignificance)\b[^>]*DateLastEvaluated="([^"]+)"/
    )?.[1],
    molecular_consequence: uniqueStrings(
      [...record.matchAll(/<MolecularConsequence\b[^>]*\bType="([^"]+)"/g)]
        .map((match) => decodeXmlEntities(match[1]).trim())
        .filter(Boolean)
    ),
    variant_type:
      xmlAttr(openingTag, 'VariationType') ?? record.match(/<Measure\b[^>]*Type="([^"]+)"/)?.[1]
  }
}

function clinvarDetailKeys(details: ClinvarFetchDetails): string[] {
  return uniqueStrings(
    [details.accession, details.variation_id]
      .flatMap((value) => (value ? [value, stripAccessionVersion(value)] : []))
      .filter(Boolean)
  )
}

function firstClinvarTagText(record: string, tag: string, parent: string): string | undefined {
  const parentMatch = record.match(new RegExp(`<${parent}\\b[\\s\\S]*?</${parent}>`))
  const scope = parentMatch?.[0] ?? record
  const match = scope.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function xmlAttr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : undefined
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function parsePubmedFetchXml(xml: string): Map<string, PubmedFetchDetails> {
  const details = new Map<string, PubmedFetchDetails>()
  for (const articleMatch of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g)) {
    const article = articleMatch[0]
    const pmid = article.match(/<PMID\b[^>]*>([\s\S]*?)<\/PMID>/)?.[1]?.trim()
    if (!pmid) continue
    const parsed: PubmedFetchDetails = {
      abstract: parsePubmedAbstract(article),
      mesh_terms: uniqueStrings(
        [...article.matchAll(/<DescriptorName\b[^>]*>([\s\S]*?)<\/DescriptorName>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      ),
      keywords: uniqueStrings(
        [...article.matchAll(/<Keyword\b[^>]*>([\s\S]*?)<\/Keyword>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      ),
      publication_types: uniqueStrings(
        [...article.matchAll(/<PublicationType\b[^>]*>([\s\S]*?)<\/PublicationType>/g)]
          .map((match) => normalizeXmlText(match[1]))
          .filter(Boolean)
      )
    }
    details.set(pmid, parsed)
  }
  return details
}

function parsePubmedAbstract(article: string): string | undefined {
  const parts = [...article.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
    .map((match) => {
      const label = match[1].match(/\bLabel="([^"]+)"/)?.[1]
      const text = normalizeXmlText(match[2])
      if (!text) return undefined
      return label ? `${decodeXmlEntities(label)}: ${text}` : text
    })
    .filter((item): item is string => item !== undefined)
  return parts.length > 0 ? parts.join('\n') : undefined
}

function normalizeXmlText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
