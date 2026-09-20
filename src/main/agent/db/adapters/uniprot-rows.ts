import type { DbDownloadFileCandidate } from '../manifest-types'
import {
  compactRecord,
  firstNestedString,
  isRecord,
  nestedArray,
  nestedRecord,
  nonEmptyRecord,
  numberValue,
  stringValue,
  uniqueStrings
} from './uniprot-utils'

export interface UniProtIdMappingResults {
  results?: unknown[]
  failedIds?: unknown[]
}

export function uniprotKbRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const accession = stringValue(entry.primaryAccession)
  const sequence = nestedRecord(entry, 'sequence')
  const organism = nestedRecord(entry, 'organism')
  const entryAudit = nestedRecord(entry, 'entryAudit')
  const proteinName = firstNestedString(entry, [
    'proteinDescription',
    'recommendedName',
    'fullName',
    'value'
  ])
  const geneName = firstNestedString(nestedArray(entry, 'genes')[0], ['geneName', 'value'])
  const row: Record<string, unknown> = {
    accession,
    entry_name: stringValue(entry.uniProtkbId),
    reviewed: entry.entryType === 'UniProtKB reviewed (Swiss-Prot)',
    protein_name: proteinName,
    alternative_protein_names: alternativeProteinNames(entry),
    protein_existence: stringValue(entry.proteinExistence),
    gene_name: geneName,
    gene_synonyms: geneValues(entry, 'synonyms'),
    ordered_locus_names: geneValues(entry, 'orderedLocusNames'),
    orf_names: geneValues(entry, 'orfNames'),
    organism: stringValue(organism?.scientificName),
    tax_id: numberValue(organism?.taxonId),
    organism_lineage: stringArray(organism?.lineage),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    annotation_score: numberValue(entry.annotationScore),
    secondary_accessions: stringArray(entry.secondaryAccessions),
    date_created: stringValue(entryAudit?.firstPublicDate),
    date_modified: stringValue(entryAudit?.lastAnnotationUpdateDate),
    date_sequence_modified: stringValue(entryAudit?.lastSequenceUpdateDate),
    entry_version: numberValue(entryAudit?.entryVersion),
    sequence_version: numberValue(entryAudit?.sequenceVersion),
    pubmed_ids: pubmedIds(entry),
    references: literatureReferences(entry),
    function: functionComments(entry),
    disease_comments: commentTexts(entry, 'DISEASE'),
    subcellular_locations: subcellularLocations(entry),
    catalytic_activities: catalyticActivities(entry),
    cofactors: cofactors(entry),
    pathways: commentTexts(entry, 'PATHWAY'),
    interactions: interactions(entry),
    isoforms: isoforms(entry, accession),
    isoform_ids: isoformIds(entry),
    ec_numbers: ecNumbers(entry),
    keywords: keywordNames(entry),
    domains: featureAnnotations(entry, ['Domain']),
    regions: featureAnnotations(entry, ['Region']),
    active_sites: featureAnnotations(entry, ['Active site']),
    binding_sites: featureAnnotations(entry, ['Binding site']),
    modified_residues: featureAnnotations(entry, ['Modified residue']),
    variants: featureAnnotations(entry, ['Natural variant']),
    signal_peptides: featureAnnotations(entry, ['Signal peptide']),
    transmembrane_regions: featureAnnotations(entry, ['Transmembrane']),
    topological_domains: featureAnnotations(entry, ['Topological domain']),
    chains: featureAnnotations(entry, ['Chain']),
    peptides: featureAnnotations(entry, ['Peptide']),
    propeptides: featureAnnotations(entry, ['Propeptide']),
    repeats: featureAnnotations(entry, ['Repeat']),
    motifs: featureAnnotations(entry, ['Motif']),
    coiled_coils: featureAnnotations(entry, ['Coiled coil']),
    zinc_fingers: featureAnnotations(entry, ['Zinc finger']),
    disulfide_bonds: featureAnnotations(entry, ['Disulfide bond']),
    mutagenesis_sites: featureAnnotations(entry, ['Mutagenesis']),
    go_terms: crossReferenceIds(entry, 'GO'),
    pdb_ids: crossReferenceIds(entry, 'PDB'),
    ensembl_gene_ids: crossReferenceIds(entry, 'Ensembl'),
    refseq_ids: crossReferenceIds(entry, 'RefSeq'),
    gene_ids: crossReferenceIds(entry, 'GeneID'),
    embl_ids: crossReferenceIds(entry, 'EMBL'),
    uniparc_ids: crossReferenceIds(entry, 'UniParc'),
    ccds_ids: crossReferenceIds(entry, 'CCDS'),
    alphafold_ids: crossReferenceIds(entry, 'AlphaFoldDB'),
    interpro_ids: crossReferenceIds(entry, 'InterPro'),
    pfam_ids: crossReferenceIds(entry, 'Pfam'),
    prosite_ids: crossReferenceIds(entry, 'PROSITE'),
    smart_ids: crossReferenceIds(entry, 'SMART'),
    supfam_ids: crossReferenceIds(entry, 'SUPFAM'),
    string_ids: crossReferenceIds(entry, 'STRING'),
    reactome_ids: crossReferenceIds(entry, 'Reactome'),
    kegg_ids: crossReferenceIds(entry, 'KEGG'),
    chembl_ids: crossReferenceIds(entry, 'ChEMBL'),
    drugbank_ids: crossReferenceIds(entry, 'DrugBank'),
    proteome_ids: crossReferenceIds(entry, 'Proteomes'),
    ...(accession
      ? {
          url: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
          download_urls: uniprotKbDownloadUrls(accession),
          download_files: uniprotKbDownloadFiles(accession)
        }
      : {})
  }
  return compactRecord(row)
}

