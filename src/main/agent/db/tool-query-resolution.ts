import type {
  DbConnectorCatalogEntry,
  DbDomainManifest,
  DbFilter,
  DbResolvedQuery
} from './manifest-types'
import { applyEnsemblNavigationScore } from './ensembl-navigation'

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
    if (domain.id === 'lookup_symbol' && /\bsymbol\b|\bhgnc\b/.test(query) && !stableId) {
      score += 40
    }
    if (domain.id === 'sequence_id' && stableId && /\bsequence\b|\bfasta\b/.test(query)) {
      score += 260
    }
    if (domain.id === 'variation' && variantId && !requestsVep) score += 250
    if (domain.id === 'vep_id' && variantId && requestsVep) score += 300
    if (domain.id === 'vep_hgvs' && hgvs && requestsVep) score += 320
    if (domain.id === 'xref' && /\bxref\b|\bcross[- ]?ref/.test(query)) score += 80
    score = applyEnsemblNavigationScore(domain.id, queryText, score)
  }

  if (entry.manifest.id === 'rest-json/uniprot') {
    if (/\buniprot\b|\buniprotkb\b/.test(query)) score += 180
    const requestsIdMapping =
      /\bid\s+mapping\b|\bmap\b|\bmapping\b|\bconvert\b|\bconversion\b|\bmap\s+to\b|映射|转换/.test(
        query
      )
    if (domain.id === 'id_mapping' && requestsIdMapping) {
      score += uniprotMappingTargetFromText(queryText) ? 250 : 220
    }
    if (
      domain.id === 'protein' &&
      /\bprotein\b|\baccession\b|\bsequence\b|\bfasta\b|\bamino\s+acid\b|\bswiss-?prot\b|\btrembl\b|\bgo\b|\bpdb\b|\balphafold\b|\bprotein\s+structure\b|蛋白|蛋白质结构/.test(
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

  if (entry.manifest.id === 'rest-json/cbioportal') {
    if (/\bcbioportal\b|\bcbio\b/.test(query)) score += 180
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bhugo\b/.test(query)) score += 40
    if (domain.id === 'studies' && /\bstud(?:y|ies)\b|\btcga\b|\bcancer\s+study\b/.test(query)) {
      score += 120
    }
    if (
      domain.id === 'molecular_profiles' &&
      /\bmolecular\s+profile\b|\bmutation\s+profile\b|\bmrna\b/.test(query)
    ) {
      score += 120
    }
  }

  if (entry.manifest.id === 'rest-json/pdbe') {
    if (/\bpdbe\b|\bpdb\b|\bprotein\s+data\s+bank\b|\bstructure\b/.test(query)) score += 160
    if (domain.id === 'entry_summary' && /\b[0-9][A-Za-z0-9]{3}\b/.test(queryText)) score += 120
    if (domain.id === 'ligand_monomers' && /\bligand\b|\bhet\b|\bcompound\b/.test(query)) {
      score += 80
    }
  }

  if (entry.manifest.id === 'rest-json/string') {
    if (/\bstring(?:-db)?\b|\bprotein[- ]protein\b|\bppi\b|\binteraction\s+network\b/.test(query)) {
      score += 180
    }
    if (domain.id === 'network' && /\bnetwork\b|\binteraction\b/.test(query)) score += 60
    if (domain.id === 'enrichment' && /\benrichment\b|\bgo\s+enrichment\b/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/pubchem') {
    if (/\bpubchem\b|\bcid\b|\bsmiles\b|\bcompound\b|\bchemical\b/.test(query)) score += 160
    if (domain.id === 'compound_by_cid' && /\bcid\s*\d+\b|\b\d{2,9}\b/.test(query)) score += 80
    if (domain.id === 'compound_by_smiles' && /\bsmiles\b/.test(query)) score += 120
  }

  if (entry.manifest.id === 'rest-json/reactome') {
    if (/\breactome\b|\bpathway\b/.test(query)) score += 150
    if (domain.id === 'query' && /\bR-[A-Z]{3}-\d+\b/i.test(queryText)) score += 200
    if (domain.id === 'search' && /\bsearch\b|\bfind\b|\bpathway\b/.test(query)) score += 40
  }

  if (entry.manifest.id === 'rest-json/chembl') {
    if (/\bchembl\b|\bbioactivit(?:y|ies)\b|\bic50\b|\bki\b/.test(query)) score += 170
    if (domain.id === 'molecule' && /\bCHEMBL\d+\b/i.test(queryText)) score += 200
    if (domain.id === 'target' && /\btarget\b|\bCHEMBL\d+\b/i.test(queryText)) score += 80
    if (domain.id === 'activity' && /\bactivity\b|\bic50\b|\bki\b|\bpchembl\b/.test(query)) {
      score += 100
    }
  }

  if (entry.manifest.id === 'rest-json/hpa') {
    if (/\bhpa\b|\bprotein\s+atlas\b|\btissue\s+expression\b|\bsubcellular\b/.test(query)) {
      score += 170
    }
    if (domain.id === 'gene' && /\bgene\b|\bexpression\b|\bensg\d+/i.test(query)) score += 50
    if (domain.id === 'search_pathology' && /\bpathology\b|\bcancer\b|\bprognostic\b/.test(query)) {
      score += 100
    }
  }

  if (entry.manifest.id === 'rest-json/gdc') {
    if (/\bgdc\b|\bgenomic\s+data\s+commons\b|\btcga\b/.test(query)) score += 170
    if (domain.id === 'projects' && /\bproject\b|\btcga-/.test(query)) score += 80
    if (domain.id === 'gene' && /\bensg\d+/i.test(queryText)) score += 160
    if (domain.id === 'files' && /\bfile\b|\bbam\b|\bvcf\b/.test(query)) score += 80
  }

  if (entry.manifest.id === 'sparql/wikipathways') {
    if (/\bwikipathways\b|\bwiki\s+pathways\b|\bpathway\b/.test(query)) score += 140
    if (domain.id === 'pathway_by_gene' && /\bgene\b|\bsymbol\b/.test(query)) score += 50
    if (domain.id === 'pathway' && /\bWP\d+\b/i.test(queryText)) score += 200
  }

  if (entry.manifest.id === 'ontology/go') {
    if (/\bgene\s+ontology\b|\bGO:\d+\b/i.test(queryText) || /\bgo\s+term\b|\bolo\b/.test(query)) {
      score += 160
    }
    if (/\bGO:\d+\b/i.test(queryText) && domain.id === 'term') score += 220
    if (domain.id === 'search' && /\bgo\s+term\b|\bontology\b|\benrichment\b/.test(query)) {
      score += 80
    }
  }

  if (entry.manifest.id === 'ontology/hpo') {
    if (
      /\bhpo\b|\bhuman\s+phenotype\b|\bHP:\d+\b/i.test(queryText) ||
      /\bphenotype\s+ontolog/.test(query)
    ) {
      score += 170
    }
    if (/\bHP:\d+\b/i.test(queryText) && domain.id === 'term') score += 220
  }

  if (entry.manifest.id === 'ontology/doid') {
    if (/\bdoid\b|\bdisease\s+ontology\b|\bDOID:\d+\b/i.test(queryText)) score += 170
    if (/\bDOID:\d+\b/i.test(queryText) && domain.id === 'term') score += 220
  }

  if (entry.manifest.id === 'ontology/mesh') {
    if (/\bmesh\b|\bmedical\s+subject\s+headings\b|\bMESH:[A-Z]?\d+\b/i.test(queryText)) {
      score += 170
    }
    if (domain.id === 'search' && /\bheading\b|\bmesh\b/.test(query)) score += 60
  }

  if (entry.manifest.id === 'rest-json/alphafold') {
    if (/\balphafold\b|\bpredicted\s+structure\b|\bplddt\b|\b3d-?beacons\b/.test(query)) {
      score += 180
    }
    if (domain.id === 'prediction' && uniprotAccessionFromText(queryText)) score += 120
    if (
      domain.id === 'structure_summary' &&
      /\bcoverage\b|\bexperimental\b|\b3d-?beacons\b/.test(query)
    ) {
      score += 100
    }
  }

  if (entry.manifest.id === 'rest-json/europepmc') {
    if (/\beurope\s*pmc\b|\bepmc\b|\bpreprint\b|\bliterature\b|\bpaper\b/.test(query)) score += 140
    if (domain.id === 'search') score += 40
    if (domain.id === 'citations' && /\bcit(?:ed|ations?)\b|\bciting\b/.test(query)) score += 100
    if (domain.id === 'references' && /\breferences?\b|\bbibliograph/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/mygene') {
    if (/\bmygene\b/.test(query)) score += 180
    if (domain.id === 'query' && /\bgene\b|\bsymbol\b/.test(query)) score += 50
    if (domain.id === 'gene' && /\bentrez\b|\bgene\s+id\b/.test(query)) score += 60
  }

  if (entry.manifest.id === 'rest-json/interpro') {
    if (
      /\binterpro\b|\bIPR\d+\b/i.test(queryText) ||
      /\bprotein\s+famil(?:y|ies)\b|\bdomain\s+annotation\b/.test(query)
    ) {
      score += 170
    }
    if (domain.id === 'entry' && /\bIPR\d+\b/i.test(queryText)) score += 200
    if (domain.id === 'protein' && uniprotAccessionFromText(queryText)) score += 100
  }

  if (entry.manifest.id === 'rest-json/kegg') {
    if (/\bkegg\b|\bec\s+\d+\.\d+\.\d+\.\d+\b/.test(query)) score += 180
    if (domain.id === 'find_genes' && /\bgene\b|\bsymbol\b/.test(query)) score += 50
    if (domain.id === 'pathway' && /\bpathway\b|\bmap\d+\b|\bhsa\d+\b/i.test(queryText)) {
      score += 80
    }
    if (domain.id === 'compound' && /\bcompound\b|\bC\d{5}\b/.test(queryText)) score += 100
    if (domain.id === 'enzyme' && /\benzyme\b|\b\d+\.\d+\.\d+\.\d+\b/.test(queryText)) score += 120
    if (domain.id === 'gene' && /\bhsa:\d+\b/i.test(queryText)) score += 200
  }

  if (entry.manifest.id === 'rest-json/opentargets') {
    if (/\bopen\s*targets?\b|\bdrug[- ]target\b|\btarget[- ]disease\b/.test(query)) score += 180
    if (domain.id === 'search') score += 40
    if (domain.id === 'target' && /\bensg\d+/i.test(queryText)) score += 160
    if (domain.id === 'disease' && /\bEFO[_:]?\d+\b/i.test(queryText)) score += 180
    if (domain.id === 'drug' && /\bCHEMBL\d+\b/i.test(queryText)) score += 180
    if (domain.id === 'associated_diseases' && /\bdisease\b|\bindication\b/.test(query)) score += 80
    if (domain.id === 'associated_targets' && /\btarget\b|\bgene\b/.test(query)) score += 80
    if (domain.id === 'evidence' && /\bevidence\b|\bdatasource\b/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/gnomad') {
    if (/\bgnomad\b|\ballele\s+frequency\b|\bpli\b|\bloeuf\b|\bconstraint\b/.test(query)) {
      score += 190
    }
    if (domain.id === 'variant' && /\b\d+-\d+-[ACGT]+-[ACGT]+\b/i.test(queryText)) score += 200
    if (domain.id === 'gene_constraint' && /\bconstraint\b|\bpli\b|\bgene\b/.test(query)) {
      score += 80
    }
    if (domain.id === 'region' && /\bregion\b|\blocus\b|\binterval\b/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/myvariant') {
    if (/\bmyvariant\b|\brs\d+\b|\bvariant\s+annotation\b|\bcadd\b/.test(query)) score += 170
    if (domain.id === 'query' && /\brs\d+\b/i.test(queryText)) score += 160
  }

  if (entry.manifest.id === 'rest-json/bindingdb') {
    if (/\bbindingdb\b|\bbinding\s+affinit|\bic50\b|\bki\b|\bkd\b/.test(query)) score += 170
    if (domain.id === 'ligands_by_uniprot' && uniprotAccessionFromText(queryText)) score += 120
  }

  if (entry.manifest.id === 'rest-json/gtex') {
    if (/\bgtex\b|\btissue\s+expression\b|\beqtl\b|\bmedian\s+tpm\b/.test(query)) score += 170
    if (domain.id === 'gene' && /\bgene\b|\bsymbol\b|\bensg\d+/i.test(query)) score += 50
    if (domain.id === 'median_expression' && /\bexpression\b|\btissue\b/.test(query)) score += 80
    if (domain.id === 'single_tissue_eqtl' && /\beqtl\b|\bsingle[- ]tissue\b/.test(query)) {
      score += 120
    }
    if (domain.id === 'multi_tissue_eqtl' && /\beqtl\b|\bmulti[- ]tissue\b/.test(query)) {
      score += 120
    }
  }

  if (entry.manifest.id === 'rest-json/gwas-catalog') {
    if (/\bgwas\b|\brs\d+\b|\btrait\s+association\b/.test(query)) score += 160
    if (domain.id === 'snp' && /\brs\d+\b/i.test(queryText)) score += 160
    if (domain.id === 'trait_search' && /\btrait\b|\befo\b/.test(query)) score += 80
  }

  if (entry.manifest.id === 'rest-json/omnipath') {
    if (
      /\bomnipath\b|\bsignor\b|\bsigned\s+signaling\b|\bdirected\s+interaction\b|\benz[- ]?sub\b|\bptm\b|\bintercell\b/.test(
        query
      )
    ) {
      score += 180
    }
    if (domain.id === 'interactions' && /\binteraction\b|\bnetwork\b/.test(query)) score += 60
    if (domain.id === 'signor' && /\bsignor\b|\bcausal\b/.test(query)) score += 120
    if (domain.id === 'enz_sub' && /\bphospho|\bptm\b|\benzyme[- ]substrate\b/.test(query)) {
      score += 120
    }
    if (domain.id === 'annotations' && /\bannotation\b|\bhpa_tissue\b/.test(query)) score += 80
    if (domain.id === 'intercell' && /\bligand\b|\breceptor\b|\bintercell\b/.test(query)) {
      score += 100
    }
  }

  if (entry.manifest.id === 'rest-json/biogrid') {
    if (/\bbiogrid\b|\bgenetic\s+interaction\b|\bphysical\s+interaction\b/.test(query)) score += 180
    if (domain.id === 'interactions') score += 40
  }

  if (entry.manifest.id === 'rest-json/monarch') {
    if (
      /\bmonarch\b|\bmondo\b|\bgene[- ]to[- ]phenotype\b|\bphenotype[- ]to[- ]gene\b/.test(query)
    ) {
      score += 180
    }
    if (domain.id === 'entity' && /\b(?:MONDO|HP|HGNC|NCBIGene):/i.test(queryText)) score += 200
    if (domain.id === 'associations' && /\bassociation\b|\bphenotype\b/.test(query)) score += 80
  }

  if (entry.manifest.id === 'rest-json/clinpgx') {
    if (/\bclinpgx\b|\bpharmgkb\b|\bcpic\b|\bpharmacogenomic|\bpGx\b/i.test(queryText)) {
      score += 190
    }
    if (domain.id === 'clinical_annotation' && /\bannotation\b|\blevel\s*1A\b/.test(query)) {
      score += 80
    }
    if (domain.id === 'guideline' && /\bguideline\b|\bcpic\b|\bdpwg\b/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/clinicaltrials') {
    if (/\bclinical\s*trials?\b|\bnct\d+\b|\brecruiting\b/.test(query)) score += 180
    if (domain.id === 'study' && /\bNCT\d+\b/i.test(queryText)) score += 200
    if (
      domain.id === 'studies' &&
      /\bphase\s*[1234]\b|\bcondition\b|\bintervention\b/.test(query)
    ) {
      score += 60
    }
  }

  if (entry.manifest.id === 'rest-json/openfda') {
    if (/\bopenfda\b|\bfaers\b|\bdrug\s+label\b|\badverse\s+event\b|\brecall\b/.test(query)) {
      score += 180
    }
    if (
      domain.id === 'drug_label_by_name' &&
      /\blabel\b|\bbrand\b|\bgeneric\b|\bdrug\b/.test(query)
    ) {
      score += 90
    }
    if (domain.id === 'drug_event_by_name' && /\badverse\b|\bfaers\b/.test(query)) score += 100
    if (domain.id === 'drug_label' && /\blabel\b|\bspl\b|\bindication\b/.test(query)) score += 40
    if (domain.id === 'drug_event' && /\badverse\b|\bfaers\b/.test(query)) score += 50
    if (domain.id === 'drug_enforcement' && /\brecall\b|\benforcement\b/.test(query)) score += 100
  }

  if (entry.manifest.id === 'rest-json/jaspar') {
    if (/\bjaspar\b|\bmotif\b|\btf\s+binding\b|\bpwm\b|\bpfm\b/.test(query)) score += 180
    if (domain.id === 'matrix' && /\bMA\d+\.\d+\b/i.test(queryText)) score += 200
  }

  if (entry.manifest.id === 'rest-json/zinc') {
    if (/\bzinc\b|\bpurchasable\b|\bsubstance\s+catalog\b/.test(query)) score += 170
    if (domain.id === 'substance' && /\bZINC\d+\b/i.test(queryText)) score += 200
  }

  if (entry.manifest.id === 'ontology/chebi') {
    if (/\bchebi\b|\bCHEBI:\d+\b/i.test(queryText) || /\bchemical\s+entities?\b/.test(query)) {
      score += 170
    }
    if (/\bCHEBI:\d+\b/i.test(queryText) && domain.id === 'term') score += 220
  }

  if (extractPrimaryDbQueryTerm(queryText)) {
    if (entry.manifest.id === 'entrez/ncbi' && domain.id === 'gene') score += 35
    if (entry.manifest.id === 'rest-json/ensembl' && domain.id === 'gene') score += 25
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'protein') score += 35
    if (entry.manifest.id === 'rest-json/uniprot' && domain.id === 'id_mapping') score += 25
    if (entry.manifest.id === 'sparql/uniprot' && domain.id === 'protein') score += 20
    if (entry.manifest.id === 'rest-json/cbioportal' && domain.id === 'gene') score += 20
    if (entry.manifest.id === 'rest-json/string' && domain.id === 'resolve') score += 20
    if (entry.manifest.id === 'rest-json/pubchem' && domain.id === 'compound_by_name') score += 25
    if (entry.manifest.id === 'rest-json/hpa' && domain.id === 'gene') score += 20
    if (entry.manifest.id === 'sparql/wikipathways' && domain.id === 'pathway_by_gene') score += 20
    if (entry.manifest.id === 'ontology/go' && domain.id === 'search') score += 20
    if (entry.manifest.id === 'ontology/hpo' && domain.id === 'search') score += 20
    if (entry.manifest.id === 'ontology/chebi' && domain.id === 'search') score += 20
    if (entry.manifest.id === 'rest-json/mygene' && domain.id === 'query') score += 25
    if (entry.manifest.id === 'rest-json/europepmc' && domain.id === 'search') score += 20
    if (entry.manifest.id === 'rest-json/kegg' && domain.id === 'find_genes') score += 20
    if (entry.manifest.id === 'rest-json/opentargets' && domain.id === 'search') score += 25
    if (entry.manifest.id === 'rest-json/gtex' && domain.id === 'gene') score += 20
    if (entry.manifest.id === 'rest-json/omnipath' && domain.id === 'interactions') score += 20
    if (entry.manifest.id === 'rest-json/biogrid' && domain.id === 'interactions') score += 20
    if (entry.manifest.id === 'rest-json/monarch' && domain.id === 'search') score += 25
    if (entry.manifest.id === 'rest-json/clinpgx' && domain.id === 'search') score += 20
    if (entry.manifest.id === 'rest-json/clinicaltrials' && domain.id === 'studies') score += 20
    if (entry.manifest.id === 'rest-json/jaspar' && domain.id === 'matrix_search') score += 20
    if (entry.manifest.id === 'rest-json/zinc' && domain.id === 'substance_search') score += 20
  }

  return score
}

/** The filters or rawQuery that look `queryText` up in one known domain. */
export function inferQueryPredicate(
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
  if (
    database === 'rest-json/ensembl' &&
    (domain === 'gene' || domain === 'xref' || domain === 'lookup_symbol')
  ) {
    if (domain === 'lookup_symbol') {
      return {
        filters: [
          { field: 'species', op: '=', value: 'homo_sapiens' },
          { field: 'symbol', op: '=', value: term }
        ]
      }
    }
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
  if (database === 'rest-json/ensembl' && domain === 'phenotype_gene') {
    return {
      filters: [
        { field: 'species', op: '=', value: 'homo_sapiens' },
        { field: 'gene', op: '=', value: ensemblStableIdFromText(queryText) ?? term }
      ]
    }
  }
  if (database === 'rest-json/uniprot' && domain === 'protein') {
    const accession = uniprotAccessionFromText(queryText)
    if (accession) return { filters: [{ field: 'accession', op: '=', value: accession }] }
    const filters: DbFilter[] = [{ field: 'gene_name', op: '=', value: term }]
    if (/\bhuman\b|\bhomo\s+sapiens\b|人类|人体/i.test(queryText)) {
      filters.push({ field: 'organism_id', op: '=', value: '9606' })
    }
    return { filters }
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
  if (database === 'rest-json/cbioportal' && domain === 'gene') {
    return { filters: [{ field: 'geneId', op: '=', value: term }] }
  }
  if (database === 'rest-json/cbioportal' && domain === 'study') {
    return { filters: [{ field: 'studyId', op: '=', value: term }] }
  }
  if (database === 'rest-json/pdbe' && domain === 'entry_summary') {
    const pdbId = queryText.match(/\b([0-9][A-Za-z0-9]{3})\b/)?.[1]?.toLowerCase()
    return { filters: [{ field: 'pdb_id', op: '=', value: pdbId ?? term }] }
  }
  if (database === 'rest-json/string' && (domain === 'resolve' || domain === 'network')) {
    const field = domain === 'resolve' ? 'identifier' : 'identifiers'
    const filters: DbFilter[] = [{ field, op: '=', value: term }]
    if (/\bhuman\b|\bhomo\s+sapiens\b|9606/i.test(queryText)) {
      filters.push({ field: 'species', op: '=', value: 9606 })
    }
    return { filters }
  }
  if (database === 'rest-json/pubchem' && domain === 'compound_by_name') {
    return { filters: [{ field: 'name', op: '=', value: term }] }
  }
  if (database === 'rest-json/pubchem' && domain === 'compound_by_cid') {
    const cid = queryText.match(/\b(?:cid\s*)?(\d{2,9})\b/i)?.[1] ?? term
    return { filters: [{ field: 'cid', op: '=', value: cid }] }
  }
  if (database === 'rest-json/reactome' && domain === 'query') {
    const stId = queryText.match(/\bR-[A-Z]{3}-\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'id', op: '=', value: stId }] }
  }
  if (database === 'rest-json/reactome' && domain === 'search') {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'rest-json/chembl' && domain === 'molecule') {
    const chemblId = queryText.match(/\bCHEMBL\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'chembl_id', op: '=', value: chemblId }] }
  }
  if (database === 'rest-json/chembl' && domain === 'target') {
    const chemblId = queryText.match(/\bCHEMBL\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'chembl_id', op: '=', value: chemblId }] }
  }
  if (
    database === 'rest-json/chembl' &&
    (domain === 'molecule_search' || domain === 'target_search')
  ) {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'rest-json/hpa' && domain === 'gene') {
    return { filters: [{ field: 'id', op: '=', value: term }] }
  }
  if (database === 'rest-json/hpa' && domain === 'search') {
    return { filters: [{ field: 'search', op: '=', value: term }] }
  }
  if (database === 'rest-json/gdc' && domain === 'gene') {
    const geneId = queryText.match(/\bENSG\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'gene_id', op: '=', value: geneId }] }
  }
  if (database === 'rest-json/gdc' && domain === 'project') {
    return { filters: [{ field: 'project_id', op: '=', value: term }] }
  }
  if (database === 'sparql/wikipathways' && domain === 'pathway_by_gene') {
    return { filters: [{ field: 'gene_symbol', op: '=', value: term }] }
  }
  if (database === 'sparql/wikipathways' && domain === 'pathway') {
    const pathwayId = queryText.match(/\bWP\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'pathway_id', op: '=', value: pathwayId }] }
  }
  if (
    (database === 'ontology/go' ||
      database === 'ontology/hpo' ||
      database === 'ontology/doid' ||
      database === 'ontology/mesh' ||
      database === 'ontology/chebi') &&
    (domain === 'term' || domain === 'children' || domain === 'parents' || domain === 'ancestors')
  ) {
    const ontologyId =
      queryText.match(/\b(?:GO|HP|DOID|MESH|CHEBI):[A-Z0-9]+\b/i)?.[0] ??
      queryText.match(/\b(?:GO|HP|DOID|CHEBI)_\d+\b/i)?.[0] ??
      term
    return { filters: [{ field: 'id', op: '=', value: ontologyId }] }
  }
  if (
    (database === 'ontology/go' ||
      database === 'ontology/hpo' ||
      database === 'ontology/doid' ||
      database === 'ontology/mesh' ||
      database === 'ontology/chebi') &&
    domain === 'search'
  ) {
    return { filters: [{ field: 'q', op: '=', value: term }] }
  }
  if (
    database === 'rest-json/alphafold' &&
    (domain === 'prediction' || domain === 'structure_summary')
  ) {
    return {
      filters: [
        {
          field: 'uniprotAccession',
          op: '=',
          value: uniprotAccessionFromText(queryText) ?? term
        }
      ]
    }
  }
  if (database === 'rest-json/europepmc' && domain === 'search') {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'rest-json/mygene' && domain === 'query') {
    return { rawQuery: term }
  }
  if (database === 'rest-json/mygene' && domain === 'gene') {
    return { filters: [{ field: 'geneId', op: '=', value: term }] }
  }
  if (database === 'rest-json/interpro' && domain === 'entry') {
    const accession = queryText.match(/\bIPR\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'accession', op: '=', value: accession }] }
  }
  if (database === 'rest-json/interpro' && domain === 'entry_search') {
    return { rawQuery: queryText.trim() }
  }
  if (database === 'rest-json/interpro' && domain === 'protein') {
    return {
      filters: [{ field: 'accession', op: '=', value: uniprotAccessionFromText(queryText) ?? term }]
    }
  }
  if (database === 'rest-json/kegg' && domain === 'find_genes') {
    return { filters: [{ field: 'query', op: '=', value: term }] }
  }
  if (database === 'rest-json/kegg' && domain === 'find_pathway') {
    return { filters: [{ field: 'query', op: '=', value: term }] }
  }
  if (database === 'rest-json/kegg' && domain === 'find_compound') {
    return { filters: [{ field: 'query', op: '=', value: term }] }
  }
  if (
    database === 'rest-json/kegg' &&
    (domain === 'gene' || domain === 'pathway' || domain === 'compound' || domain === 'enzyme')
  ) {
    const entry =
      queryText.match(/\b(?:hsa|eco|mmu|dre|ath):\d+\b/i)?.[0] ??
      queryText.match(/\b(?:map|ko|hsa|eco)\d+\b/i)?.[0] ??
      queryText.match(/\bC\d{5}\b/i)?.[0] ??
      queryText.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] ??
      term
    return { filters: [{ field: 'entry', op: '=', value: entry }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'search') {
    return { filters: [{ field: 'q', op: '=', value: term }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'target') {
    const ensemblId = queryText.match(/\bENSG\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'ensemblId', op: '=', value: ensemblId }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'disease') {
    const efoId = queryText.match(/\bEFO[_:]?\d+\b/i)?.[0]?.replace(':', '_') ?? term
    return { filters: [{ field: 'efoId', op: '=', value: efoId }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'associated_diseases') {
    const ensemblId = queryText.match(/\bENSG\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'ensemblId', op: '=', value: ensemblId }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'associated_targets') {
    const efoId = queryText.match(/\bEFO[_:]?\d+\b/i)?.[0]?.replace(':', '_') ?? term
    return { filters: [{ field: 'efoId', op: '=', value: efoId }] }
  }
  if (database === 'rest-json/opentargets' && domain === 'evidence') {
    const ensemblId = queryText.match(/\bENSG\d+\b/i)?.[0]
    const efoId = queryText.match(/\bEFO[_:]?\d+\b/i)?.[0]?.replace(':', '_')
    if (ensemblId && efoId) {
      return {
        filters: [
          { field: 'ensemblId', op: '=', value: ensemblId },
          { field: 'efoId', op: '=', value: efoId }
        ]
      }
    }
    return {}
  }
  if (database === 'rest-json/opentargets' && domain === 'drug') {
    const chemblId = queryText.match(/\bCHEMBL\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'chemblId', op: '=', value: chemblId }] }
  }
  if (database === 'rest-json/gnomad' && domain === 'variant') {
    const variantId = queryText.match(/\b\d{1,2}-[0-9]+-[ACGT]+-[ACGT]+\b/i)?.[0] ?? term
    return { filters: [{ field: 'variantId', op: '=', value: variantId }] }
  }
  if (database === 'rest-json/gnomad' && domain === 'gene_constraint') {
    return { filters: [{ field: 'gene_symbol', op: '=', value: term }] }
  }
  if (database === 'rest-json/gnomad' && domain === 'region') {
    const match = queryText.match(/\b(?:chr)?(\d{1,2}|X|Y)\s*[:-]\s*(\d+)\s*[-.]\s*(\d+)\b/i)
    if (match) {
      return {
        filters: [
          { field: 'chrom', op: '=', value: match[1] },
          { field: 'start', op: '=', value: Number(match[2]) },
          { field: 'stop', op: '=', value: Number(match[3]) }
        ]
      }
    }
    return {}
  }
  if (database === 'rest-json/myvariant' && domain === 'query') {
    return { rawQuery: term }
  }
  if (database === 'rest-json/myvariant' && domain === 'variant') {
    return { filters: [{ field: 'variantId', op: '=', value: term }] }
  }
  if (database === 'rest-json/bindingdb' && domain === 'ligands_by_uniprot') {
    const accession = uniprotAccessionFromText(queryText) ?? term
    const cutoff = queryText.match(/\b(\d{2,7})\s*nM\b/i)?.[1]
    const filters: DbFilter[] = [{ field: 'uniprot', op: '=', value: accession }]
    if (cutoff) filters.push({ field: 'cutoff', op: '=', value: Number(cutoff) })
    return { filters }
  }
  if (database === 'rest-json/bindingdb' && domain === 'targets_by_compound') {
    return { filters: [{ field: 'smiles', op: '=', value: term }] }
  }
  if (database === 'rest-json/gtex' && domain === 'gene') {
    return { filters: [{ field: 'geneId', op: '=', value: term }] }
  }
  if (
    database === 'rest-json/gtex' &&
    (domain === 'median_expression' ||
      domain === 'multi_tissue_eqtl' ||
      domain === 'single_tissue_eqtl')
  ) {
    const gencodeId = queryText.match(/\bENSG\d+(?:\.\d+)?\b/i)?.[0] ?? term
    const filters: DbFilter[] = [{ field: 'gencodeId', op: '=', value: gencodeId }]
    if (domain === 'single_tissue_eqtl') {
      const tissue = queryText.match(
        /\b(Whole_Blood|Liver|Lung|Brain_[A-Za-z0-9_]+|[A-Z][a-z]+(?:_[A-Za-z0-9]+)+)\b/
      )?.[1]
      if (tissue) filters.push({ field: 'tissueSiteDetailId', op: '=', value: tissue })
    }
    return { filters }
  }
  if (
    database === 'rest-json/gwas-catalog' &&
    (domain === 'snp' || domain === 'snp_associations')
  ) {
    const rsId = queryText.match(/\brs\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'rsId', op: '=', value: rsId }] }
  }
  if (database === 'rest-json/gwas-catalog' && domain === 'trait_search') {
    return { filters: [{ field: 'trait', op: '=', value: term }] }
  }
  if (database === 'rest-json/omnipath' && domain === 'interactions') {
    return { filters: [{ field: 'partners', op: '=', value: term }] }
  }
  if (database === 'rest-json/omnipath' && (domain === 'signor' || domain === 'enz_sub')) {
    return { filters: [{ field: 'partners', op: '=', value: term }] }
  }
  if (database === 'rest-json/omnipath' && (domain === 'annotations' || domain === 'intercell')) {
    return { filters: [{ field: 'proteins', op: '=', value: term }] }
  }
  if (
    database === 'rest-json/europepmc' &&
    (domain === 'citations' || domain === 'references' || domain === 'article')
  ) {
    const pmid = queryText.match(/\b\d{6,9}\b/)?.[0] ?? term
    return {
      filters: [
        { field: 'source', op: '=', value: 'MED' },
        { field: 'articleId', op: '=', value: pmid }
      ]
    }
  }
  if (database === 'rest-json/hpa' && domain === 'search_pathology') {
    return { filters: [{ field: 'search', op: '=', value: term }] }
  }
  if (database === 'rest-json/biogrid' && domain === 'interactions') {
    return {
      filters: [
        { field: 'geneList', op: '=', value: term },
        { field: 'taxId', op: '=', value: 9606 }
      ]
    }
  }
  if (database === 'rest-json/monarch' && domain === 'search') {
    return { rawQuery: term }
  }
  if (database === 'rest-json/monarch' && (domain === 'entity' || domain === 'associations')) {
    const curie = queryText.match(/\b(?:MONDO|HP|HGNC|NCBIGene|OMIM):[A-Z0-9]+\b/i)?.[0] ?? term
    return { filters: [{ field: 'id', op: '=', value: curie }] }
  }
  if (database === 'rest-json/clinpgx' && domain === 'search') {
    return { rawQuery: term }
  }
  if (database === 'rest-json/clinpgx' && domain === 'gene') {
    return { filters: [{ field: 'symbol', op: '=', value: term }] }
  }
  if (database === 'rest-json/clinpgx' && domain === 'drug') {
    return { filters: [{ field: 'name', op: '=', value: term }] }
  }
  if (database === 'rest-json/clinpgx' && domain === 'clinical_annotation') {
    const gene = queryText.match(/\b([A-Z0-9]{2,}(?:\d+[A-Z0-9]*)?)\b/)?.[1]
    const drugMatch = queryText.match(/\b(?:drug|for)\s+([A-Za-z][A-Za-z0-9-]*)/i)?.[1]
    const filters: DbFilter[] = []
    if (gene && !/^(GENE|DRUG|LEVEL|CPIC|PHARMGKB|CLINPGX)$/i.test(gene)) {
      filters.push({ field: 'gene', op: '=', value: gene })
    }
    if (drugMatch) filters.push({ field: 'drug', op: '=', value: drugMatch })
    return filters.length > 0 ? { filters } : { filters: [{ field: 'gene', op: '=', value: term }] }
  }
  if (database === 'rest-json/clinpgx' && domain === 'guideline') {
    return { filters: [{ field: 'gene', op: '=', value: term }] }
  }
  if (database === 'rest-json/clinicaltrials' && domain === 'studies') {
    const nct = queryText.match(/\bNCT\d+\b/i)?.[0]
    if (nct) return { filters: [{ field: 'id', op: '=', value: nct }] }
    return { filters: [{ field: 'cond', op: '=', value: term }] }
  }
  if (database === 'rest-json/clinicaltrials' && domain === 'study') {
    const nct = queryText.match(/\bNCT\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'nctId', op: '=', value: nct }] }
  }
  if (
    database === 'rest-json/openfda' &&
    (domain === 'drug_label' || domain === 'drug_event' || domain === 'drug_enforcement')
  ) {
    const field =
      domain === 'drug_label'
        ? 'openfda.generic_name'
        : domain === 'drug_event'
          ? 'patient.drug.openfda.generic_name'
          : 'openfda.generic_name'
    return { rawQuery: `${field}:"${term.replace(/"/g, '')}"` }
  }
  if (
    database === 'rest-json/openfda' &&
    (domain === 'drug_label_by_name' || domain === 'drug_event_by_name')
  ) {
    return { filters: [{ field: 'name', op: '=', value: sanitizeOpenFdaName(term) }] }
  }
  if (database === 'rest-json/jaspar' && domain === 'matrix_search') {
    return { filters: [{ field: 'name', op: '=', value: term }] }
  }
  if (database === 'rest-json/jaspar' && domain === 'matrix') {
    const matrixId = queryText.match(/\bMA\d+\.\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'matrix_id', op: '=', value: matrixId }] }
  }
  if (database === 'rest-json/zinc' && domain === 'substance') {
    const zincId = queryText.match(/\bZINC\d+\b/i)?.[0] ?? term
    return { filters: [{ field: 'zinc_id', op: '=', value: zincId }] }
  }
  if (database === 'rest-json/zinc' && domain === 'substance_search') {
    return { filters: [{ field: 'preferred_name', op: '=', value: term }] }
  }
  if (database === 'rest-json/zinc' && domain === 'subset') {
    const subset = queryText.match(/\b(fda|in-stock|metabolites)\b/i)?.[1]?.toLowerCase() ?? term
    return { filters: [{ field: 'subset', op: '=', value: subset }] }
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
  'PDB',
  'ALPHAFOLD',
  'STRUCTURE',
  'STRUCTURES',
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

/**
 * UniProt's accession format, with an optional isoform suffix: O/P/Q accessions (P04637,
 * Q9Y6K9), the other six-character ones (B7Z1M6) and the ten-character A0A024R161 form. The
 * letter required after the second character of the non-O/P/Q forms is what keeps a KEGG
 * compound such as C00031 from reading as a protein.
 */
export const UNIPROT_ACCESSION_PATTERN =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-\\d+)?'

const UNIPROT_ACCESSION_IN_TEXT = new RegExp(`\\b${UNIPROT_ACCESSION_PATTERN}\\b`)

export function uniprotAccessionFromText(value: string): string | undefined {
  return value.match(UNIPROT_ACCESSION_IN_TEXT)?.[0]
}

function sanitizeOpenFdaName(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
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
