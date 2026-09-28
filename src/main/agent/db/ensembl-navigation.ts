/**
 * Ensembl REST exposes ~100 domains. Agents should prefer a small primary
 * navigation layer unless the query clearly asks for a secondary/meta/advanced path.
 */

export type EnsemblNavigationTier = 'primary' | 'secondary' | 'meta' | 'advanced'

const PRIMARY_DOMAINS = new Set([
  'gene',
  'lookup_id',
  'lookup_symbol',
  'xref',
  'sequence_id',
  'variation',
  'vep_id',
  'vep_hgvs'
])

const SECONDARY_PREFIXES = [
  'lookup_',
  'xref_',
  'sequence_',
  'overlap_',
  'homology_',
  'genetree_',
  'variation_',
  'variant_',
  'vep_',
  'phenotype_',
  'map_',
  'ld_',
  'transcript_',
  'alignment_'
]

const SECONDARY_EXACT = new Set(['regulation_binding_matrix', 'archive_id', 'archive_id_batch'])

const META_PREFIXES = ['info_']

const ADVANCED_PREFIXES = ['ga4gh_', 'cafe_', 'ontology_', 'taxonomy_']

export function ensemblNavigationTier(domainId: string): EnsemblNavigationTier {
  if (PRIMARY_DOMAINS.has(domainId)) return 'primary'
  if (ADVANCED_PREFIXES.some((prefix) => domainId.startsWith(prefix))) return 'advanced'
  if (META_PREFIXES.some((prefix) => domainId.startsWith(prefix))) return 'meta'
  if (SECONDARY_EXACT.has(domainId)) return 'secondary'
  if (SECONDARY_PREFIXES.some((prefix) => domainId.startsWith(prefix))) return 'secondary'
  return 'advanced'
}

export function isEnsemblBatchDomain(domainId: string): boolean {
  return domainId.endsWith('_batch')
}

/** Primary entry points shown in navigator docs / empty-result hints. */
export const ENSEMBL_PRIMARY_ENTRY_PATHS: Array<{ domain: string; use: string }> = [
  { domain: 'gene', use: 'Human HGNC symbol lookup (compatibility alias for lookup_symbol)' },
  { domain: 'lookup_id', use: 'ENS* / stable ID metadata' },
  { domain: 'lookup_symbol', use: 'Gene symbol lookup for an explicit species' },
  { domain: 'sequence_id', use: 'FASTA / sequence by stable ID' },
  { domain: 'variation', use: 'Variant record by rsID / variation id' },
  { domain: 'vep_id', use: 'VEP consequences by rsID / variation id' },
  { domain: 'vep_hgvs', use: 'VEP consequences by HGVS' },
  { domain: 'xref', use: 'External xrefs for a symbol (human)' }
]

export function ensemblNavigationMarkdown(
  code: (value: string) => string = (v) => `\`${v}\``
): string[] {
  return [
    '## Ensembl Navigation (prefer primary paths)',
    '',
    'Ensembl REST has many endpoints. Prefer these primary domains unless the user asks for compara, GA4GH, archive, ontology, taxonomy, or `info_*` metadata:',
    '',
    ...ENSEMBL_PRIMARY_ENTRY_PATHS.map(
      (entry) => `- ${code(`rest-json/ensembl/${entry.domain}`)} — ${entry.use}`
    ),
    '',
    '- Secondary (only when clearly requested): `sequence_region`, `overlap_*`, `homology_*`, `phenotype_*`, `vep_region`, `ld_*`, `genetree_*`, `*_batch`.',
    '- Meta / advanced (opt-in): `info_*`, `ga4gh_*`, `cafe_*`, `ontology_*`, `taxonomy_*`, `archive_*`.',
    ''
  ]
}

/**
 * Adjust Ensembl domain scores so generic "ensembl" queries do not land on
 * alphabetical first domains (e.g. alignment_region / ga4gh_*).
 */