export function unirefRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const commonTaxon = nestedRecord(entry, 'commonTaxon')
  const representative = nestedRecord(entry, 'representativeMember')
  const sequence = nestedRecord(representative, 'sequence')
  return compactRecord({
    id: stringValue(entry.id),
    name: stringValue(entry.name),
    entry_type: stringValue(entry.entryType),
    updated: stringValue(entry.updated),
    common_taxon: stringValue(commonTaxon?.scientificName),
    tax_id: numberValue(commonTaxon?.taxonId),
    member_count: numberValue(entry.memberCount),
    organism_count: numberValue(entry.organismCount),
    representative_member_id: stringValue(representative?.memberId),
    representative_member_type: stringValue(representative?.memberIdType),
    representative_protein_name: stringValue(representative?.proteinName),
    representative_organism: stringValue(representative?.organismName),
    representative_tax_id: numberValue(representative?.organismTaxId),
    representative_accessions: stringArray(representative?.accessions),
    uniref90_id: stringValue(representative?.uniref90Id),
    uniref100_id: stringValue(representative?.uniref100Id),
    uniparc_id: stringValue(representative?.uniparcId),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    crc64: stringValue(sequence?.crc64),
    md5: stringValue(sequence?.md5),
    seed_id: stringValue(entry.seedId),
    member_id_types: stringArray(entry.memberIdTypes),
    members: stringArray(entry.members),
    organisms: organismRows(nestedArray(entry, 'organisms')),
    go_terms: nestedArray(entry, 'goTerms')
      .map((term) =>
        isRecord(term)
          ? compactRecord({
              go_id: stringValue(term.goId),
              aspect: stringValue(term.aspect)
            })
          : {}
      )
      .filter(nonEmptyRecord),
    url: stringValue(entry.id)
      ? `https://www.uniprot.org/uniref/${encodeURIComponent(String(entry.id))}`
      : undefined
  })
}

