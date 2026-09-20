import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { EntrezAdapter } from '../src/main/agent/db/adapters/entrez-adapter'
import { RestJsonAdapter } from '../src/main/agent/db/adapters/rest-json-adapter'
import { UniProtAdapter } from '../src/main/agent/db/adapters/uniprot-adapter'
import { parseDbConnectorManifest } from '../src/main/agent/db/manifest'
import type { DbConnectorManifest } from '../src/main/agent/db/manifest-types'

const liveMode = process.env.PHI_DB_LIVE_TESTS
const liveSkip =
  liveMode === '1' || liveMode === 'smoke' || liveMode === 'expanded'
    ? false
    : 'set PHI_DB_LIVE_TESTS=1'
const expandedSkip =
  liveMode === 'expanded' ? false : 'set PHI_DB_LIVE_TESTS=expanded for extended API coverage'

function bundledManifest(path: string): DbConnectorManifest {
  const parsed = parseDbConnectorManifest(readFileSync(path, 'utf-8'))
  assert.equal(parsed.valid, true, parsed.errors.join('\n'))
  assert.ok(parsed.manifest)
  return parsed.manifest
}

test(
  'live DB connectors query official NCBI and UniProt APIs',
  { skip: liveSkip, timeout: 60_000 },
  async () => {
    const ncbi = new EntrezAdapter(
      bundledManifest('resources/db-connectors/entrez/ncbi/connector.yaml'),
      { timeoutMs: 20_000 }
    )
    const uniprot = new UniProtAdapter(
      bundledManifest('resources/db-connectors/rest-json/uniprot/connector.yaml'),
      { timeoutMs: 20_000 }
    )

    const ncbiPubmed = await ncbi.query({
      domain: 'pubmed',
      rawQuery: '7545954[uid]',
      fields: ['uid', 'title', 'journal', 'abstract'],
      limit: 1
    })
    assert.equal(ncbiPubmed.provenance.database, 'entrez/ncbi')
    assert.equal(ncbiPubmed.rows.length, 1)
    assert.equal(ncbiPubmed.rows[0]?.uid, '7545954')
    assert.equal(ncbiPubmed.rows[0]?.stable_id, '7545954')
    assert.equal(ncbiPubmed.rows[0]?.stable_id_namespace, 'pubmed.pmid')
    assert.equal(ncbiPubmed.rows[0]?.primary_url, 'https://pubmed.ncbi.nlm.nih.gov/7545954/')
    assert.match(String(ncbiPubmed.rows[0]?.title ?? ''), /BRCA1/i)
    assert.match(String(ncbiPubmed.rows[0]?.journal ?? ''), /Science/i)

    const uniprotKb = await uniprot.query({
      domain: 'protein',
      filters: [{ field: 'accession', op: '=', value: 'P38398' }],
      fields: ['accession', 'entry_name', 'gene_name', 'sequence_length', 'fasta'],
      limit: 1
    })
    assert.equal(uniprotKb.provenance.database, 'rest-json/uniprot')
    assert.equal(uniprotKb.rows[0]?.accession, 'P38398')
    assert.equal(uniprotKb.rows[0]?.stable_id, 'P38398')
    assert.equal(uniprotKb.rows[0]?.stable_id_namespace, 'uniprot.accession')
    assert.equal(uniprotKb.rows[0]?.entry_name, 'BRCA1_HUMAN')
    assert.equal(uniprotKb.rows[0]?.gene_name, 'BRCA1')
    assert.equal(uniprotKb.rows[0]?.sequence_length, 1863)
    assert.match(String(uniprotKb.rows[0]?.fasta ?? ''), /^>sp\|P38398\|BRCA1_HUMAN/m)

    const uniref = await uniprot.query({
      domain: 'uniref',
      rawQuery: 'UniRef50_P38398',
      fields: ['id', 'representative_member_id', 'representative_accessions', 'sequence_length'],
      limit: 1
    })
    assert.equal(uniref.rows[0]?.id, 'UniRef50_P38398')
    assert.equal(typeof uniref.rows[0]?.representative_member_id, 'string')
    assert.equal((uniref.rows[0]?.representative_accessions as string[]).includes('P38398'), true)
    assert.equal(Number(uniref.rows[0]?.sequence_length) > 0, true)

    const uniparc = await uniprot.query({
      domain: 'uniparc',
      rawQuery: 'P38398',
      fields: ['uniparc_id', 'uniprotkb_accessions', 'sequence_length'],
      limit: 1
    })
    assert.match(String(uniparc.rows[0]?.uniparc_id ?? ''), /^UPI/)
    assert.equal(Array.isArray(uniparc.rows[0]?.uniprotkb_accessions), true)
    assert.equal((uniparc.rows[0]?.uniprotkb_accessions as string[]).includes('P38398'), true)
    assert.equal(Number(uniparc.rows[0]?.sequence_length) > 0, true)

    const proteome = await uniprot.query({
      domain: 'proteome',
      rawQuery: 'UP000005640',
      fields: ['id', 'organism', 'tax_id', 'protein_count'],
      limit: 1
    })
    assert.equal(proteome.rows[0]?.id, 'UP000005640')
    assert.equal(proteome.rows[0]?.organism, 'Homo sapiens')
    assert.equal(proteome.rows[0]?.tax_id, 9606)
    assert.equal(Number(proteome.rows[0]?.protein_count) > 0, true)
  }
)

