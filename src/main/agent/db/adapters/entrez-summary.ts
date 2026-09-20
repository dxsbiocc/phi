import {
  bioProjectObjectivesFromSummary,
  bioProjectRelevanceFromSummary
} from './entrez-bioproject'
import {
  addGeoDownloadUrls,
  geoSamplesFromSummary,
  geoStringArray,
  parseGeoBoolean,
  prefixedGeoAccession
} from './entrez-geo'
import { firstSraTagText } from './entrez-sra'
import {
  aliasesFrom,
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

export function normalizeEntrezSummaryRow(
  uid: string,
  summary: Record<string, unknown>,
  domain: string
): Record<string, unknown> {
  const row: Record<string, unknown> = { uid }
  if (domain === 'gene') addGeneSummaryFields(row, summary)
  if (domain === 'pubmed') addPubmedSummaryFields(row, summary)
  if (domain === 'protein') addProteinSummaryFields(row, summary)
  if (domain === 'nucleotide') addNucleotideSummaryFields(row, summary)
  if (domain === 'biosample') addBioSampleSummaryFields(row, summary)
  if (domain === 'sra') addSraSummaryFields(row, summary)
  if (domain === 'geo') addGeoSummaryFields(row, summary)
  if (domain === 'bioproject') addBioProjectSummaryFields(row, summary)
  if (domain === 'taxonomy') addTaxonomySummaryFields(row, summary)
  if (domain === 'clinvar') addClinvarSummaryFields(row, summary)

  for (const [key, value] of Object.entries(summary)) {
    if (key === 'uid' || key === 'error') continue
    if (domain === 'sra' && (key === 'expxml' || key === 'runs')) continue
    if (row[key] === undefined) row[key] = value
  }
  return row
}

function addGeneSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const symbol = firstString(summary.name, summary.nomenclaturesymbol)
  if (symbol) row.symbol = symbol
  const description = firstString(summary.description, summary.summary)
  if (description) row.description = description
  const chromosome = firstString(summary.chromosome)
  if (chromosome) row.chromosome = chromosome
  const aliases = aliasesFrom(summary.otheraliases)
  if (aliases.length > 0) row.aliases = aliases
  const mapLocation = firstString(summary.maplocation)
  if (mapLocation) row.mapLocation = mapLocation
  if (isRecord(summary.organism)) {
    row.organism = {
      scientificName: summary.organism.scientificname,
      commonName: summary.organism.commonname,
      taxId: summary.organism.taxid
    }
  }
}

function addPubmedSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const pubdate = firstString(summary.pubdate, summary.epubdate)
  if (pubdate) row.pubdate = pubdate
  const journal = firstString(summary.fulljournalname, summary.source)
  if (journal) row.journal = journal
  const authors = authorNames(summary.authors)
  if (authors.length > 0) row.authors = authors
  const doi = articleId(summary.articleids, 'doi')
  if (doi) row.doi = doi
}

function addProteinSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accessionversion, summary.caption, summary.accession)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
}

function addNucleotideSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accessionversion, summary.caption, summary.accession)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
  const sequenceLength = parseOptionalNumber(summary.slen) ?? parseOptionalNumber(summary.length)
  if (sequenceLength !== undefined) row.sequence_length = sequenceLength
  const moleculeType = firstString(summary.moltype, summary.biomol)
  if (moleculeType) row.molecule_type = moleculeType
}

function addBioSampleSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.accession, summary.accessionversion, summary.caption)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.description)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname, summary.organism_name)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const sampleName = firstString(summary.samplename, summary.sample_name)
  if (sampleName) row.sample_name = sampleName
  const owner = firstString(summary.owner, summary.ownername, summary.owner_name)
  if (owner) row.owner = owner
  const packageName = firstString(summary.package, summary.package_name)
  if (packageName) row.package = packageName
  const model = firstString(summary.model)
  if (model) row.model = model
}

function addSraSummaryFields(row: Record<string, unknown>, summary: Record<string, unknown>): void {
  const accession = firstString(
    summary.accession,
    summary.experiment_accession,
    summary.run_accession,
    summary.study_accession,
    summary.caption
  )
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.exptitle, summary.studytitle)
  if (title) row.title = title
  const organism = firstString(summary.organism, summary.taxname)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const experimentAccession = firstString(summary.experiment_accession, summary.experiment)
  if (experimentAccession) row.experiment_accession = experimentAccession
  const studyAccession = firstString(summary.study_accession, summary.study)
  if (studyAccession) row.study_accession = studyAccession
  const sampleAccession = firstString(summary.sample_accession, summary.sample)
  if (sampleAccession) row.sample_accession = sampleAccession
  const biosampleAccession = firstString(summary.biosample_accession, summary.biosample)
  if (biosampleAccession) row.biosample_accession = biosampleAccession
  addSraEmbeddedSummaryFields(row, summary)
}

function addSraEmbeddedSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const expxml = firstString(summary.expxml)
  if (expxml) {
    const experimentTag = expxml.match(/<Experiment\b[^>]*>/i)?.[0] ?? ''
    const studyTag = expxml.match(/<Study\b[^>]*>/i)?.[0] ?? ''
    const sampleTag = expxml.match(/<Sample\b[^>]*>/i)?.[0] ?? ''
    const organismTag = expxml.match(/<Organism\b[^>]*>/i)?.[0] ?? ''
    const platformTag = expxml.match(/<Platform\b[^>]*>/i)?.[0] ?? ''
    const experimentAccession = xmlAttr(experimentTag, 'acc')
    const studyAccession = xmlAttr(studyTag, 'acc')
    const sampleAccession = xmlAttr(sampleTag, 'acc')
    if (experimentAccession) {
      if (!row.accession) row.accession = experimentAccession
      if (!row.experiment_accession) row.experiment_accession = experimentAccession
    }
    if (studyAccession && !row.study_accession) row.study_accession = studyAccession
    if (sampleAccession && !row.sample_accession) row.sample_accession = sampleAccession
    if (!row.biosample_accession) {
      const biosample = firstSraTagText(expxml, 'Biosample')
      if (biosample) row.biosample_accession = biosample
    }
    if (!row.bioproject_accession) {
      const bioproject = firstSraTagText(expxml, 'Bioproject')
      if (bioproject) row.bioproject_accession = bioproject
    }
    if (!row.title) {
      const title = firstSraTagText(expxml, 'Title')
      if (title) row.title = title
    }
    if (!row.organism) {
      const organism = xmlAttr(organismTag, 'ScientificName')
      if (organism) row.organism = organism
    }
    if (!row.tax_id) {
      const taxId = parseOptionalNumber(xmlAttr(organismTag, 'taxid'))
      if (taxId !== undefined) row.tax_id = taxId
    }
    if (!row.platform) {
      const platform = normalizeXmlText(
        expxml.match(/<Platform\b[^>]*>([\s\S]*?)<\/Platform>/i)?.[1] ?? ''
      )
      if (platform) row.platform = platform
    }
    if (!row.instrument_model) {
      const instrumentModel = xmlAttr(platformTag, 'instrument_model')
      if (instrumentModel) row.instrument_model = instrumentModel
    }
  }

  const runsXml = firstString(summary.runs)
  if (runsXml) {
    const runAccessions = uniqueStrings(
      [...runsXml.matchAll(/<Run\b[^>]*>/gi)]
        .map((match) => xmlAttr(match[0], 'acc'))
        .filter((value): value is string => value !== undefined)
    )
    if (runAccessions.length > 0) row.run_accessions = runAccessions
  }
  delete row.expxml
  delete row.runs
}

function addGeoSummaryFields(row: Record<string, unknown>, summary: Record<string, unknown>): void {
  const accession =
    firstString(summary.accession) ??
    prefixedGeoAccession('GSE', summary.gse) ??
    prefixedGeoAccession('GDS', summary.gds) ??
    prefixedGeoAccession('GPL', summary.gpl)
  if (accession) row.accession = accession
  const title = firstString(summary.title, summary.seriestitle, summary.platformtitle)
  if (title) row.title = title
  const summaryText = firstString(summary.summary)
  if (summaryText) row.summary = summaryText
  const organism = firstString(summary.taxon, summary.platformtaxa, summary.samplestaxa)
  if (organism) row.organism = organism
  const entryType = firstString(summary.entrytype)
  if (entryType) row.entry_type = entryType
  const gdsType = firstString(summary.gdstype, summary.ptechtype, summary.valtype)
  if (gdsType) row.gds_type = gdsType
  const seriesAccession = prefixedGeoAccession('GSE', summary.gse)
  if (seriesAccession) row.series_accession = seriesAccession
  const platformAccession = prefixedGeoAccession('GPL', summary.gpl)
  if (platformAccession) row.platform_accession = platformAccession
  const datasetAccession = prefixedGeoAccession('GDS', summary.gds)
  if (datasetAccession) row.dataset_accession = datasetAccession
  const samples = geoSamplesFromSummary(summary.samples)
  if (samples.length > 0) {
    row.samples = samples
    row.sample_accessions = uniqueStrings(
      samples.map((sample) => sample.accession).filter(Boolean) as string[]
    )
  }
  const sampleCount = parseOptionalNumber(summary.n_samples)
  if (sampleCount !== undefined) row.sample_count = sampleCount
  const pubmedIds = geoStringArray(summary.pubmedids)
  if (pubmedIds.length > 0) row.pubmed_ids = pubmedIds
  const bioproject = firstString(summary.bioproject)
  if (bioproject) row.bioproject_accession = bioproject
  const ftpLink = firstString(summary.ftplink)
  if (ftpLink) row.ftp_link = ftpLink
  const geo2rAvailable = parseGeoBoolean(summary.geo2r)
  if (geo2rAvailable !== undefined) row.geo2r_available = geo2rAvailable
  const publishedDate = firstString(summary.pdat)
  if (publishedDate) row.published_date = publishedDate
  addGeoDownloadUrls(row, seriesAccession ?? accession)
}

function addBioProjectSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const accession = firstString(summary.project_acc, summary.accession)
  if (accession) row.accession = accession
  const projectId = parseOptionalNumber(summary.project_id)
  if (projectId !== undefined) row.project_id = projectId
  const title = firstString(summary.project_title, summary.title)
  if (title) row.title = title
  const name = firstString(summary.project_name, summary.name)
  if (name) row.name = name
  const description = firstString(summary.project_description, summary.description)
  if (description) row.description = description
  const organism = firstString(summary.organism_name, summary.organism)
  if (organism) row.organism = organism
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(summary.tax_id)
  if (taxId !== undefined) row.tax_id = taxId
  const projectType = firstString(summary.project_type)
  if (projectType) row.project_type = projectType
  const dataType = firstString(summary.project_data_type)
  if (dataType) row.data_type = dataType
  const targetScope = firstString(summary.project_target_scope)
  if (targetScope) row.target_scope = targetScope
  const targetMaterial = firstString(summary.project_target_material)
  if (targetMaterial) row.target_material = targetMaterial
  const targetCapture = firstString(summary.project_target_capture)
  if (targetCapture) row.target_capture = targetCapture
  const methodType = firstString(summary.project_methodtype)
  if (methodType) row.method_type = methodType
  const objectives = bioProjectObjectivesFromSummary(summary.project_objectives_list)
  if (objectives.length > 0) row.objectives = objectives
  const relevance = bioProjectRelevanceFromSummary(summary)
  if (Object.keys(relevance).length > 0) row.relevance = relevance
  const submitterOrganization = firstString(
    summary.submitter_organization,
    Array.isArray(summary.submitter_organization_list)
      ? summary.submitter_organization_list[0]
      : undefined
  )
  if (submitterOrganization) row.submitter_organization = submitterOrganization
  const registrationDate = firstString(summary.registration_date)
  if (registrationDate) row.registration_date = registrationDate
  const supergroup = firstString(summary.supergroup)
  if (supergroup) row.supergroup = supergroup
  const sequencingStatus = firstString(summary.sequencing_status)
  if (sequencingStatus) row.sequencing_status = sequencingStatus
}

function addTaxonomySummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const scientificName = firstString(summary.scientificname, summary.scientific_name, summary.title)
  if (scientificName) row.scientific_name = scientificName
  const commonName = firstString(summary.commonname, summary.common_name)
  if (commonName) row.common_name = commonName
  const rank = firstString(summary.rank)
  if (rank) row.rank = rank
  const division = firstString(summary.division)
  if (division) row.division = division
  const lineage = firstString(summary.lineage)
  if (lineage) row.lineage = lineage
  const taxId = parseOptionalNumber(summary.taxid) ?? parseOptionalNumber(row.uid)
  if (taxId !== undefined) row.tax_id = taxId
  const parentTaxId =
    parseOptionalNumber(summary.parent_tax_id) ??
    parseOptionalNumber(summary.parenttaxid) ??
    parseOptionalNumber(summary.parentid)
  if (parentTaxId !== undefined) row.parent_tax_id = parentTaxId
}

function addClinvarSummaryFields(
  row: Record<string, unknown>,
  summary: Record<string, unknown>
): void {
  const title = firstString(summary.title)
  if (title) row.title = title
  const accession = firstString(summary.accession)
  if (accession) row.accession = accession
  const variationId = firstString(summary.variation_id, summary.variationid, summary.uid)
  if (variationId) row.variation_id = variationId
  const clinicalSignificance = firstString(
    summary.clinical_significance,
    summary.clinicalsignificance,
    isRecord(summary.clinical_significance) ? summary.clinical_significance.description : undefined
  )
  if (clinicalSignificance) row.clinical_significance = clinicalSignificance
  const gene = firstString(summary.gene, summary.genesymbol)
  if (gene) row.gene = gene
}

function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (isRecord(item)) return firstString(item.name)
      return undefined
    })
    .filter((item): item is string => item !== undefined)
}

function articleId(value: unknown, idType: string): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (!isRecord(item)) continue
    if (firstString(item.idtype)?.toLowerCase() === idType) return firstString(item.value, item.id)
  }
  return undefined
}
