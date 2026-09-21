import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
import { DB_STANDARD_RECORD_FIELDS } from './adapters/types'
import { ensemblNavigationMarkdown } from './ensembl-navigation'
import type { DbConnectorCatalogEntry, DbDomainManifest, DbFieldSchema } from './manifest-types'
import { getDbConnectorFieldGlossaryPath, getDbConnectorNavigatorSkillPath } from './store'

export interface GeneratedDbConnectorDocs {
  navigatorSkillMarkdown: string
  fieldGlossaryMarkdown: string
}

export interface WrittenDbConnectorDocs {
  navigatorSkillPath: string
  fieldGlossaryPath: string
}

interface CategorizedDomain {
  category: string
  database: string
  domain: string
  summary: string
}

export function buildGeneratedDbConnectorDocs(
  entries: DbConnectorCatalogEntry[],
  generatedAt: Date = new Date()
): GeneratedDbConnectorDocs {
  const sorted = sortedEntries(entries)
  return {
    navigatorSkillMarkdown: buildDbNavigatorSkillMarkdown(sorted, generatedAt),
    fieldGlossaryMarkdown: buildDbFieldGlossaryMarkdown(sorted, generatedAt)
  }
}

export function writeGeneratedDbConnectorDocs(
  entries: DbConnectorCatalogEntry[],
  agentDir = getPhiAgentDir(),
  generatedAt: Date = new Date()
): WrittenDbConnectorDocs {
  const docs = buildGeneratedDbConnectorDocs(entries, generatedAt)
  const navigatorSkillPath = getDbConnectorNavigatorSkillPath(agentDir)
  const fieldGlossaryPath = getDbConnectorFieldGlossaryPath(agentDir)
  writeTextFile(navigatorSkillPath, docs.navigatorSkillMarkdown)
  writeTextFile(fieldGlossaryPath, docs.fieldGlossaryMarkdown)
  return { navigatorSkillPath, fieldGlossaryPath }
}

export function buildDbNavigatorSkillMarkdown(
  entries: DbConnectorCatalogEntry[],
  generatedAt: Date = new Date()
): string {
  const sorted = sortedEntries(entries)
  const categorized = sorted.flatMap((entry) =>
    entry.manifest.domains.map((domain) => ({
      category: categoryForDomain(domain),
      database: entry.manifest.id,
      domain: domain.id,
      summary: domain.summary
    }))
  )
  const categories = groupCategorizedDomains(categorized)
  const useCases = sorted.flatMap(commonUseCasesForEntry)

  return [
    '---',
    'description: Navigate Phi DB connectors and choose db_* tools/domains. Does not execute database requests.',
    '---',
    '',
    '# DB Navigator',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    '',
    'Use this skill only to decide where to look. Actual database access must go through `db_search`, `db_domain`, `db_docs_search`, `db_query`, and `db_download`.',
    '',
    'When the user asks about NCBI Entrez, PubMed, ClinVar, Ensembl, UniProt, cBioPortal, PDBe, STRING, PubChem, Reactome, ChEMBL, Human Protein Atlas, GDC, WikiPathways, Gene Ontology, HPO, Disease Ontology, MeSH, AlphaFold, Europe PMC, MyGene, InterPro, KEGG, genes, variants, proteins, pathways, compounds, ontology terms, accessions, or biological database records, infer the database/domain yourself and route through `db_*` tools before falling back to general web search. Do not ask the user to name the tool function.',
    '',
    '## Database Category Index',
    '',
    '| Category | Sources | Notes |',
    '| --- | --- | --- |',
    ...(categories.length > 0
      ? categories.map(
          ({ category, sources, notes }) =>
            `| ${mdCell(category)} | ${mdCell(sources.join(', '))} | ${mdCell(notes.join('; '))} |`
        )
      : ['| General | - | No connectors installed. |']),
    '',
    '## Common Question Routing',
    '',
    ...(useCases.length > 0
      ? useCases
      : [
          '- Start with `db_search` to find a database, then inspect fields with `db_domain` or `db_docs_search` before calling `db_query`.'
        ]),
    '',
    '## Recommended Entity Query Paths',
    '',
    '- Gene symbol → `rest-json/mygene/query` or `rest-json/ensembl/gene`, then UniProt/HPA/GTEx as needed.',
    '- UniProt accession → `rest-json/uniprot/protein`; structures via `rest-json/alphafold/prediction` or `structure_summary`.',
    '- Variant (rsID / HGVS) → `rest-json/myvariant/query`, `rest-json/gnomad/variant`, or Ensembl `variation` / `vep_*`.',
    '- Drug name → `rest-json/openfda/drug_label_by_name`, `rest-json/chembl/molecule_search`, or `rest-json/clinpgx/drug`.',
    '- Disease / phenotype → `rest-json/opentargets/search`, `rest-json/monarch/search`, or ontology HPO/DOID.',
    '- Interactions → STRING network, OmniPath `interactions` / `signor` / `enz_sub`, or BioGRID (API key).',
    '- Literature → Entrez PubMed or Europe PMC `search`, then `citations` / `references`.',
    '',
    ...ensemblNavigationMarkdown(code),
    '## Guardrails',
    '',
    '- Do not make HTTP requests directly from this skill.',
    '- Check `enabledForQuery` before suggesting `db_query` for custom connectors.',
    '- Use `db_docs_search` for field names, synonyms, namespaces, and xref hints before guessing query fields.',
    '- Treat xref hints as candidates, not biological facts, until the target database confirms them.',
    ''
  ].join('\n')
}

