import {
  decodeXmlEntities,
  firstString,
  normalizeXmlText,
  stripAccessionVersion,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

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

export function addClinvarFetchDetails(
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
