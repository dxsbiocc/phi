import type {
  DbAdapterQueryResult,
  DbDownloadFileCandidate,
  DbResultSummary,
  DbResultViewerHint
} from './manifest-types'

const PROTEIN_STRUCTURE_FIELDS = new Set([
  'pdb',
  'pdbid',
  'pdbids',
  'pdbaccession',
  'rcsbid',
  'structureid',
  'structureaccession',
  'mmcif',
  'mmcifurl',
  'cif',
  'cifurl',
  'pdbfile',
  'pdburl',
  'structurefile',
  'structureurl'
])

const SMALL_MOLECULE_FIELDS = new Set([
  'smiles',
  'canonicalsmiles',
  'isomericsmiles',
  'inchistring',
  'inchi',
  'inchikey',
  'sdf',
  'sdfurl',
  'mol',
  'molfile',
  'molblock'
])

const NETWORK_FIELD_PAIRS = [
  ['source', 'target'],
  ['sourceid', 'targetid'],
  ['from', 'to'],
  ['interactora', 'interactorb'],
  ['interactor1', 'interactor2'],
  ['proteina', 'proteinb'],
  ['genea', 'geneb'],
  ['bait', 'prey'],
  ['node1', 'node2']
] as const

const NETWORK_SCORE_FIELDS = new Set([
  'score',
  'confidence',
  'confidencescore',
  'combinedscore',
  'weight',
  'interactionscore'
])

function normalizedField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? text : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function sampleValues(values: string[]): string[] {
  const seen = new Set<string>()
  const samples: string[] = []
  for (const value of values) {
    const text = value.replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    samples.push(text.length > 80 ? `${text.slice(0, 77)}...` : text)
    if (samples.length >= 3) break
  }
  return samples
}

function fieldsByNormalizedName(fields: string[]): Map<string, string> {
  return fields.reduce<Map<string, string>>((map, field) => {
    map.set(normalizedField(field), field)
    return map
  }, new Map())
}

function matchingFields(fields: string[], allowed: Set<string>): string[] {
  return fields.filter((field) => allowed.has(normalizedField(field)))
}

function rowTextValues(row: Record<string, unknown>, fields: string[]): string[] {
  return fields.flatMap((field) => {
    const value = row[field]
    if (Array.isArray(value)) return value.map(scalarText).filter((text): text is string => !!text)
    const text = scalarText(value)
    return text ? [text] : []
  })
}

function downloadFiles(row: Record<string, unknown>): DbDownloadFileCandidate[] {
  const value = row.download_files
  if (!Array.isArray(value)) return []
  return value.filter((candidate): candidate is DbDownloadFileCandidate => isRecord(candidate))
}

function hasStructureDownload(row: Record<string, unknown>): boolean {
  return downloadFiles(row).some((candidate) =>
    [candidate.kind, candidate.format, candidate.filename, candidate.url]
      .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
      .some((value) => /\b(pdb|mmcif|cif)\b/.test(value) || value.endsWith('.pdb'))
  )
}

function proteinStructureHint(
  result: DbAdapterQueryResult,
  summary: DbResultSummary
): DbResultViewerHint | undefined {
  const fields = matchingFields(summary.fields, PROTEIN_STRUCTURE_FIELDS)
  const matchingRows = result.rows.filter(
    (row) => rowTextValues(row, fields).length > 0 || hasStructureDownload(row)
  )
  if (matchingRows.length === 0) return undefined
  const values = matchingRows.flatMap((row) => [
    ...rowTextValues(row, fields),
    ...downloadFiles(row)
      .filter((candidate) =>
        [candidate.kind, candidate.format, candidate.filename, candidate.url]
          .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
          .some(
            (value) => value.includes('pdb') || value.includes('mmcif') || value.includes('cif')
          )
      )
      .map((candidate) => candidate.accession ?? candidate.filename ?? candidate.url)
      .filter((value): value is string => !!value)
  ])
  return {
    kind: 'protein_structure',
    label: 'PDB / 结构',
    recommendedLibrary: 'molstar',
    confidence: fields.length > 0 ? 'high' : 'medium',
    rowCount: matchingRows.length,
    fields,
    sampleValues: sampleValues(values),
    reason:
      fields.length > 0 ? `matched fields: ${fields.join(', ')}` : 'matched structure downloads'
  }
}

function smallMoleculeHint(
  result: DbAdapterQueryResult,
  summary: DbResultSummary
): DbResultViewerHint | undefined {
  const fields = matchingFields(summary.fields, SMALL_MOLECULE_FIELDS)
  if (fields.length === 0) return undefined
  const matchingRows = result.rows.filter((row) => rowTextValues(row, fields).length > 0)
  if (matchingRows.length === 0) return undefined
  return {
    kind: 'small_molecule',
    label: '小分子结构',
    recommendedLibrary: 'rdkit-js',
    confidence: 'high',
    rowCount: matchingRows.length,
    fields,
    sampleValues: sampleValues(matchingRows.flatMap((row) => rowTextValues(row, fields))),
    reason: `matched fields: ${fields.join(', ')}`
  }
}

function interactionNetworkHint(
  result: DbAdapterQueryResult,
  summary: DbResultSummary
): DbResultViewerHint | undefined {
  const fields = fieldsByNormalizedName(summary.fields)
  const pair = NETWORK_FIELD_PAIRS.find(
    ([sourceField, targetField]) => fields.has(sourceField) && fields.has(targetField)
  )
  if (!pair) return undefined
  const sourceField = fields.get(pair[0])
  const targetField = fields.get(pair[1])
  if (!sourceField || !targetField) return undefined

  const matchingRows = result.rows.filter(
    (row) =>
      scalarText(row[sourceField]) !== undefined && scalarText(row[targetField]) !== undefined
  )
  if (matchingRows.length === 0) return undefined
  const scoreFields = summary.fields.filter((field) =>
    NETWORK_SCORE_FIELDS.has(normalizedField(field))
  )
  return {
    kind: 'interaction_network',
    label: '互作网络',
    recommendedLibrary: 'cytoscape-js',
    confidence: scoreFields.length > 0 ? 'high' : 'medium',
    rowCount: matchingRows.length,
    fields: [sourceField, targetField, ...scoreFields],
    sampleValues: sampleValues(
      matchingRows.map(
        (row) => `${scalarText(row[sourceField])} -> ${scalarText(row[targetField])}`
      )
    ),
    reason: `matched edge fields: ${sourceField}, ${targetField}`
  }
}

export function detectDbResultViewerHints(result: DbAdapterQueryResult): DbResultViewerHint[] {
  const summary: DbResultSummary = {
    rowCount: result.totalRows ?? result.rows.length,
    returnedRows: result.rows.length,
    truncated: result.truncated,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    fields: [...new Set(result.rows.flatMap((row) => Object.keys(row)))],
    warnings: []
  }
  return [
    proteinStructureHint(result, summary),
    smallMoleculeHint(result, summary),
    interactionNetworkHint(result, summary)
  ].filter((hint): hint is DbResultViewerHint => hint !== undefined)
}
