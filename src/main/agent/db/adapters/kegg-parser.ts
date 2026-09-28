/**
 * KEGG flat-file and list/find parsers inspired by Biopython's Bio.KEGG modules.
 *
 * Biopython references:
 * - Bio.KEGG.Gene / Compound / Enzyme parse tagged records (12-char keyword + data)
 * - Bio.KEGG.REST returns text from rest.kegg.jp for list/find/get/link/conv
 *
 * Continuations (lines starting with 12 spaces) are appended to the previous field,
 * which is the flat-file convention Biopython only partially handles for DBLINKS.
 */

export interface KeggDbLink {
  database: string
  ids: string[]
}

export interface KeggPathwayRef {
  id: string
  name?: string
}

export interface KeggFlatRecord {
  entry: string
  entry_type?: string
  /** Raw multi-value fields keyed by KEGG keyword (ENTRY, NAME, ...). */
  fields: Record<string, string[]>
}

export interface KeggListRow {
  id: string
  description?: string
}

const KEYWORD_WIDTH = 12

/** Keywords whose continuations extend the previous value (prose), not a new list item. */
const MERGE_CONTINUATION_KEYWORDS = new Set([
  'DEFINITION',
  'DESCRIPTION',
  'COMMENT',
  'POSITION',
  'FORMULA',
  'SYSNAME',
  'REACTION'
])

function shouldMergeContinuation(keyword: string): boolean {
  return MERGE_CONTINUATION_KEYWORDS.has(keyword)
}

function isContinuation(line: string): boolean {
  return line.length >= KEYWORD_WIDTH && line.slice(0, KEYWORD_WIDTH).trim() === ''
}

function keywordOf(line: string): string {
  return line.slice(0, KEYWORD_WIDTH).trimEnd()
}

function dataOf(line: string): string {
  return line.length > KEYWORD_WIDTH ? line.slice(KEYWORD_WIDTH).replace(/\s+$/, '') : ''
}

/**
 * Parse one or more KEGG flat-file records separated by `///`.
 * Mirrors Biopython's Gene/Compound/Enzyme.parse() record splitting.
 */
export function parseKeggFlatRecords(text: string): KeggFlatRecord[] {
  const records: KeggFlatRecord[] = []
  let current: { entry: string; entry_type?: string; fields: Record<string, string[]> } | undefined
  let lastKeyword: string | undefined

  const flush = (): void => {
    if (!current) return
    if (current.entry || Object.keys(current.fields).length > 0) {
      records.push({
        entry: current.entry,
        ...(current.entry_type ? { entry_type: current.entry_type } : {}),
        fields: current.fields
      })
    }
    current = undefined
    lastKeyword = undefined
  }

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    if (rawLine.startsWith('///')) {
      flush()
      continue
    }

    if (!current) current = { entry: '', fields: {} }

    if (isContinuation(rawLine)) {
      if (!lastKeyword) continue
      const data = dataOf(rawLine).trim()
      if (!data) continue
      const values = current.fields[lastKeyword] ?? []
      if (shouldMergeContinuation(lastKeyword) && values.length > 0) {
        values[values.length - 1] = `${values[values.length - 1]} ${data}`.trim()
      } else {
        values.push(data)
      }
      current.fields[lastKeyword] = values
      continue
    }

    const keyword = keywordOf(rawLine)
    const data = dataOf(rawLine).trim()
    lastKeyword = keyword
    if (!keyword) continue

    if (keyword === 'ENTRY') {
      const parts = data.split(/\s+/).filter(Boolean)
      current.entry = parts[0] ?? ''
      if (parts.length > 1) current.entry_type = parts.slice(1).join(' ')
      current.fields.ENTRY = [data]
      continue
    }

    const values = current.fields[keyword] ?? []
    values.push(data)
    current.fields[keyword] = values
  }

  flush()
  return records
}

/** Parse KEGG list/find/link/conv TSV-like lines: `id<TAB>description`. */
export function parseKeggListText(text: string): KeggListRow[] {
  const rows: KeggListRow[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith('#') || line.startsWith('///')) continue
    const tab = line.indexOf('\t')
    if (tab === -1) {
      rows.push({ id: line.trim() })
      continue
    }
    const id = line.slice(0, tab).trim()
    const description = line.slice(tab + 1).trim()
    if (!id) continue
    rows.push({ id, ...(description ? { description } : {}) })
  }
  return rows
}

