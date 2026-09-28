import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import { getPhiAgentDir } from '../runtime-paths'
import { findDbConnectorCatalogEntry } from './catalog'
import type { DbConnectorCatalogEntry, DbFilter } from './manifest-types'
import { inferQueryPredicate, UNIPROT_ACCESSION_PATTERN } from './tool-query-resolution'

/**
 * Exact identifiers (accessions, stable ids, ontology terms) name their database by their
 * shape. `db_resolve` maps such an identifier to the connector and domain that hold it and
 * hands back the arguments to give `db_query`, so routing is a lookup, not a recollection.
 * Names, sentences and bare numbers are never guessed at; those go through `db_search`.
 */

interface RouteTarget {
  database: string
  domain: string
  /** The same shape can name different kinds of record; this is one reading of it. */
  ambiguous?: true
}

interface IdentifierKind {
  kind: string
  pattern: RegExp
  /** How the identifier is written to the database; defaults to upper case. */
  normalize?: (id: string) => string
  targets: RouteTarget[]
}

const upper = (id: string): string => id.toUpperCase()
const lower = (id: string): string => id.toLowerCase()

// Longest-prefix-first is not needed: the patterns are anchored and do not overlap, except
// that the UniProt accession is checked after the prefixed accessions it could resemble.
const IDENTIFIER_KINDS: IdentifierKind[] = [
  {
    kind: 'geo',
    pattern: /^(?:GSE|GSM|GPL|GDS)\d+$/i,
    targets: [{ database: 'entrez/ncbi', domain: 'geo' }]
  },
  {
    kind: 'sra',
    pattern: /^(?:SRR|SRX|SRP|SRS|SRA|ERR|ERX|ERP|ERS|DRR|DRX|DRP|DRS)\d+$/i,
    targets: [{ database: 'entrez/ncbi', domain: 'sra' }]
  },
  {
    kind: 'bioproject',
    pattern: /^PRJ(?:NA|EB|DB)\d+$/i,
    targets: [{ database: 'entrez/ncbi', domain: 'bioproject' }]
  },
  {
    kind: 'biosample',
    pattern: /^SAM(?:N|EA|D)\d+$/i,
    targets: [{ database: 'entrez/ncbi', domain: 'biosample' }]
  },
  {
    kind: 'clinvar',
    pattern: /^(?:VCV|RCV|SCV)\d+$/i,
    targets: [{ database: 'entrez/ncbi', domain: 'clinvar' }]
  },
  {
    kind: 'ensembl_stable_id',
    pattern: /^ENS[A-Z]{0,6}[GTPER]\d{11}(?:\.\d+)?$/i,
    targets: [{ database: 'rest-json/ensembl', domain: 'lookup_id' }]
  },
  {
    kind: 'rsid',
    pattern: /^rs\d+$/i,
    normalize: lower,
    targets: [
      { database: 'rest-json/ensembl', domain: 'variation' },
      { database: 'rest-json/gwas-catalog', domain: 'snp' }
    ]
  },
  {
    kind: 'chembl_id',
    pattern: /^CHEMBL\d+$/i,
    targets: [
      { database: 'rest-json/chembl', domain: 'molecule', ambiguous: true },
      { database: 'rest-json/chembl', domain: 'target', ambiguous: true }
    ]
  },
  {
    kind: 'go_term',
    pattern: /^GO:\d{7}$/i,
    targets: [{ database: 'ontology/go', domain: 'term' }]
  },
  {
    kind: 'hpo_term',
    pattern: /^HP:\d{7}$/i,
    targets: [{ database: 'ontology/hpo', domain: 'term' }]
  },
  {
    kind: 'doid_term',
    pattern: /^DOID:\d+$/i,
    targets: [{ database: 'ontology/doid', domain: 'term' }]
  },
  {
    kind: 'chebi_term',
    pattern: /^CHEBI:\d+$/i,
    targets: [{ database: 'ontology/chebi', domain: 'term' }]
  },
  {
    kind: 'mesh_term',
    pattern: /^MESH:[A-Z0-9]+$/i,
    targets: [{ database: 'ontology/mesh', domain: 'term' }]
  },
  {
    kind: 'clinical_trial',
    pattern: /^NCT\d{8}$/i,
    targets: [{ database: 'rest-json/clinicaltrials', domain: 'study' }]
  },
  {
    kind: 'reactome',
    pattern: /^R-[A-Z]{3}-\d+$/i,
    targets: [{ database: 'rest-json/reactome', domain: 'query' }]
  },
  {
    kind: 'interpro',
    pattern: /^IPR\d{6}$/i,
    targets: [{ database: 'rest-json/interpro', domain: 'entry' }]
  },
  {
    kind: 'wikipathways',
    pattern: /^WP\d+$/i,
    targets: [{ database: 'sparql/wikipathways', domain: 'pathway' }]
  },
  {
    kind: 'kegg_gene',
    pattern: /^(?:hsa|mmu|eco|dre|ath):\d+$/i,
    normalize: lower,
    targets: [{ database: 'rest-json/kegg', domain: 'gene' }]
  },
  {
    kind: 'kegg_compound',
    pattern: /^C\d{5}$/i,
    targets: [{ database: 'rest-json/kegg', domain: 'compound' }]
  },
  {
    kind: 'kegg_pathway',
    pattern: /^(?:map|ko|hsa)\d{5}$/i,
    normalize: lower,
    targets: [{ database: 'rest-json/kegg', domain: 'pathway' }]
  },
  {
    kind: 'uniprot_accession',
    pattern: new RegExp(`^${UNIPROT_ACCESSION_PATTERN}$`, 'i'),
    targets: [{ database: 'rest-json/uniprot', domain: 'protein' }]
  },
  {
    // Four characters starting with a digit and containing a letter: a PDB id, or occasionally not.
    kind: 'pdb_id',
    pattern: /^(?=[^A-Za-z]*[A-Za-z])[1-9][A-Za-z0-9]{3}$/,
    normalize: lower,
    targets: [{ database: 'rest-json/pdbe', domain: 'entry_summary', ambiguous: true }]
  }
]