export function buildDbFieldGlossaryMarkdown(
  entries: DbConnectorCatalogEntry[],
  generatedAt: Date = new Date()
): string {
  const sorted = sortedEntries(entries)
  const lines = [
    '# DB Connector Field Glossary',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    '',
    'This glossary is generated from installed DB connector manifests. It is documentation only; database access still goes through `db_*` tools.',
    '',
    `Every returned record includes source metadata when available: ${DB_STANDARD_RECORD_FIELDS.map(code).join(', ')}. Stable IDs and primary URLs are emitted only when the domain declares an explicit identity contract.`,
    ''
  ]

  if (sorted.length === 0) {
    lines.push('No DB connectors are installed.', '')
    return lines.join('\n')
  }

  for (const entry of sorted) {
    lines.push(
      `## ${entry.manifest.id} - ${entry.manifest.name}`,
      '',
      `Trust: ${entry.trustTier}; curation: ${entry.manifest.curationTier}; protocol: ${entry.manifest.protocolFamily}; query enabled: ${entry.enabledForQuery ? 'yes' : 'no'}.`,
      ''
    )
    for (const domain of entry.manifest.domains) {
      lines.push(
        `### ${domain.id}`,
        '',
        domain.summary,
        '',
        `Common fields: ${domain.commonFields.length ? domain.commonFields.map(code).join(', ') : '-'}`,
        '',
        domain.identity
          ? `Identity: ${domain.identity.stableIdFields.map(code).join(' -> ')}${domain.identity.namespace ? `; namespace ${code(domain.identity.namespace)}` : ''}${domain.identity.primaryUrlTemplate ? `; URL ${code(domain.identity.primaryUrlTemplate)}` : ''}`
          : 'Identity: not declared; no stable ID is inferred.',
        '',
        '| Field | Type | Namespace | Synonyms | Nullable | Common | Description |',
        '| --- | --- | --- | --- | --- | --- | --- |'
      )
      for (const field of fieldsForDomain(domain)) {
        lines.push(fieldGlossaryRow(domain, field))
      }
      lines.push('')
    }
    const xrefs = entry.manifest.xref ?? []
    if (xrefs.length > 0) {
      lines.push('### Xref Hints', '')
      for (const xref of xrefs) {
        const fromDatabase = xref.from.database ?? entry.manifest.id
        const toDatabase = xref.to.database ?? entry.manifest.id
        lines.push(
          `- ${code(`${fromDatabase}/${xref.from.domain}.${xref.from.field}`)}${xref.from.namespace ? ` (${code(xref.from.namespace)})` : ''}${xref.from.species ? ` species ${code(xref.from.species)}` : ''} -> ${code(`${toDatabase}/${xref.to.domain}.${xref.to.field}`)}${xref.to.namespace ? ` (${code(xref.to.namespace)})` : ''}${xref.to.species ? ` species ${code(xref.to.species)}` : ''}`
        )
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function sortedEntries(entries: DbConnectorCatalogEntry[]): DbConnectorCatalogEntry[] {
  return [...entries].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
}

function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf-8')
}

function groupCategorizedDomains(
  domains: CategorizedDomain[]
): Array<{ category: string; sources: string[]; notes: string[] }> {
  const grouped = new Map<string, { sources: Set<string>; notes: string[] }>()
  for (const domain of domains) {
    const group = grouped.get(domain.category) ?? { sources: new Set<string>(), notes: [] }
    group.sources.add(domain.database)
    group.notes.push(`${domain.database}/${domain.domain}: ${domain.summary}`)
    grouped.set(domain.category, group)
  }
  return Array.from(grouped.entries())
    .map(([category, value]) => ({
      category,
      sources: Array.from(value.sources).sort(),
      notes: value.notes.sort()
    }))
    .sort((left, right) => left.category.localeCompare(right.category))
}

function categoryForDomain(domain: DbDomainManifest): string {
  const haystack = `${domain.id} ${domain.summary}`.toLowerCase()
  if (haystack.match(/pubmed|literature|article|publication|abstract|europepmc|文献/)) {
    return 'Literature'
  }
  if (
    haystack.match(
      /clinvar|variant|variation|mutation|clinical|pathogenic|gnomad|myvariant|变异|临床/
    )
  ) {
    return 'Variation/Clinical'
  }
  if (
    haystack.match(
      /pathway|reactome|wikipathways|interaction|string|enrichment|kegg|omnipath|biogrid|通路|互作/
    )
  ) {
    return 'Pathway/Interaction'
  }
  if (
    haystack.match(
      /chembl|pubchem|compound|molecule|ligand|drug|bindingdb|opentargets|chebi|zinc|化合物|分子/
    )
  ) {
    return 'Compound/Drug'
  }
  if (
    haystack.match(
      /ontology|gene ontology|\bhpo\b|phenotype ontology|disease ontology|\bmesh\b|obo term|本体/
    )
  ) {
    return 'Ontology'
  }
  if (
    haystack.match(
      /clinicaltrials|clinpgx|pharmgkb|openfda|faers|monarch|pharmacogenomic|nct|召回|试验/
    )
  ) {
    return 'Variation/Clinical'
  }
  if (
    haystack.match(
      /cbioportal|gdc|cancer|tumor|molecular_profile|expression|hpa|atlas|gtex|gwas|肿瘤|表达/
    )
  ) {
    return 'Cancer/Expression'
  }
  if (haystack.match(/jaspar|motif|tf binding|pwm|pfm|转录因子/)) {
    return 'Sequence/Genome'
  }
  if (haystack.match(/protein|uniprot|pdb|structure|pdbe|alphafold|interpro|蛋白|结构/)) {
    return 'Protein/Structure'
  }
  if (haystack.match(/gene|genome|sequence|symbol|mygene|基因|序列/)) return 'Sequence/Genome'
  return 'General'
}

function commonUseCasesForEntry(entry: DbConnectorCatalogEntry): string[] {
  if (entry.manifest.curationTier !== 'curated') return []
  return entry.manifest.domains.flatMap((domain) => {
    const database = entry.manifest.id
    if (database === 'rest-json/ensembl' && domain.id === 'gene') {
      return [
        `- Ensembl gene by HGNC symbol -> use ${code('rest-json/ensembl/gene')}; for ENS* IDs use ${code('lookup_id')}, sequences ${code('sequence_id')}, variants ${code('variation')} / ${code('vep_id')} / ${code('vep_hgvs')}.`
      ]
    }
    if (database === 'rest-json/ensembl') {
      return []
    }
    if (domain.id === 'gene') {
      return [
        `- Gene symbols, aliases, location, or summary -> inspect ${code(`${database}/gene`)} with ${code('db_domain')}, then query with ${code('db_query')} using a gene field or raw Entrez term.`
      ]
    }
    if (domain.id === 'clinvar') {
      return [
        `- Clinical variant significance -> inspect ${code(`${database}/clinvar`)} and query ClinVar by gene, accession, or native raw term.`
      ]
    }
    if (domain.id === 'pubmed') {
      return [
        `- Literature metadata or abstracts -> inspect ${code(`${database}/pubmed`)}, then query PubMed through ${code('db_query')} for small metadata/abstract lookups.`
      ]
    }
    if (database === 'rest-json/uniprot' && domain.id === 'protein') {
      return [
        `- Ordinary UniProtKB protein lookup, accessions, sequences, Swiss-Prot status, GO/PDB/Ensembl cross-references -> use ${code('rest-json/uniprot/protein')} as the default UniProt route.`
      ]
    }
    if (database === 'sparql/uniprot' && domain.id === 'protein') {
      return [
        `- Advanced UniProt RDF graph joins or custom SPARQL-shaped questions -> use ${code('sparql/uniprot/protein')}; prefer ${code('rest-json/uniprot/protein')} for routine lookups.`
      ]
    }
    if (database === 'rest-json/cbioportal' && domain.id === 'gene') {
      return [
        `- Cancer genomics gene lookup in cBioPortal -> use ${code('rest-json/cbioportal/gene')}, then inspect studies or molecular profiles.`
      ]
    }
    if (database === 'rest-json/pdbe' && domain.id === 'entry_summary') {
      return [
        `- Protein structure metadata by PDB ID -> use ${code('rest-json/pdbe/entry_summary')}.`
      ]
    }
    if (database === 'rest-json/string' && domain.id === 'network') {
      return [
        `- Protein-protein interaction edges -> resolve identifiers with ${code('rest-json/string/resolve')}, then query ${code('rest-json/string/network')}.`
      ]
    }
    if (database === 'rest-json/pubchem' && domain.id === 'compound_by_name') {
      return [
        `- Small-molecule properties by chemical name -> use ${code('rest-json/pubchem/compound_by_name')}.`
      ]
    }
    if (database === 'rest-json/reactome' && domain.id === 'search') {
      return [
        `- Biological pathway search -> use ${code('rest-json/reactome/search')} or ${code('sparql/wikipathways/pathway_by_gene')}.`
      ]
    }
    if (database === 'rest-json/chembl' && domain.id === 'molecule_search') {
      return [
        `- Bioactive molecule or target lookup -> use ${code('rest-json/chembl/molecule_search')} / ${code('rest-json/chembl/target_search')}.`
      ]
    }
    if (database === 'rest-json/gdc' && domain.id === 'projects') {
      return [
        `- NCI GDC cancer project or file inventory -> use ${code('rest-json/gdc/projects')} / ${code('rest-json/gdc/files')}.`
      ]
    }
    if (database === 'sparql/wikipathways' && domain.id === 'pathway_by_gene') {
      return [
        `- Pathways containing a human gene symbol -> use ${code('sparql/wikipathways/pathway_by_gene')}.`
      ]
    }
    if (database === 'ontology/go' && domain.id === 'search') {
      return [
        `- Gene Ontology term lookup/search -> use ${code('ontology/go/search')} or ${code('ontology/go/term')}.`
      ]
    }
    if (database === 'ontology/hpo' && domain.id === 'search') {
      return [
        `- Human phenotype term lookup/search -> use ${code('ontology/hpo/search')} or ${code('ontology/hpo/term')}.`
      ]
    }
    if (database === 'rest-json/mygene' && domain.id === 'query') {
      return [
        `- Multi-source gene annotation lookup -> use ${code('rest-json/mygene/query')} or ${code('rest-json/mygene/gene')}.`
      ]
    }
    if (database === 'rest-json/opentargets' && domain.id === 'search') {
      return [
        `- Drug–target–disease associations -> search with ${code('rest-json/opentargets/search')}, then ${code('rest-json/opentargets/target')} / ${code('rest-json/opentargets/associated_diseases')} / ${code('rest-json/opentargets/evidence')}.`
      ]
    }
    if (database === 'rest-json/opentargets' && domain.id === 'associated_targets') {
      return [
        `- Disease → ranked targets -> use ${code('rest-json/opentargets/associated_targets')} with an EFO id.`
      ]
    }
    if (database === 'rest-json/gnomad' && domain.id === 'variant') {
      return [
        `- Population allele frequency, gene constraint, or region variants -> use ${code('rest-json/gnomad/variant')}, ${code('rest-json/gnomad/gene_constraint')}, or ${code('rest-json/gnomad/region')}.`
      ]
    }
    if (database === 'rest-json/myvariant' && domain.id === 'query') {
      return [
        `- Cached multi-source variant annotation (rsID) -> use ${code('rest-json/myvariant/query')}; confirm ClinVar/CADD at live sources when reporting.`
      ]
    }
    if (database === 'rest-json/bindingdb' && domain.id === 'ligands_by_uniprot') {
      return [
        `- Ligand binding affinities by UniProt target (optional nM cutoff filter) -> use ${code('rest-json/bindingdb/ligands_by_uniprot')}.`
      ]
    }
    if (database === 'rest-json/gtex' && domain.id === 'median_expression') {
      return [
        `- Human tissue expression (GTEx median TPM) -> resolve gene with ${code('rest-json/gtex/gene')}, then ${code('rest-json/gtex/median_expression')}.`
      ]
    }
    if (database === 'rest-json/gtex' && domain.id === 'multi_tissue_eqtl') {
      return [
        `- GTEx eQTLs -> use ${code('rest-json/gtex/multi_tissue_eqtl')} or ${code('rest-json/gtex/single_tissue_eqtl')} with a GENCODE id.`
      ]
    }
    if (database === 'rest-json/gwas-catalog' && domain.id === 'snp_associations') {
      return [
        `- GWAS trait associations for an rsID -> use ${code('rest-json/gwas-catalog/snp_associations')}.`
      ]
    }
    if (database === 'rest-json/omnipath' && domain.id === 'interactions') {
      return [
        `- Directed/signed interaction meta-network -> use ${code('rest-json/omnipath/interactions')}; SIGNOR-only via ${code('rest-json/omnipath/signor')}; PTMs via ${code('enz_sub')}; roles via ${code('intercell')}.`
      ]
    }
    if (database === 'rest-json/omnipath') {
      return []
    }
    if (database === 'rest-json/alphafold' && domain.id === 'prediction') {
      return [
        `- AlphaFold models by UniProt accession -> use ${code('rest-json/alphafold/prediction')}; broader experimental+AF coverage via ${code('structure_summary')}.`
      ]
    }
    if (database === 'rest-json/alphafold') {
      return []
    }
    if (database === 'rest-json/europepmc' && domain.id === 'search') {
      return [
        `- Literature search -> use ${code('rest-json/europepmc/search')}; citing/cited articles via ${code('citations')} / ${code('references')}.`
      ]
    }
    if (database === 'rest-json/europepmc') {
      return []
    }
    if (database === 'rest-json/openfda' && domain.id === 'drug_label_by_name') {
      return [
        `- FDA labels / FAERS by drug name -> prefer ${code('rest-json/openfda/drug_label_by_name')} or ${code('drug_event_by_name')}; advanced Lucene via ${code('drug_label')} (optional OPENFDA_API_KEY).`
      ]
    }
    if (database === 'rest-json/openfda') {
      return []
    }
    if (database === 'rest-json/hpa' && domain.id === 'gene') {
      return [
        `- Human protein/RNA tissue expression atlas -> use ${code('rest-json/hpa/gene')} or ${code('search')}; cancer pathology columns via ${code('search_pathology')}.`
      ]
    }
    if (database === 'rest-json/hpa') {
      return []
    }
    if (database === 'rest-json/biogrid' && domain.id === 'interactions') {
      return [
        `- Curated physical/genetic interactions -> configure BioGRID API key in Settings, then use ${code('rest-json/biogrid/interactions')}.`
      ]
    }
    if (database === 'rest-json/monarch' && domain.id === 'search') {
      return [
        `- Gene–phenotype–disease links -> search with ${code('rest-json/monarch/search')}, then ${code('rest-json/monarch/associations')}.`
      ]
    }
    if (database === 'rest-json/clinpgx' && domain.id === 'clinical_annotation') {
      return [
        `- Pharmacogenomics annotations / CPIC guidelines -> use ${code('rest-json/clinpgx/clinical_annotation')} or ${code('rest-json/clinpgx/guideline')}.`
      ]
    }
    if (database === 'rest-json/clinicaltrials' && domain.id === 'studies') {
      return [
        `- Clinical trial search by condition/intervention -> use ${code('rest-json/clinicaltrials/studies')} or ${code('rest-json/clinicaltrials/study')}.`
      ]
    }
    if (database === 'ontology/chebi' && domain.id === 'search') {
      return [
        `- Biological chemical entity lookup -> use ${code('ontology/chebi/search')} or ${code('ontology/chebi/term')}.`
      ]
    }
    if (database === 'rest-json/jaspar' && domain.id === 'matrix_search') {
      return [
        `- TF binding motifs (JASPAR) -> use ${code('rest-json/jaspar/matrix_search')} or ${code('rest-json/jaspar/matrix')}.`
      ]
    }
    if (database === 'rest-json/zinc' && domain.id === 'substance_search') {
      return [
        `- Purchasable / catalog compounds (ZINC) -> use ${code('rest-json/zinc/substance_search')} or ${code('rest-json/zinc/subset')}.`
      ]
    }
    if (database === 'rest-json/interpro' && domain.id === 'entry') {
      return [
        `- Protein family/domain annotation -> use ${code('rest-json/interpro/entry')} or ${code('rest-json/interpro/protein')}.`
      ]
    }
    if (database === 'rest-json/kegg' && domain.id === 'find_genes') {
      return [
        `- KEGG gene/pathway/compound lookup -> use ${code('rest-json/kegg/find_genes')}, ${code('rest-json/kegg/pathway')}, or ${code('rest-json/kegg/compound')}; flat-file entries are parsed into structured fields.`
      ]
    }
    return []
  })
}

function fieldsForDomain(domain: DbDomainManifest): DbFieldSchema[] {
  const fields = domain.fields ?? []
  const byName = new Map(fields.map((field) => [field.name, field]))
  const missingCommonFields = domain.commonFields
    .filter((field) => !byName.has(field))
    .map((field): DbFieldSchema => ({ name: field, type: 'string' }))
  return [...fields, ...missingCommonFields]
}

function fieldGlossaryRow(domain: DbDomainManifest, field: DbFieldSchema): string {
  const common = domain.commonFields.includes(field.name)
  return [
    mdCell(field.name),
    mdCell(field.type),
    mdCell(field.namespace),
    mdCell(field.synonyms?.join(', ')),
    mdCell(field.nullable === undefined ? undefined : String(field.nullable)),
    mdCell(common ? 'yes' : 'no'),
    mdCell(field.description ?? `${field.name} is listed as a common field for ${domain.id}.`)
  ].join(' | ')
}

function mdCell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function code(value: string): string {
  return `\`${value}\``
}
