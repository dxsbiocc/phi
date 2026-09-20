import {
  aliasesFrom,
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

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

export function addGeneFetchDetails(
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