test(
  'live DB connector queries official Ensembl REST API families',
  { skip: liveSkip, timeout: 240_000 },
  async () => {
    const ensembl = new RestJsonAdapter(
      bundledManifest('resources/db-connectors/rest-json/ensembl/connector.yaml'),
      { timeoutMs: 60_000 }
    )

    const ensemblXref = await ensembl.query({
      domain: 'xref_id',
      filters: [{ field: 'id', op: '=', value: 'ENSG00000012048' }],
      fields: ['dbname', 'display_id', 'primary_id'],
      limit: 20
    })
    assert.equal(ensemblXref.provenance.database, 'rest-json/ensembl')
    assert.equal(
      ensemblXref.rows.some((row) => row.display_id === 'BRCA1' || row.primary_id === 'BRCA1'),
      true
    )

    const ensemblPing = await ensembl.query({
      domain: 'info_ping',
      fields: ['ping'],
      limit: 1
    })
    assert.equal(ensemblPing.rows[0]?.ping, 1)

    const ensemblTaxonomy = await ensembl.query({
      domain: 'taxonomy_id',
      filters: [{ field: 'id', op: '=', value: '9606' }],
      fields: ['id', 'scientific_name'],
      limit: 5
    })
    assert.equal(
      ensemblTaxonomy.rows.some((row) => row.id === 9606 || row.id === '9606'),
      true
    )
    assert.equal(
      ensemblTaxonomy.rows.some(
        (row) => row.stable_id === '9606' && row.stable_id_namespace === 'ncbi.taxonomy_id'
      ),
      true
    )
  }
)

