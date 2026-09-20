import {
  decodeXmlEntities,
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

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

export function addBioProjectFetchDetails(
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

export function bioProjectObjectivesFromSummary(value: unknown): string[] {
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

export function bioProjectRelevanceFromSummary(
  summary: Record<string, unknown>
): Record<string, string> {
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