function firstField(record: KeggFlatRecord, keyword: string): string | undefined {
  const values = record.fields[keyword]
  return values?.[0]?.trim() || undefined
}

function allFields(record: KeggFlatRecord, keyword: string): string[] {
  return (record.fields[keyword] ?? []).map((value) => value.trim()).filter(Boolean)
}

function stripTrailingSemicolon(value: string): string {
  return value.replace(/;+\s*$/, '').trim()
}

function parseDbLinks(values: string[]): KeggDbLink[] {
  const links: KeggDbLink[] = []
  for (const value of values) {
    if (value.includes(':')) {
      const [database, rest = ''] = value.split(/:\s*/, 2)
      links.push({
        database: database.trim(),
        ids: rest
          .split(/\s+/)
          .map((id) => id.trim())
          .filter(Boolean)
      })
    } else if (links.length > 0) {
      links[links.length - 1].ids.push(
        ...value
          .split(/\s+/)
          .map((id) => id.trim())
          .filter(Boolean)
      )
    }
  }
  return links
}

function parsePathwayRefs(values: string[]): KeggPathwayRef[] {
  return values.map((value) => {
    const cleaned = value.replace(/^PATH:\s*/i, '').trim()
    const match = cleaned.match(/^(\S+)\s+(.*)$/)
    if (!match) return { id: cleaned }
    return { id: match[1], name: match[2].trim() || undefined }
  })
}

function parseOrthology(values: string[]): Array<{ id: string; name?: string }> {
  return values.map((value) => {
    const match = value.match(/^(\S+)\s+(.*)$/)
    if (!match) return { id: value }
    return { id: match[1], name: match[2].trim() || undefined }
  })
}

function parseOrganism(value: string | undefined): { id?: string; name?: string } | undefined {
  if (!value) return undefined
  const match = value.match(/^(\S+)\s+(.*)$/)
  if (!match) return { name: value }
  return { id: match[1], name: match[2].trim() || undefined }
}