test(
  'expanded live DB coverage exercises SRA, GEO, UniProt mapping, and Ensembl variants',
  { skip: expandedSkip, timeout: 300_000 },
  async () => {
    const ncbi = new EntrezAdapter(
      bundledManifest('resources/db-connectors/entrez/ncbi/connector.yaml'),
      { timeoutMs: 30_000 }
    )
    const uniprot = new UniProtAdapter(
      bundledManifest('resources/db-connectors/rest-json/uniprot/connector.yaml'),
      { timeoutMs: 30_000 }
    )
    const ensembl = new RestJsonAdapter(
      bundledManifest('resources/db-connectors/rest-json/ensembl/connector.yaml'),
      { timeoutMs: 60_000 }
    )

    const sra = await ncbi.query({ domain: 'sra', rawQuery: 'SRX000001', limit: 1 })
    assert.equal(sra.rows.length, 1)
    assert.equal(sra.rows[0]?.experiment_accession, 'SRX000001')
    assert.equal(Array.isArray(sra.rows[0]?.run_accessions), true)
    assert.equal(Array.isArray(sra.rows[0]?.download_files), true)

    const geo = await ncbi.query({ domain: 'geo', rawQuery: 'GSE2553', limit: 1 })
    assert.equal(geo.rows.length, 1)
    assert.equal(geo.rows[0]?.series_accession, 'GSE2553')
    assert.match(String(geo.rows[0]?.ftp_link ?? ''), /GSE2553/)
    assert.equal(Array.isArray(geo.rows[0]?.download_files), true)

    const mapping = await uniprot.query({
      domain: 'id_mapping',
      filters: [
        { field: 'from', op: '=', value: 'UniProtKB_AC-ID' },
        { field: 'to', op: '=', value: 'Ensembl' },
        { field: 'ids', op: 'in', value: ['P38398'] }
      ],
      limit: 10
    })
    assert.equal(
      mapping.rows.some((row) => row.from === 'P38398' && row.failed === false),
      true
    )

    const variation = await ensembl.query({
      domain: 'variation',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'id', op: '=', value: 'rs699' }
      ],
      fields: ['name', 'most_severe_consequence', 'mappings'],
      limit: 1
    })
    assert.equal(variation.rows[0]?.name, 'rs699')
    assert.equal(Array.isArray(variation.rows[0]?.mappings), true)

    const vep = await ensembl.query({
      domain: 'vep_id',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'id', op: '=', value: 'rs699' }
      ],
      fields: ['id', 'input', 'most_severe_consequence', 'transcript_consequences'],
      limit: 10
    })
    assert.equal(vep.rows.length > 0, true)
    assert.equal(
      vep.rows.some((row) => row.id === 'rs699' || String(row.input ?? '').includes('rs699')),
      true
    )
  }
)

test(
  'expanded live Ensembl identity audit covers ontology, archive, recoder, and GA4GH records',
  { skip: expandedSkip, timeout: 240_000 },
  async () => {
    const ensembl = new RestJsonAdapter(
      bundledManifest('resources/db-connectors/rest-json/ensembl/connector.yaml'),
      { timeoutMs: 60_000 }
    )

    const ontology = await ensembl.query({
      domain: 'ontology_id',
      filters: [{ field: 'id', op: '=', value: 'SO:0001217' }],
      fields: ['accession', 'name'],
      limit: 1
    })
    assert.equal(ontology.rows[0]?.stable_id, 'SO:0001217')
    assert.equal(ontology.rows[0]?.stable_id_namespace, 'ontology.term_accession')

    const archive = await ensembl.query({
      domain: 'archive_id',
      filters: [{ field: 'id', op: '=', value: 'ENSG00000012048' }],
      fields: ['id', 'latest', 'release'],
      limit: 1
    })
    assert.equal(archive.rows[0]?.stable_id, 'ENSG00000012048')
    assert.equal(archive.rows[0]?.stable_id_namespace, 'ensembl.stable_id')

    const recoded = await ensembl.query({
      domain: 'variant_recoder',
      filters: [
        { field: 'species', op: '=', value: 'human' },
        { field: 'id', op: '=', value: 'rs699' }
      ],
      fields: ['input', 'id'],
      limit: 10
    })
    assert.equal(recoded.rows[0]?.input, 'rs699')
    assert.equal(Array.isArray(recoded.rows[0]?.id), true)
    assert.equal(recoded.rows[0]?.stable_id, undefined)

    const variants = await ensembl.query({
      domain: 'ga4gh_variant_search',
      filters: [
        { field: 'variantSetId', op: '=', value: '1' },
        { field: 'referenceName', op: '=', value: '22' },
        { field: 'start', op: '=', value: 17190024 },
        { field: 'end', op: '=', value: 17671934 },
        { field: 'pageSize', op: '=', value: 1 }
      ],
      fields: ['id', 'variantSetId', 'referenceName', 'start', 'end'],
      limit: 1
    })
    assert.equal(variants.rows.length, 1)
    assert.equal(typeof variants.rows[0]?.stable_id, 'string')
    assert.equal(variants.rows[0]?.stable_id_namespace, 'ga4gh.variant_id')
  }
)
