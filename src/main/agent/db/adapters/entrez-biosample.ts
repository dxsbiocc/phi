import {
  decodeXmlEntities,
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

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

export function addBioSampleFetchDetails(
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