/** Biopython Bio.KEGG.Gene.Record-shaped row. */
export function normalizeKeggGeneRow(record: KeggFlatRecord): Record<string, unknown> {
  const names = allFields(record, 'NAME').map(stripTrailingSemicolon)
  const primaryNames = (names[0] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const organism = parseOrganism(firstField(record, 'ORGANISM'))
  const orthology = parseOrthology(allFields(record, 'ORTHOLOGY'))
  const pathways = parsePathwayRefs(allFields(record, 'PATHWAY'))
  const dblinks = parseDbLinks(allFields(record, 'DBLINKS'))
  return {
    entry: record.entry,
    entry_type: record.entry_type,
    name: names,
    gene_symbol: primaryNames[0] ?? names[0],
    aliases: primaryNames.slice(1),
    definition: firstField(record, 'DEFINITION'),
    orthology,
    orthology_ids: orthology.map((item) => item.id),
    organism_id: organism?.id,
    organism_name: organism?.name,
    position: firstField(record, 'POSITION'),
    pathway: pathways,
    pathway_ids: pathways.map((item) => item.id),
    motif: allFields(record, 'MOTIF'),
    dblinks,
    raw_fields: record.fields
  }
}

/** Biopython Bio.KEGG.Compound.Record-shaped row. */
export function normalizeKeggCompoundRow(record: KeggFlatRecord): Record<string, unknown> {
  const names = allFields(record, 'NAME').map(stripTrailingSemicolon)
  const pathways = parsePathwayRefs(allFields(record, 'PATHWAY'))
  const enzymes = allFields(record, 'ENZYME').flatMap(
    (value) =>
      value
        .match(/.{1,16}/g)
        ?.map((chunk) => chunk.trim())
        .filter(Boolean) ?? [value]
  )
  return {
    entry: record.entry,
    entry_type: record.entry_type,
    name: names,
    preferred_name: names[0],
    formula: firstField(record, 'FORMULA'),
    exact_mass: firstField(record, 'EXACT_MASS') ?? firstField(record, 'MASS'),
    mol_weight: firstField(record, 'MOL_WEIGHT'),
    pathway: pathways,
    pathway_ids: pathways.map((item) => item.id),
    enzyme: enzymes,
    dblinks: parseDbLinks(allFields(record, 'DBLINKS')),
    raw_fields: record.fields
  }
}

/** Biopython Bio.KEGG.Enzyme.Record-shaped row. */
export function normalizeKeggEnzymeRow(record: KeggFlatRecord): Record<string, unknown> {
  const names = allFields(record, 'NAME').map(stripTrailingSemicolon)
  const pathways = parsePathwayRefs(allFields(record, 'PATHWAY'))
  return {
    entry: record.entry.replace(/^EC\s+/i, ''),
    entry_type: record.entry_type,
    name: names,
    preferred_name: names[0],
    classname: allFields(record, 'CLASS'),
    sysname: allFields(record, 'SYSNAME').map(stripTrailingSemicolon),
    reaction: allFields(record, 'REACTION').map(stripTrailingSemicolon),
    substrate: allFields(record, 'SUBSTRATE').map(stripTrailingSemicolon),
    product: allFields(record, 'PRODUCT').map(stripTrailingSemicolon),
    inhibitor: allFields(record, 'INHIBITOR').map(stripTrailingSemicolon),
    cofactor: allFields(record, 'COFACTOR'),
    effector: allFields(record, 'EFFECTOR').map(stripTrailingSemicolon),
    comment: allFields(record, 'COMMENT'),
    pathway: pathways,
    pathway_ids: pathways.map((item) => item.id),
    genes: allFields(record, 'GENES'),
    disease: allFields(record, 'DISEASE'),
    dblinks: parseDbLinks(allFields(record, 'DBLINKS')),
    raw_fields: record.fields
  }
}

/** Pathway / generic get() record row. */
export function normalizeKeggPathwayRow(record: KeggFlatRecord): Record<string, unknown> {
  const names = allFields(record, 'NAME').map(stripTrailingSemicolon)
  return {
    entry: record.entry,
    entry_type: record.entry_type,
    name: names,
    preferred_name: names[0],
    description: firstField(record, 'DESCRIPTION'),
    class: allFields(record, 'CLASS'),
    module: allFields(record, 'MODULE'),
    disease: allFields(record, 'DISEASE'),
    drug: allFields(record, 'DRUG'),
    organism: firstField(record, 'ORGANISM'),
    gene: allFields(record, 'GENE'),
    compound: allFields(record, 'COMPOUND'),
    enzyme: allFields(record, 'ENZYME'),
    reaction: allFields(record, 'REACTION'),
    ko_pathway: firstField(record, 'KO_PATHWAY'),
    dblinks: parseDbLinks(allFields(record, 'DBLINKS')),
    raw_fields: record.fields
  }
}

export function normalizeKeggEntryRow(record: KeggFlatRecord): Record<string, unknown> {
  const entryType = (record.entry_type ?? '').toLowerCase()
  if (entryType.includes('compound') || /^C\d+$/i.test(record.entry)) {
    return normalizeKeggCompoundRow(record)
  }
  if (entryType.includes('enzyme') || /^\d+\.\d+\.\d+\.\d+$/.test(record.entry)) {
    return normalizeKeggEnzymeRow(record)
  }
  if (entryType.includes('pathway') || /^(map|ko|[a-z]{3})\d+$/i.test(record.entry)) {
    return normalizeKeggPathwayRow(record)
  }
  if (entryType.includes('cds') || entryType.includes('gene') || record.entry.includes(':')) {
    return normalizeKeggGeneRow(record)
  }
  return normalizeKeggPathwayRow(record)
}

export function keggListRowsToRecords(rows: KeggListRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const description = row.description
    let gene_symbol: string | undefined
    let aliases: string[] | undefined
    let definition: string | undefined
    if (description) {
      const parts = description
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
      if (parts.length > 0) {
        const namePart = parts[0]
        const names = namePart
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
        gene_symbol = names[0]
        aliases = names.slice(1)
        definition = parts.slice(1).join('; ') || undefined
      }
    }
    return {
      id: row.id,
      entry: row.id,
      description,
      ...(gene_symbol ? { gene_symbol } : {}),
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      ...(definition ? { definition } : {})
    }
  })
}