export interface DbResolveQuery {
  database: string
  domain: string
  filters?: DbFilter[]
  rawQuery?: string
}

export interface DbResolveMatch {
  kind: string
  database: string
  domain: string
  ambiguous?: true
  /** Arguments for `db_query`. Absent when `unavailable` says why the route cannot be used. */
  query?: DbResolveQuery
  unavailable?: string
}

export interface DbResolveResult {
  /** The identifier as it will be sent to the database. */
  id: string
  recognized: boolean
  matches: DbResolveMatch[]
}

function cleanIdentifier(input: string): string {
  return input
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
}

function unavailableReason(
  entry: DbConnectorCatalogEntry | undefined,
  domain: string
): string | undefined {
  if (!entry) return 'connector not installed'
  if (!entry.enabledForQuery) return 'connector not enabled for query'
  if (!entry.manifest.domains.some((candidate) => candidate.id === domain)) {
    return `connector has no ${domain} domain`
  }
  return undefined
}

function buildMatch(
  kind: string,
  target: RouteTarget,
  id: string,
  findEntry: (database: string) => DbConnectorCatalogEntry | undefined
): DbResolveMatch {
  const base = {
    kind,
    database: target.database,
    domain: target.domain,
    ...(target.ambiguous ? { ambiguous: true as const } : {})
  }
  const entry = findEntry(target.database)
  const unavailable = unavailableReason(entry, target.domain)
  if (unavailable) return { ...base, unavailable }

  const predicate = inferQueryPredicate(target.database, target.domain, id)
  if (!predicate.filters && !predicate.rawQuery) {
    return { ...base, unavailable: 'no query is defined for this identifier in that domain' }
  }
  return { ...base, query: { database: target.database, domain: target.domain, ...predicate } }
}

export function resolveDbIdentifier(
  input: string,
  catalog: readonly DbConnectorCatalogEntry[]
): DbResolveResult {
  return resolveDbIdentifierUsing(input, (database) =>
    catalog.find((candidate) => candidate.manifest.id === database)
  )
}

function resolveDbIdentifierUsing(
  input: string,
  findEntry: (database: string) => DbConnectorCatalogEntry | undefined
): DbResolveResult {
  const cleaned = cleanIdentifier(input)
  const kind = cleaned
    ? IDENTIFIER_KINDS.find((candidate) => candidate.pattern.test(cleaned))
    : undefined
  if (!kind) return { id: cleaned, recognized: false, matches: [] }

  const id = (kind.normalize ?? upper)(cleaned)
  return {
    id,
    recognized: true,
    matches: kind.targets.map((target) => buildMatch(kind.kind, target, id, findEntry))
  }
}

const SUPPORTED_KINDS = IDENTIFIER_KINDS.map((candidate) => candidate.kind).join(', ')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildDbResolveTool(
  agentDir: string = getPhiAgentDir(),
  onResolved?: (database: string, domain: string) => void
): CustomTool {
  return {
    name: 'db_resolve',
    label: 'Resolve Database Identifier',
    description:
      'Map one exact identifier (an accession, stable id or ontology term such as GSE12345, SRR1234567, P04637, ENSG00000141510, rs334, GO:0006915, CHEMBL25) to the database and domain that hold it, with ready-to-use db_query arguments. Use it before db_query whenever the task gives an exact identifier. It does not resolve gene names, protein names or free text: use db_search for those.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'One identifier, exactly as given, for example "GSE12345".'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      const id = isRecord(params) && typeof params.id === 'string' ? params.id.trim() : ''
      if (!id) {
        return { content: [{ type: 'text', text: '缺少必填参数: id' }], isError: true }
      }
      const result = resolveDbIdentifierUsing(id, (database) =>
        findDbConnectorCatalogEntry(database, agentDir)
      )
      for (const match of result.matches) {
        if (match.query && !match.unavailable) onResolved?.(match.database, match.domain)
      }
      const text = result.recognized
        ? JSON.stringify({ id: result.id, matches: result.matches })
        : `"${result.id}" 不是可识别的标识符格式（可识别: ${SUPPORTED_KINDS}）。基因名、蛋白名或自由文本请用 db_search 查找数据库。`
      return {
        content: [{ type: 'text', text }],
        details: { kind: 'db_resolve_result', ...result }
      }
    }
  }
}