export function uniparcRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const sequence = nestedRecord(entry, 'sequence')
  return compactRecord({
    uniparc_id: stringValue(entry.uniParcId),
    cross_reference_count: numberValue(entry.crossReferenceCount),
    uniprotkb_accessions: stringArray(entry.uniProtKBAccessions),
    common_taxons: nestedArray(entry, 'commonTaxons')
      .map((taxon) =>
        isRecord(taxon)
          ? compactRecord({
              top_level: stringValue(taxon.topLevel),
              common_taxon: stringValue(taxon.commonTaxon),
              tax_id: numberValue(taxon.commonTaxonId)
            })
          : {}
      )
      .filter(nonEmptyRecord),
    sequence: stringValue(sequence?.value),
    sequence_length: numberValue(sequence?.length),
    molecular_weight: numberValue(sequence?.molWeight),
    crc64: stringValue(sequence?.crc64),
    md5: stringValue(sequence?.md5),
    sequence_features: nestedArray(entry, 'sequenceFeatures')
      .map(sequenceFeatureRow)
      .filter(nonEmptyRecord),
    oldest_cross_ref_created: stringValue(entry.oldestCrossRefCreated),
    most_recent_cross_ref_updated: stringValue(entry.mostRecentCrossRefUpdated),
    url: stringValue(entry.uniParcId)
      ? `https://www.uniprot.org/uniparc/${encodeURIComponent(String(entry.uniParcId))}`
      : undefined
  })
}

export function proteomeRow(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {}
  const taxonomy = nestedRecord(entry, 'taxonomy')
  const assembly = nestedRecord(entry, 'genomeAssembly')
  const annotation = nestedRecord(entry, 'genomeAnnotation')
  const statistics = nestedRecord(entry, 'proteomeStatistics')
  return compactRecord({
    id: stringValue(entry.id),
    description: stringValue(entry.description),
    organism: stringValue(taxonomy?.scientificName),
    common_name: stringValue(taxonomy?.commonName),
    tax_id: numberValue(taxonomy?.taxonId),
    mnemonic: stringValue(taxonomy?.mnemonic),
    modified: stringValue(entry.modified),
    proteome_type: stringValue(entry.proteomeType),
    superkingdom: stringValue(entry.superkingdom),
    gene_count: numberValue(entry.geneCount),
    protein_count: numberValue(entry.proteinCount),
    annotation_score: numberValue(entry.annotationScore),
    reviewed_protein_count: numberValue(statistics?.reviewedProteinCount),
    unreviewed_protein_count: numberValue(statistics?.unreviewedProteinCount),
    isoform_protein_count: numberValue(statistics?.isoformProteinCount),
    genome_assembly: compactRecord({
      assembly_id: stringValue(assembly?.assemblyId),
      url: stringValue(assembly?.genomeAssemblyUrl),
      level: stringValue(assembly?.level),
      source: stringValue(assembly?.source)
    }),
    genome_annotation: compactRecord({
      source: stringValue(annotation?.source),
      url: stringValue(annotation?.url)
    }),
    component_count: nestedArray(entry, 'components').length,
    components: nestedArray(entry, 'components').slice(0, 50).map(proteomeComponentRow),
    pubmed_ids: nestedArray(entry, 'citations').flatMap((citation) =>
      isRecord(citation) ? citationCrossReferenceIds(citation, 'PubMed') : []
    ),
    url: stringValue(entry.id)
      ? `https://www.uniprot.org/proteomes/${encodeURIComponent(String(entry.id))}`
      : undefined
  })
}

export function idMappingRows(
  payload: UniProtIdMappingResults,
  context: { jobId: string; fromDb: string; toDb: string }
): Record<string, unknown>[] {
  const rows = Array.isArray(payload.results) ? payload.results : []
  const mapped = rows.filter(isRecord).map((result) => {
    const target = result.to
    const targetId = typeof target === 'string' ? target : firstTargetId(target)
    return compactRecord({
      job_id: context.jobId,
      from_db: context.fromDb,
      to_db: context.toDb,
      from: stringValue(result.from),
      to: targetId,
      target: isRecord(target) ? target : undefined,
      failed: false
    })
  })
  const failed = nestedArray(payload, 'failedIds')
    .map((failedId) =>
      compactRecord({
        job_id: context.jobId,
        from_db: context.fromDb,
        to_db: context.toDb,
        from: typeof failedId === 'string' ? failedId : firstTargetId(failedId),
        failed: true,
        failure: isRecord(failedId) ? failedId : undefined
      })
    )
    .filter(nonEmptyRecord)
  return [...mapped, ...failed]
}

