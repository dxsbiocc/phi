import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getPhiAgentDir } from '../runtime-paths'
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
    'Use this skill only to decide where to look. Actual database access must go through `db_search`, `db_domain`, `db_docs_search`, and `db_query`.',
    '',
    'When the user asks about NCBI Entrez, PubMed, ClinVar, Ensembl, UniProt, genes, variants, proteins, accessions, or biological database records, infer the database/domain yourself and route through `db_*` tools before falling back to general web search. Do not ask the user to name the tool function.',
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
  if (haystack.match(/pubmed|literature|article|publication|abstract|文献/)) return 'Literature'
  if (haystack.match(/clinvar|variant|variation|mutation|clinical|pathogenic|变异|临床/)) {
    return 'Variation/Clinical'
  }
  if (haystack.match(/protein|uniprot|pdb|structure|蛋白|结构/)) return 'Protein/Structure'
  if (haystack.match(/gene|genome|sequence|symbol|基因|序列/)) return 'Sequence/Genome'
  return 'General'
}

function commonUseCasesForEntry(entry: DbConnectorCatalogEntry): string[] {
  if (entry.manifest.curationTier !== 'curated') return []
  return entry.manifest.domains.flatMap((domain) => {
    const database = entry.manifest.id
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