export function applyEnsemblNavigationScore(
  domainId: string,
  queryText: string,
  baseScore: number
): number {
  if (baseScore <= 0) return baseScore

  const query = queryText.toLowerCase()
  const tier = ensemblNavigationTier(domainId)
  let score = baseScore

  const asksBatch =
    /\bbatch\b|\bmultiple\b|\blist\s+of\b|\bcomma[- ]separated\b|\bseveral\b/.test(query) ||
    (queryText.match(/\bENS[A-Z]*\d+/gi)?.length ?? 0) > 1 ||
    (queryText.match(/\brs\d+\b/gi)?.length ?? 0) > 1

  if (isEnsemblBatchDomain(domainId) && !asksBatch) {
    score -= 180
  }

  if (tier === 'primary') {
    score += 45
    return score
  }

  const asksMeta =
    /\binfo[_ ]|\bping\b|\bassemb(?:ly|lies)\b|\bbiotypes?\b|\bsoftware\s+version\b|\brest\s+version\b|\bspecies\s+list\b|\bexternal\s+dbs?\b|\bcompara\s+methods?\b/.test(
      query
    ) ||
    domainId
      .replace(/_/g, ' ')
      .split(' ')
      .some((token) => token.length > 3 && query.includes(token))

  const asksGa4gh =
    /\bga4gh\b|\bbeacon\b|\bvariantset\b|\bfeatureset\b|\bcallset\b|\breferenceset\b/.test(query)
  const asksCompara =
    /\bcompara\b|\bhomology\b|\bgenetree\b|\bortholog\b|\bparalog\b|\bcafe\b|\balignment\b/.test(
      query
    )
  const asksPhenotype = /\bphenotype\b|\bgwas\b|\btrait\b/.test(query)
  const asksOverlap = /\boverlap\b|\bfeatures?\s+in\s+region\b|\bregion\s+features?\b/.test(query)
  const asksLd = /\bld\b|\blinkage\s+disequilibrium\b|\br2\b|\bd['’]?\s*prime\b/.test(query)
  const asksMap = /\bmap\b|\bcdna\b|\bcds\b|\bassembly\s+mapping\b|\blift\s*over\b/.test(query)
  const asksArchive = /\barchive\b|\bretired\b|\bversion\s+history\b/.test(query)
  const asksOntology = /\bontology\b|\bgo\s+term\b|\bancestors?\b|\bdescendants?\b/.test(query)
  const asksTaxonomy = /\btaxonomy\b|\btaxon\b|\bclassification\b/.test(query)
  const asksRegionSequence =
    /\bsequence\s+region\b|\bgenomic\s+region\b|\bchr(?:omosome)?\s*\d+/.test(query) ||
    /\b(?:chr)?\d+:\d+-\d+\b/i.test(queryText)

  if (tier === 'meta') {
    score += asksMeta ? 40 : -220
    return score
  }

  if (tier === 'advanced') {
    if (domainId.startsWith('ga4gh_')) score += asksGa4gh ? 80 : -260
    else if (
      domainId.startsWith('cafe_') ||
      domainId.startsWith('genetree_') ||
      domainId.startsWith('homology_') ||
      domainId.startsWith('alignment_')
    ) {
      score += asksCompara ? 60 : -200
    } else if (domainId.startsWith('ontology_')) score += asksOntology ? 60 : -220
    else if (domainId.startsWith('taxonomy_')) score += asksTaxonomy ? 60 : -220
    else score += -180
    return score
  }

  // secondary
  if (domainId.startsWith('phenotype_')) score += asksPhenotype ? 80 : -120
  else if (domainId.startsWith('overlap_')) score += asksOverlap ? 80 : -120
  else if (domainId.startsWith('ld_')) score += asksLd ? 80 : -120
  else if (domainId.startsWith('map_')) score += asksMap ? 80 : -120
  else if (domainId.startsWith('archive_')) score += asksArchive ? 80 : -140
  else if (
    domainId.startsWith('homology_') ||
    domainId.startsWith('genetree_') ||
    domainId.startsWith('alignment_')
  ) {
    score += asksCompara ? 70 : -140
  } else if (domainId === 'sequence_region' || domainId === 'sequence_region_batch') {
    score += asksRegionSequence ? 90 : -100
  } else if (domainId.startsWith('vep_region')) {
    score +=
      (/\bvep\b|\bconsequences?\b/.test(query) && asksRegionSequence) ||
      /\bvep\s+region\b/.test(query)
        ? 90
        : -100
  } else {
    // other secondary: small demotion unless domain tokens appear in the query
    const tokens = domainId
      .replace(/_batch$/, '')
      .split('_')
      .filter((t) => t.length > 2)
    const mentioned = tokens.some((token) => query.includes(token))
    score += mentioned ? 20 : -90
  }

  return score
}