function organismRows(values: unknown[]): Array<Record<string, unknown>> {
  return values
    .map((organism) =>
      isRecord(organism)
        ? compactRecord({
            scientific_name: stringValue(organism.scientificName),
            common_name: stringValue(organism.commonName),
            tax_id: numberValue(organism.taxonId)
          })
        : {}
    )
    .filter(nonEmptyRecord)
}

function sequenceFeatureRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const interpro = nestedRecord(value, 'interproGroup')
  return compactRecord({
    database: stringValue(value.database),
    database_id: stringValue(value.databaseId),
    interpro_id: stringValue(interpro?.id),
    interpro_name: stringValue(interpro?.name),
    locations: nestedArray(value, 'locations')
      .map((location) =>
        isRecord(location)
          ? compactRecord({
              start: numberValue(location.start),
              end: numberValue(location.end),
              alignment: stringValue(location.alignment)
            })
          : {}
      )
      .filter(nonEmptyRecord)
  })
}

function proteomeComponentRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const annotation = nestedRecord(value, 'genomeAnnotation')
  return compactRecord({
    name: stringValue(value.name),
    protein_count: numberValue(value.proteinCount),
    genome_annotation_source: stringValue(annotation?.source),
    genome_accessions: nestedArray(value, 'proteomeCrossReferences')
      .filter((xref): xref is Record<string, unknown> => isRecord(xref))
      .map((xref) => stringValue(xref.id))
      .filter((id): id is string => Boolean(id))
  })
}

function uniprotKbDownloadUrls(accession: string): Record<string, string> {
  return {
    entry: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
    json: `https://rest.uniprot.org/uniprotkb/${accession}.json`,
    fasta: `https://rest.uniprot.org/uniprotkb/${accession}.fasta`,
    txt: `https://rest.uniprot.org/uniprotkb/${accession}.txt`
  }
}

function uniprotKbDownloadFiles(accession: string): DbDownloadFileCandidate[] {
  const urls = uniprotKbDownloadUrls(accession)
  return [
    {
      kind: 'uniprot_json',
      accession,
      label: 'UniProtKB JSON record',
      url: urls.json,
      format: 'json',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    },
    {
      kind: 'uniprot_fasta',
      accession,
      label: 'UniProtKB FASTA sequence',
      url: urls.fasta,
      format: 'fasta',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    },
    {
      kind: 'uniprot_txt',
      accession,
      label: 'UniProtKB flat-file record',
      url: urls.txt,
      format: 'txt',
      availability: 'direct_url',
      source: 'derived_from_uniprot_accession'
    }
  ]
}

function firstTargetId(target: unknown): string | undefined {
  if (!isRecord(target)) return undefined
  return (
    stringValue(target.primaryAccession) ??
    stringValue(target.uniProtkbId) ??
    stringValue(target.id) ??
    stringValue(target.name)
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((item) => (typeof item === 'string' ? item : undefined)))
    : []
}

function functionComments(entry: Record<string, unknown>): string[] {
  return commentTexts(entry, 'FUNCTION')
}

function commentTexts(entry: Record<string, unknown>, commentType: string): string[] {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === commentType
    })
    .flatMap((comment) =>
      nestedArray(comment, 'texts').map((text) => firstNestedString(text, ['value']))
    )
    .filter((value): value is string => Boolean(value))
}

function subcellularLocations(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'comments')
      .filter((comment): comment is Record<string, unknown> => {
        return isRecord(comment) && comment.commentType === 'SUBCELLULAR LOCATION'
      })
      .flatMap((comment) => nestedArray(comment, 'subcellularLocations'))
      .map((location) => firstNestedString(location, ['location', 'value']))
  )
}

function pubmedIds(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'references').flatMap((reference) => {
      const citation = nestedRecord(reference, 'citation')
      return citation ? citationCrossReferenceIds(citation, 'PubMed') : []
    })
  )
}

