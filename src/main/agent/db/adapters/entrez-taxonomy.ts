import {
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings
} from './entrez-utils'

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

export function addTaxonomyFetchDetails(
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
