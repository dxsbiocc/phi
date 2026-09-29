import type { DbFilter, DbQueryParams } from '../manifest-types'
import { validateDbQueryWindow } from './types'
import { booleanValue, stringValue, uniqueStrings } from './uniprot-utils'

const UNIPROT_ACCESSION_PATTERN = /^[A-Z0-9]{6,10}(?:-\d+)?$/i
const UNIPROT_STRING_FILTER_FIELDS = new Set([
  'accession',
  'primary_accession',
  'entry_name',
  'id',
  'mnemonic',
  'gene_name',
  'gene',
  'gene_symbol',
  'protein_name',
  'protein',
  'product',
  'organism_id',
  'tax_id',
  'taxid',
  'organism',
  'organism_name',
  'species',
  'protein_existence',
  'ec',
  'ec_number',
  'ec_numbers',
  'keyword',
  'keywords',
  'go',
  'go_id',
  'go_terms',
  'xref',
  'cross_reference',
  'xref_database',
  'database'
])
const UNIPROT_RANGE_FILTER_FIELDS = new Set([
  'sequence_length',
  'length',
  'date_created',
  'date_modified',
  'date_sequence_modified'
])

export function uniprotProteinFilterFields(): string[] {
  return [...UNIPROT_STRING_FILTER_FIELDS, ...UNIPROT_RANGE_FILTER_FIELDS, 'reviewed']
}
const UNIPROT_STRING_FILTER_OPS = new Set<DbFilter['op']>(['=', 'like', 'in'])
const UNIPROT_RANGE_FILTER_OPS = new Set<DbFilter['op']>(['=', '>', '>=', '<', '<=', 'between'])

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function formatUniProtQueryValue(value: string): string {
  const escaped = escapeQueryValue(value)
  return /\s/.test(value) ? `"${escaped}"` : escaped
}

function primaryFilter(params: DbQueryParams, field: string): DbFilter | undefined {
  return params.filters?.find((filter) => filter.field === field)
}

export function filterString(params: DbQueryParams, field: string): string | undefined {
  return stringValue(primaryFilter(params, field)?.value)
}

export function filterStringList(params: DbQueryParams, field: string): string[] {
  const value = primaryFilter(params, field)?.value
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => (typeof item === 'string' ? item : undefined)))
  }
  const text = stringValue(value)
  return text
    ? uniqueStrings(
        text
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      )
    : []
}

function filterBoolean(params: DbQueryParams, field: string): boolean | undefined {
  return booleanValue(primaryFilter(params, field)?.value)
}

function firstFilter(params: DbQueryParams, fields: string[]): DbFilter | undefined {
  return fields.map((field) => primaryFilter(params, field)).find(Boolean)
}

function appendStringQueryFilter(
  queryParts: string[],
  params: DbQueryParams,
  fields: string[],
  queryField: string
): void {
  const filter = firstFilter(params, fields)
  if (!filter) return
  if (!['=', 'like', 'in'].includes(filter.op)) return
  const values = filterValues(filter)
  if (values.length === 0) return
  const formattedValues = values.map((value) => `${queryField}:${formatUniProtQueryValue(value)}`)
  if (formattedValues.length === 1) {
    queryParts.push(formattedValues[0])
    return
  }
  queryParts.push(`(${formattedValues.join(' OR ')})`)
}

function appendRangeQueryFilter(
  queryParts: string[],
  params: DbQueryParams,
  fields: string[],
  queryField: string
): void {
  const filter = firstFilter(params, fields)
  if (!filter) return
  const value = filter.value
  if (filter.op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return
    const [start, end] = value.map(scalarText)
    if (start && end) queryParts.push(`${queryField}:[${start} TO ${end}]`)
    return
  }

  const text = scalarText(value)
  if (!text) return
  switch (filter.op) {
    case '=':
      queryParts.push(`${queryField}:${formatUniProtQueryValue(text)}`)
      break
    case '>':
    case '>=':
      queryParts.push(`${queryField}:[${text} TO *]`)
      break
    case '<':
    case '<=':
      queryParts.push(`${queryField}:[* TO ${text}]`)
      break
    default:
      break
  }
}