function literatureReferences(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'references')
    .map((reference) => {
      const citation = nestedRecord(reference, 'citation')
      if (!citation) return {}
      return compactRecord({
        title: stringValue(citation.title),
        citation_type: stringValue(citation.citationType),
        journal: stringValue(citation.journal),
        publication_date: stringValue(citation.publicationDate),
        volume: stringValue(citation.volume),
        first_page: stringValue(citation.firstPage),
        last_page: stringValue(citation.lastPage),
        pubmed_id: citationCrossReferenceIds(citation, 'PubMed')[0],
        doi: citationCrossReferenceIds(citation, 'DOI')[0]
      })
    })
    .filter(nonEmptyRecord)
}

function citationCrossReferenceIds(citation: Record<string, unknown>, database: string): string[] {
  return uniqueStrings(
    nestedArray(citation, 'citationCrossReferences')
      .filter((xref): xref is Record<string, unknown> => {
        return (
          isRecord(xref) && stringValue(xref.database)?.toLowerCase() === database.toLowerCase()
        )
      })
      .map((xref) => stringValue(xref.id))
  )
}

function catalyticActivities(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'CATALYTIC ACTIVITY'
    })
    .map((comment) => {
      const reaction = nestedRecord(comment, 'reaction')
      return compactRecord({
        reaction: stringValue(reaction?.name),
        ec_number: stringValue(reaction?.ecNumber),
        reaction_cross_references: reactionCrossReferences(reaction),
        notes: nestedArray(comment, 'texts')
          .map((text) => firstNestedString(text, ['value']))
          .filter((value): value is string => Boolean(value))
      })
    })
    .filter(nonEmptyRecord)
}

function reactionCrossReferences(
  reaction: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  if (!reaction) return []
  return nestedArray(reaction, 'reactionCrossReferences')
    .map((xref) =>
      isRecord(xref)
        ? compactRecord({
            database: stringValue(xref.database),
            id: stringValue(xref.id)
          })
        : {}
    )
    .filter(nonEmptyRecord)
}

function cofactors(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'COFACTOR'
    })
    .flatMap((comment) => {
      const notes = nestedArray(comment, 'texts')
        .map((text) => firstNestedString(text, ['value']))
        .filter((value): value is string => Boolean(value))
      const rows = nestedArray(comment, 'cofactors')
        .map((cofactor) => {
          const xref = nestedRecord(cofactor, 'cofactorCrossReference')
          return isRecord(cofactor)
            ? compactRecord({
                name: stringValue(cofactor.name),
                database: stringValue(xref?.database),
                id: stringValue(xref?.id),
                notes
              })
            : {}
        })
        .filter(nonEmptyRecord)
      return rows.length > 0 ? rows : notes.map((note) => ({ notes: [note] }))
    })
}

function interactions(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'INTERACTION'
    })
    .flatMap((comment) =>
      nestedArray(comment, 'interactions').map((interaction) => {
        if (!isRecord(interaction)) return {}
        return compactRecord({
          interactant_one: interactant(interaction.interactantOne),
          interactant_two: interactant(interaction.interactantTwo),
          experiments: numberValue(interaction.numberOfExperiments)
        })
      })
    )
    .filter(nonEmptyRecord)
}

function isoforms(
  entry: Record<string, unknown>,
  primaryAccession: string | undefined
): Array<Record<string, unknown>> {
  return nestedArray(entry, 'comments')
    .filter((comment): comment is Record<string, unknown> => {
      return isRecord(comment) && comment.commentType === 'ALTERNATIVE PRODUCTS'
    })
    .flatMap((comment) =>
      nestedArray(comment, 'isoforms').map((isoform) => {
        if (!isRecord(isoform)) return {}
        const ids = isoformIdValues(isoform)
        return compactRecord({
          ids,
          name: firstNestedString(isoform, ['name', 'value']),
          sequence_status: stringValue(isoform.sequenceStatus),
          sequence_ids: isoformSequenceIds(isoform),
          note: isoformNote(isoform),
          urls: isoformUrls(primaryAccession, ids)
        })
      })
    )
    .filter(nonEmptyRecord)
}

function isoformIds(entry: Record<string, unknown>): string[] {
  return uniqueStrings(isoforms(entry, undefined).flatMap((isoform) => stringArray(isoform.ids)))
}

