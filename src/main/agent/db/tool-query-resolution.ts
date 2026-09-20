import type {
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFilter,
  DbResolvedQuery
} from './manifest-types'

export interface ResolvedDbQueryInput {
  database: string
  domain: string
  filters?: DbFilter[]
  fields?: string[]
  rawQuery?: string
  resolvedQuery: DbResolvedQuery
}

export function resolveDbQueryInput(
  record: Record<string, unknown>,
  catalog: DbConnectorCatalogEntry[]
): ResolvedDbQueryInput | { error: string } {
  const explicitDatabase = stringParam(record.database)
  const explicitDomain = stringParam(record.domain)
  const querySource = querySourceParam(record)
  const queryText = querySource?.value
  const explicitFilters = filtersParam(record.filters)
  const explicitRawQuery = stringParam(record.rawQuery)
  const explicitFields = fieldsParam(record.fields)
  const reasons: string[] = []

  let entry = explicitDatabase
    ? catalog.find((candidate) => candidate.manifest.id === explicitDatabase)
    : undefined
  let domain = explicitDomain
  let targetSource: DbResolvedQuery['targetSource'] =
    explicitDatabase && explicitDomain ? 'explicit' : 'heuristic'

  if (!entry && explicitDatabase) {
    return {
      database: explicitDatabase,
      domain: explicitDomain ?? '',
      filters: explicitFilters,
      fields: explicitFields,
      rawQuery: explicitRawQuery,
      resolvedQuery: {
        database: explicitDatabase,
        domain: explicitDomain ?? '',
        inferred: false,
        targetSource: 'explicit',
        predicateSource: explicitFilters || explicitRawQuery ? 'explicit' : 'none',
        ...(querySource ? { input: { source: querySource.source, text: querySource.value } } : {}),
        ...(explicitFilters ? { filters: explicitFilters } : {}),
        ...(explicitFields ? { fields: explicitFields } : {}),
        ...(explicitRawQuery ? { rawQuery: explicitRawQuery } : {}),
        reasons: ['database was provided explicitly; catalog validation will report if missing']
      }
    }
  }

  if (!entry || !domain) {
    const inferred = inferDbQueryTarget({
      queryText,
      catalog,
      database: explicitDatabase,
      domain: explicitDomain
    })
    if (!inferred) {
      return {
        error: 'db_query 需要 database/domain，或能推断数据库与 domain 的 query/term/keyword。'
      }
    }
    entry = inferred.entry
    domain = inferred.domain.id
    targetSource = inferred.targetSource
    reasons.push(
      inferred.targetSource === 'single_candidate'
        ? `selected ${entry.manifest.id}/${domain} because it is the only matching enabled catalog candidate`
        : `selected ${entry.manifest.id}/${domain} from ${querySource?.source ?? 'query'} intent${
            inferred.score === undefined ? '' : ` (score ${inferred.score})`
          }`
    )
  } else {
    reasons.push(`database/domain provided explicitly as ${entry.manifest.id}/${domain}`)
  }

  const inferredQuery =
    !explicitFilters && !explicitRawQuery && queryText
      ? inferQueryPredicate(entry.manifest.id, domain, queryText)
      : {}
  const filters = explicitFilters ?? inferredQuery.filters
  const rawQuery = explicitRawQuery ?? inferredQuery.rawQuery
  const predicateSource: DbResolvedQuery['predicateSource'] =
    explicitFilters || explicitRawQuery
      ? 'explicit'
      : inferredQuery.filters || inferredQuery.rawQuery
        ? 'heuristic'
        : 'none'

  if (explicitFilters) {
    reasons.push('filters were provided explicitly')
  } else if (explicitRawQuery) {
    reasons.push('rawQuery was provided explicitly')
  } else if (inferredQuery.filters) {
    reasons.push('converted query text into portable filters')
  } else if (inferredQuery.rawQuery) {
    reasons.push('converted query text into rawQuery for the selected domain')
  }
  if (explicitFields) reasons.push('fields were provided explicitly')

  return {
    database: entry.manifest.id,
    domain,
    filters,
    fields: explicitFields,
    rawQuery,
    resolvedQuery: {
      database: entry.manifest.id,
      domain,
      inferred: targetSource !== 'explicit' || predicateSource === 'heuristic',
      targetSource,
      predicateSource,
      ...(querySource ? { input: { source: querySource.source, text: querySource.value } } : {}),
      ...(filters ? { filters } : {}),
      ...(explicitFields ? { fields: explicitFields } : {}),
      ...(rawQuery ? { rawQuery } : {}),
      reasons
    }
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function querySourceParam(
  record: Record<string, unknown>
): { source: 'query' | 'term' | 'keyword'; value: string } | undefined {
  const query = stringParam(record.query)
  if (query) return { source: 'query', value: query }
  const term = stringParam(record.term)
  if (term) return { source: 'term', value: term }
  const keyword = stringParam(record.keyword)
  return keyword ? { source: 'keyword', value: keyword } : undefined
}

function fieldsParam(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((field): field is string => typeof field === 'string' && field.trim() !== '')
    : undefined
}

function filtersParam(value: unknown): DbFilter[] | undefined {
  return Array.isArray(value) ? (value as DbFilter[]) : undefined
}

function inferDbQueryTarget({
  queryText,
  catalog,
  database,
  domain
}: {
  queryText?: string
  catalog: DbConnectorCatalogEntry[]
  database?: string
  domain?: string
}):
  | {
      entry: DbConnectorCatalogEntry
      domain: DbDomainManifest
      targetSource: Extract<DbResolvedQuery['targetSource'], 'single_candidate' | 'heuristic'>
      score?: number
    }
  | undefined {
  const candidates = catalog
    .filter((entry) => !database || entry.manifest.id === database)
    .filter((entry) => Boolean(database) || entry.enabledForQuery)
    .flatMap((entry) =>
      entry.manifest.domains
        .filter((candidate) => !domain || candidate.id === domain)
        .map((candidate) => ({ entry, domain: candidate }))
    )

  if (candidates.length === 1) {
    return { ...candidates[0], targetSource: 'single_candidate' }
  }
  if (!queryText) return undefined

  const scored = candidates
    .map((candidate) => ({ ...candidate, score: scoreDbQueryTarget(candidate, queryText) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return `${left.entry.manifest.id}/${left.domain.id}`.localeCompare(
        `${right.entry.manifest.id}/${right.domain.id}`
      )
    })
  const match = scored[0]
  return match
    ? {
        entry: match.entry,
        domain: match.domain,
        targetSource: 'heuristic',
        score: match.score
      }
    : undefined
}

function scoreDbQueryTarget(
  candidate: { entry: DbConnectorCatalogEntry; domain: DbDomainManifest },
  queryText: string
): number {
  const query = queryText.toLowerCase()
  const { entry, domain } = candidate
  let score = 0
  if (query.includes(entry.manifest.id.toLowerCase())) score += 120
  if (query.includes(entry.manifest.name.toLowerCase())) score += 80
  if (query.includes(domain.id.toLowerCase())) score += 60
  if (entry.manifest.curationTier === 'curated') score += 5

  if (entry.manifest.id === 'entrez/ncbi') {
    if (/\bncbi\b|\bentrez\b/.test(query)) score += 80
    if (
      domain.id === 'pubmed' &&
      /\bpubmed\b|\bpmid\b|\bdoi\b|\bpaper\b|\babstract\b|\bliterature\b|\barticle\b/.test(query)
    )
      score += 150
    if (
      domain.id === 'clinvar' &&
      /\bclinvar\b|\bvariant\b|\bvariation\b|\bpathogenic\b|\bclinical\b/.test(query)
    )
      score += 150
    if (domain.id === 'protein') {
      if (/\brefseq\b|\bfasta\b|\b(?:NP|XP|YP|WP|AP)_\d+(?:\.\d+)?\b/.test(query)) {
        score += 160
      }
      if (
        /\bncbi\b|\bentrez\b/.test(query) &&
        /\bprotein\b|\bsequence\b|\bamino\s+acid\b/.test(query)
      ) {
        score += 150
      }
      if (/\bprotein\b|\baccession\b|\bfasta\b|\bsequence\b|\bamino\s+acid\b/.test(query)) {
        score += 35
      }
    }
    if (domain.id === 'nucleotide') {
      if (/\b(?:NC|NG|NM|NR|XM|XR|NT|NW|AC|AP|CP|CM)_\d+(?:\.\d+)?\b/.test(query)) {
        score += 170
      }
      if (/\bnucleotide\b|\bnuccore\b|\bdna\b|\brna\b|\bmrna\b|\bgenbank\b/.test(query)) {
        score += 150
      }
      if (/\bncbi\b|\bentrez\b/.test(query) && /\bsequence\b|\bfasta\b/.test(query)) {
        score += 45
      }
    }
    if (domain.id === 'biosample') {
      if (/\b(?:SAMN|SAMEA|SAMD)\d+\b/i.test(queryText)) score += 180
      if (
        /\bbiosample\b|\bsample\s+metadata\b|\bsample\s+attribute|\bgeo_loc_name\b|\bisolation\s+source\b|\btissue\b/.test(
          query
        )
      )
        score += 150
    }
    if (domain.id === 'sra') {
      if (/\b(?:SRR|SRX|SRP|SRS|SRA|ERR|ERX|ERP|ERS|DRR|DRX|DRP|DRS)\d+\b/i.test(queryText)) {
        score += 185
      }
      if (
        /\bsra\b|\bsequence\s+read\s+archive\b|\bsequencing\s+run\b|\breads?\s+archive\b|\bexperiment\s+accession\b|\brna-?seq\s+run\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (domain.id === 'geo') {
      if (/\b(?:GSE|GSM|GPL|GDS)\d+\b/i.test(queryText)) score += 185
      if (
        /\bgeo\b|\bgene\s+expression\s+omnibus\b|\bgds\b|\bgeo\s+datasets?\b|\bexpression\s+profil(?:e|ing)\b|\bmicroarray\b|\bseries\s+accession\b|\bplatform\s+accession\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (domain.id === 'bioproject') {
      if (/\bPRJ(?:NA|EB|DB)\d+\b/i.test(queryText)) score += 185
      if (
        /\bbioproject\b|\bbio\s+project\b|\bproject\s+accession\b|\bproject\s+metadata\b|\bproject\s+data\s+type\b|\bsubmitter\s+organization\b/.test(
          query
        )
      ) {
        score += 150
      }
    }
    if (
      domain.id === 'taxonomy' &&
      /\btaxonomy\b|\btaxon\b|\btaxid\b|\btaxonomy\s+id\b|\borganism\b|\bspecies\b|\blineage\b/.test(
        query
      )
    )
      score += 150
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bhgnc\b/.test(query)) score += 90
  }

  if (entry.manifest.id === 'rest-json/ensembl') {
    if (/\bensembl\b/.test(query)) score += 150
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bhgnc\b/.test(query)) score += 30
    const stableId = ensemblStableIdFromText(queryText)
    const variantId = ensemblVariantIdFromText(queryText)
    const hgvs = ensemblHgvsFromText(queryText)
    const requestsVep = /\bvep\b|\bvariant\s+effect\b|\bconsequences?\b/.test(query)
    if (domain.id === 'lookup_id' && stableId && !/\bsequence\b|\bfasta\b/.test(query)) {
      score += 220
    }
    if (domain.id === 'sequence_id' && stableId && /\bsequence\b|\bfasta\b/.test(query)) {
      score += 260
    }
    if (domain.id === 'variation' && variantId && !requestsVep) score += 250
    if (domain.id === 'vep_id' && variantId && requestsVep) score += 300
    if (domain.id === 'vep_hgvs' && hgvs && requestsVep) score += 320
  }

  if (entry.manifest.id === 'rest-json/uniprot') {
    if (/\buniprot\b|\buniprotkb\b/.test(query)) score += 180
    if (
      domain.id === 'id_mapping' &&
      (/\bid\s+mapping\b|\bmap\b|\bmapping\b|\bconvert\b|\bconversion\b|\bxref\b|\bcross-?ref/.test(
        query
      ) ||
        uniprotMappingTargetFromText(queryText))
    ) {
      score += 220
    }
    if (
      domain.id === 'protein' &&
      /\bprotein\b|\baccession\b|\bsequence\b|\bfasta\b|\bamino\s+acid\b|\bswiss-?prot\b|\btrembl\b|\bgo\b|\bpdb\b/.test(
        query
      )
    ) {
      score += 150
    }
    if (uniprotAccessionFromText(queryText)) {
      score += 170
    }
  }

  if (entry.manifest.id === 'sparql/uniprot') {
    if (/\buniprot\b|\bprotein\b|\baccession\b|\bsequence\b|\bamino\s+acid\b/.test(query)) {
      score += 80
    }
  }

  if (extractPrimaryDbQueryTerm(queryText)) {
    if (entry.manifest.id === 'entrez/ncbi' && domain.id === 'gene') score += 35
    if (entry.manifest.id === 'rest-json/ensembl' && domain.id === 'gene') score += 25
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'protein') score += 35
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'id_mapping') score += 25
    if (entry.manifest.id === 'sparql/uniprot' && domain.id === 'protein') score += 20
  }

  return score
}

function inferQueryPredicate(
  database: string,
  domain: string,
  queryText: string
): { filters?: DbFilter[]; rawQuery?: string } {
  const term = extractPrimaryDbQueryTerm(queryText) ?? queryText.trim()
  if (!term) return {}

  if (database === 'entrez/ncbi' && domain === 'gene') {
    return { filters: [{ field: 'gene', op: '=', value: term }] }
  }
  if (database === 'entrez/ncbi' && domain === 'pubmed') {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'protein') {
    const organism = /\bhuman\b|\bhomo\s+sapiens\b/i.test(queryText)
      ? ' AND Homo sapiens[organism]'
      : ''
    return { rawQuery: `${term}${organism}` }
  }
  if (database === 'entrez/ncbi' && domain === 'nucleotide') {
    const organism = /\bhuman\b|\bhomo\s+sapiens\b/i.test(queryText)
      ? ' AND Homo sapiens[organism]'
      : ''
    return { rawQuery: `${term}${organism}` }
  }
  if (database === 'entrez/ncbi' && domain === 'biosample') {
    const accession = queryText.match(/\b(?:SAMN|SAMEA|SAMD)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(/\b(?:ncbi|entrez|biosample|sample|metadata|attribute|attributes)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'sra') {
    const accession = queryText.match(
      /\b(?:SRR|SRX|SRP|SRS|SRA|ERR|ERX|ERP|ERS|DRR|DRX|DRP|DRS)\d+\b/i
    )?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|sra|sequence\s+read\s+archive|sequencing|run|runs|experiment|accession|metadata)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'geo') {
    const accession = queryText.match(/\b(?:GSE|GSM|GPL|GDS)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|geo|gene\s+expression\s+omnibus|gds|datasets?|series|sample|platform|accession|metadata|expression\s+profiling|expression\s+profile|microarray)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'bioproject') {
    const accession = queryText.match(/\bPRJ(?:NA|EB|DB)\d+\b/i)?.[0]
    const cleaned =
      accession ??
      queryText
        .replace(
          /\b(?:ncbi|entrez|bioproject|bio\s+project|project|accession|metadata|data\s+type|submitter|organization)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'taxonomy') {
    const taxId = queryText.match(/\b(?:taxid|taxon(?:omy)?\s+id)\s*[:#]?\s*(\d+)\b/i)?.[1]
    const cleaned =
      taxId ??
      queryText
        .replace(/\b(?:ncbi|entrez|taxonomy|taxon|taxid|organism|species|lineage)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return { rawQuery: taxId ? `${taxId}[uid]` : cleaned || queryText.trim() }
  }
  if (database === 'entrez/ncbi' && domain === 'clinvar') {
    return { rawQuery: looksLikeClinvarAccession(term) ? term : `${term}[gene]` }
  }
  if (database === 'rest-json/ensembl' && (domain === 'gene' || domain === 'xref')) {
    return { filters: [{ field: 'symbol', op: '=', value: term }] }
  }
  if (database === 'rest-json/ensembl' && domain === 'lookup_id') {
    return {
      filters: [{ field: 'id', op: '=', value: ensemblStableIdFromText(queryText) ?? term }]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'sequence_id') {
    return {
      filters: [{ field: 'id', op: '=', value: ensemblStableIdFromText(queryText) ?? term }]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'variation') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'id', op: '=', value: ensemblVariantIdFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'vep_id') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'id', op: '=', value: ensemblVariantIdFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/ensembl' && domain === 'vep_hgvs') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'hgvs', op: '=', value: ensemblHgvsFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/uniprot' && domain === 'protein') {
    const accession = uniprotAccessionFromText(queryText)
    return accession
      ? { filters: [{ field: 'accession', op: '=', value: accession }] }
      : { filters: [{ field: 'gene_name', op: '=', value: term }] }
  }
  if (database === 'rest-json/uniprot' && domain === 'id_mapping') {
    const accession = uniprotAccessionFromText(queryText) ?? term
    return {
      filters: [
        { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
        { field: 'to', op: '=', value: uniprotMappingTargetFromText(queryText) ?? 'Ensembl' },
        { field: 'ids', op: 'in', value: [accession] }
      ]
    }
  }
  if (database === 'sparql/uniprot' && domain === 'protein') {
    return { filters: [{ field: 'gene_name', op: '=', value: term }] }
  }

  return { rawQuery: queryText.trim() }
}

const DB_QUERY_TERM_STOPWORDS = new Set([
  'NCBI',
  'ENTREZ',
  'PUBMED',
  'PMID',
  'DOI',
  'CLINVAR',
  'ENSEMBL',
  'UNIPROT',
  'REFSEQ',
  'SEQUENCE',
  'FASTA',
  'NUCLEOTIDE',
  'NUCLEOTIDES',
  'NUCCORE',
  'BIOSAMPLE',
  'SAMPLE',
  'SAMPLES',
  'METADATA',
  'ATTRIBUTE',
  'ATTRIBUTES',
  'SRA',
  'SRR',
  'SRX',
  'SRP',
  'SRS',
  'RUN',
  'RUNS',
  'EXPERIMENT',
  'GEO',
  'GDS',
  'GSE',
  'GSM',
  'GPL',
  'DATASET',
  'DATASETS',
  'SERIES',
  'PLATFORM',
  'PLATFORMS',
  'MICROARRAY',
  'OMNIBUS',
  'BIOPROJECT',
  'PROJECT',
  'PROJECTS',
  'PRJNA',
  'PRJEB',
  'PRJDB',
  'SUBMITTER',
  'ORGANIZATION',
  'TAXONOMY',
  'TAXON',
  'TAXID',
  'ORGANISM',
  'SPECIES',
  'LINEAGE',
  'GENBANK',
  'DNA',
  'RNA',
  'MRNA',
  'AMINO',
  'ACID',
  'GENE',
  'GENES',
  'PROTEIN',
  'PROTEINS',
  'VARIANT',
  'VARIANTS',
  'HUMAN',
  'HOMO',
  'SAPIENS'
])

function extractPrimaryDbQueryTerm(queryText: string): string | undefined {
  const tokens = queryText.match(/[A-Za-z][A-Za-z0-9_.-]{1,30}/g) ?? []
  return tokens.find((token) => {
    const upper = token.toUpperCase()
    if (DB_QUERY_TERM_STOPWORDS.has(upper)) return false
    return /\d/.test(token) || token === upper
  })
}

function looksLikeClinvarAccession(value: string): boolean {
  return /^(VCV|RCV|SCV)\d+$/i.test(value)
}

function uniprotAccessionFromText(value: string): string | undefined {
  return value.match(/\b(?:[A-NR-Z][0-9][A-Z0-9]{3}[0-9]|[A-Z][0-9][A-Z0-9]{3}[0-9]-\d+)\b/)?.[0]
}

function uniprotMappingTargetFromText(value: string): string | undefined {
  const query = value.toLowerCase()
  if (/\bensembl\b/.test(query)) return 'Ensembl'
  if (/\bpdb\b|\bprotein\s+data\s+bank\b/.test(query)) return 'PDB'
  if (/\brefseq\s+protein\b|\brefseq_protein\b/.test(query)) return 'RefSeq_Protein'
  if (/\brefseq\b|\brefseq\s+(?:nucleotide|rna|dna)\b/.test(query)) return 'RefSeq_Nucleotide'
  if (/\bgeneid\b|\bgene\s+id\b|\bncbi\s+gene\b/.test(query)) return 'GeneID'
  if (/\bembl\b/.test(query)) return 'EMBL'
  if (/\buniparc\b/.test(query)) return 'UniParc'
  return undefined
}

function ensemblStableIdFromText(value: string): string | undefined {
  return value.match(/\bENS[A-Z]*\d+(?:\.\d+)?\b/i)?.[0].toUpperCase()
}

function ensemblVariantIdFromText(value: string): string | undefined {
  return value.match(/\brs\d+\b/i)?.[0].toLowerCase()
}

function ensemblHgvsFromText(value: string): string | undefined {
  return value.match(/\b(?:[A-Z]{1,4}_\d+(?:\.\d+)?:)?[\w.-]+:[cgmnpr]\.\S+/i)?.[0]
}