function filterValues(filter: DbFilter): string[] {
  if (filter.op === 'in' && Array.isArray(filter.value)) {
    return uniqueStrings(filter.value.map(scalarText))
  }
  const text = scalarText(filter.value)
  return text ? [text] : []
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return stringValue(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}

export function validateUniProtQueryInputs(params: DbQueryParams): void {
  validateDbQueryWindow(params, 'opaque')
  const filters = params.filters ?? []
  if (filters.length > 0 && params.rawQuery?.trim()) {
    throw new Error('UniProt filters and rawQuery cannot be used together')
  }

  const seenFields = new Set<string>()
  for (const filter of filters) {
    if (seenFields.has(filter.field)) throw new Error(`UniProt duplicate filter: ${filter.field}`)
    seenFields.add(filter.field)
  }

  if (params.domain === 'id_mapping') {
    if (params.rawQuery?.trim()) throw new Error('UniProt ID mapping does not support rawQuery')
    for (const filter of filters) {
      const allowedOps =
        filter.field === 'ids'
          ? UNIPROT_STRING_FILTER_OPS
          : filter.field === 'from' || filter.field === 'to'
            ? new Set<DbFilter['op']>(['='])
            : undefined
      if (!allowedOps) throw new Error(`UniProt id_mapping does not accept filter: ${filter.field}`)
      if (!allowedOps.has(filter.op)) {
        throw new Error(
          `UniProt id_mapping does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
    }
    return
  }

  if (params.domain === 'protein') {
    for (const filter of filters) {
      const allowedOps =
        filter.field === 'reviewed'
          ? new Set<DbFilter['op']>(['='])
          : UNIPROT_STRING_FILTER_FIELDS.has(filter.field)
            ? UNIPROT_STRING_FILTER_OPS
            : UNIPROT_RANGE_FILTER_FIELDS.has(filter.field)
              ? UNIPROT_RANGE_FILTER_OPS
              : undefined
      if (!allowedOps) throw new Error(`UniProt protein does not accept filter: ${filter.field}`)
      if (!allowedOps.has(filter.op)) {
        throw new Error(
          `UniProt protein does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
      if (filter.field === 'reviewed' && typeof filter.value !== 'boolean') {
        throw new Error('UniProt reviewed filter requires a boolean value')
      }
    }
    return
  }

  if (params.domain === 'uniref' || params.domain === 'uniparc' || params.domain === 'proteome') {
    for (const filter of filters) {
      if (!filter.field.trim()) throw new Error(`UniProt ${params.domain} filter field is empty`)
      if (!UNIPROT_STRING_FILTER_OPS.has(filter.op)) {
        throw new Error(
          `UniProt ${params.domain} does not support op ${filter.op} for filter: ${filter.field}`
        )
      }
    }
  }
}

export function directUniProtKbAccession(params: DbQueryParams): string | undefined {
  if (params.domain !== 'protein' || params.rawQuery?.trim() || params.cursor) return undefined
  if (!params.filters || params.filters.length !== 1) return undefined
  const [filter] = params.filters
  if (filter.field !== 'accession' || filter.op !== '=') return undefined
  const accession = stringValue(filter.value)
  if (!accession || !UNIPROT_ACCESSION_PATTERN.test(accession)) return undefined
  return accession.toUpperCase()
}

export function buildUniProtKbSearchParams(params: DbQueryParams): URLSearchParams {
  if (params.domain !== 'protein') throw new Error(`Unknown UniProt domain: ${params.domain}`)
  validateUniProtQueryInputs(params)

  const queryParts: string[] = []
  if (params.rawQuery?.trim()) {
    queryParts.push(params.rawQuery.trim())
  } else {
    const reviewed = filterBoolean(params, 'reviewed')

    appendStringQueryFilter(queryParts, params, ['accession', 'primary_accession'], 'accession')
    appendStringQueryFilter(queryParts, params, ['entry_name', 'id', 'mnemonic'], 'id')
    appendStringQueryFilter(queryParts, params, ['gene_name', 'gene', 'gene_symbol'], 'gene_exact')
    appendStringQueryFilter(
      queryParts,
      params,
      ['protein_name', 'protein', 'product'],
      'protein_name'
    )
    appendStringQueryFilter(queryParts, params, ['organism_id', 'tax_id', 'taxid'], 'organism_id')
    appendStringQueryFilter(
      queryParts,
      params,
      ['organism', 'organism_name', 'species'],
      'organism_name'
    )
    appendStringQueryFilter(queryParts, params, ['protein_existence'], 'existence')
    appendStringQueryFilter(queryParts, params, ['ec', 'ec_number', 'ec_numbers'], 'ec')
    appendStringQueryFilter(queryParts, params, ['keyword', 'keywords'], 'keyword')
    appendStringQueryFilter(queryParts, params, ['go', 'go_id', 'go_terms'], 'go')
    appendStringQueryFilter(queryParts, params, ['xref', 'cross_reference'], 'xref')
    appendStringQueryFilter(queryParts, params, ['xref_database', 'database'], 'database')
    appendRangeQueryFilter(queryParts, params, ['sequence_length', 'length'], 'length')
    appendRangeQueryFilter(queryParts, params, ['date_created'], 'date_created')
    appendRangeQueryFilter(queryParts, params, ['date_modified'], 'date_modified')
    appendRangeQueryFilter(queryParts, params, ['date_sequence_modified'], 'date_sequence_modified')
    if (reviewed !== undefined) queryParts.push(`reviewed:${reviewed ? 'true' : 'false'}`)
  }

  const searchParams = new URLSearchParams()
  searchParams.set('query', queryParts.length > 0 ? queryParts.join(' AND ') : '*')
  searchParams.set(
    'fields',
    [
      'accession',
      'id',
      'reviewed',
      'protein_name',
      'protein_existence',
      'gene_names',
      'organism_name',
      'organism_id',
      'lineage',
      'sequence',
      'date_created',
      'date_modified',
      'date_sequence_modified',
      'version',
      'cc_function',
      'cc_disease',
      'cc_subcellular_location',
      'cc_catalytic_activity',
      'cc_cofactor',
      'cc_pathway',
      'cc_interaction',
      'cc_alternative_products',
      'ec',
      'keyword',
      'lit_pubmed_id',
      'ft_domain',
      'ft_region',
      'ft_act_site',
      'ft_binding',
      'ft_mod_res',
      'ft_variant',
      'ft_signal',
      'ft_transmem',
      'ft_topo_dom',
      'ft_chain',
      'ft_peptide',
      'ft_propep',
      'ft_repeat',
      'ft_motif',
      'ft_coiled',
      'ft_zn_fing',
      'ft_disulfid',
      'ft_mutagen',
      'go_id',
      'xref_pdb',
      'xref_ensembl',
      'xref_refseq',
      'xref_geneid',
      'xref_embl',
      'xref_ccds',
      'xref_alphafolddb',
      'xref_interpro',
      'xref_pfam',
      'xref_prosite',
      'xref_smart',
      'xref_supfam',
      'xref_string',
      'xref_reactome',
      'xref_kegg',
      'xref_chembl',
      'xref_drugbank',
      'xref_proteomes'
    ].join(',')
  )
  searchParams.set('format', 'json')
  searchParams.set('size', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)
  return searchParams
}

export function buildUniProtCollectionSearchParams(params: DbQueryParams): URLSearchParams {
  const searchParams = new URLSearchParams()
  searchParams.set('query', params.rawQuery?.trim() || queryFromFilters(params.filters) || '*')
  searchParams.set('format', 'json')
  searchParams.set('size', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)
  return searchParams
}

function queryFromFilters(filters: DbFilter[] | undefined): string | undefined {
  const parts =
    filters
      ?.map((filter) => {
        const values = filterValues(filter)
        if (values.length === 0) return undefined
        const rendered = values.map((value) => `${filter.field}:${formatUniProtQueryValue(value)}`)
        return rendered.length === 1 ? rendered[0] : `(${rendered.join(' OR ')})`
      })
      .filter((part): part is string => Boolean(part)) ?? []
  return parts.length > 0 ? parts.join(' AND ') : undefined
}