function isoformIdValues(isoform: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(isoform, 'isoformIds').flatMap((item) => [
      typeof item === 'string' ? item : undefined,
      firstNestedString(item, ['value'])
    ])
  )
}

function isoformSequenceIds(isoform: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(isoform, 'sequenceIds').flatMap((item) => [
      typeof item === 'string' ? item : undefined,
      firstNestedString(item, ['value'])
    ])
  )
}

function isoformNote(isoform: Record<string, unknown>): string | undefined {
  return (
    firstNestedString(isoform, ['note', 'value']) ??
    firstNestedString(nestedArray(isoform, 'synonyms')[0], ['value'])
  )
}

function isoformUrls(
  primaryAccession: string | undefined,
  isoformIds: string[]
): Record<string, string> | undefined {
  if (!primaryAccession || isoformIds.length === 0) return undefined
  return Object.fromEntries(
    isoformIds.map((id) => [id, `https://rest.uniprot.org/uniprotkb/${id}.fasta`])
  )
}

function interactant(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const row = compactRecord({
    accession: stringValue(value.uniProtKBAccession) ?? stringValue(value.accession),
    id: stringValue(value.intActId) ?? stringValue(value.id),
    gene_name: stringValue(value.geneName),
    organism: stringValue(value.organismName)
  })
  return Object.keys(row).length > 0 ? row : undefined
}

function ecNumbers(entry: Record<string, unknown>): string[] {
  const recommended = nestedRecord(nestedRecord(entry, 'proteinDescription'), 'recommendedName')
  const alternatives = nestedArray(nestedRecord(entry, 'proteinDescription'), 'alternativeNames')
  const names = [recommended, ...alternatives].filter(isRecord)
  return uniqueStrings(
    names.flatMap((name) =>
      nestedArray(name, 'ecNumbers').map((ecNumber) => firstNestedString(ecNumber, ['value']))
    )
  )
}

function alternativeProteinNames(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(nestedRecord(entry, 'proteinDescription'), 'alternativeNames').flatMap((name) => [
      firstNestedString(name, ['fullName', 'value']),
      ...nestedArray(name, 'shortNames').map((shortName) => firstNestedString(shortName, ['value']))
    ])
  )
}

function geneValues(entry: Record<string, unknown>, key: string): string[] {
  return uniqueStrings(
    nestedArray(entry, 'genes').flatMap((gene) =>
      nestedArray(gene, key).map((item) => firstNestedString(item, ['value']))
    )
  )
}

function keywordNames(entry: Record<string, unknown>): string[] {
  return uniqueStrings(
    nestedArray(entry, 'keywords').map((keyword) => {
      if (typeof keyword === 'string') return keyword
      return firstNestedString(keyword, ['name']) ?? firstNestedString(keyword, ['id'])
    })
  )
}

function featureAnnotations(
  entry: Record<string, unknown>,
  types: string[]
): Array<Record<string, unknown>> {
  const wanted = new Set(types.map((type) => type.toLowerCase()))
  return nestedArray(entry, 'features')
    .filter((feature): feature is Record<string, unknown> => {
      const type = stringValue(isRecord(feature) ? feature.type : undefined)
      return Boolean(type && wanted.has(type.toLowerCase()))
    })
    .map(featureAnnotation)
    .filter(nonEmptyRecord)
}

function featureAnnotation(feature: Record<string, unknown>): Record<string, unknown> {
  const location = nestedRecord(feature, 'location')
  return compactRecord({
    type: stringValue(feature.type),
    description: stringValue(feature.description),
    feature_id: stringValue(feature.featureId),
    start: featurePosition(nestedRecord(location, 'start')),
    end: featurePosition(nestedRecord(location, 'end'))
  })
}

function featurePosition(position: Record<string, unknown> | undefined): number | undefined {
  const value = position?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function crossReferenceIds(entry: Record<string, unknown>, database: string): string[] {
  return uniqueStrings(
    nestedArray(entry, 'uniProtKBCrossReferences')
      .filter((xref): xref is Record<string, unknown> => {
        return isRecord(xref) && xref.database === database
      })
      .map((xref) => stringValue(xref.id))
  )
}
