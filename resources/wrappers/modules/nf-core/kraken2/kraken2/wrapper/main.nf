#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
// Composes untar directly (vendored module, not another wrapper) so callers
// supply the db as a plain tar.gz instead of pre-extracting it themselves.
nextflow.enable.dsl = 2

include { UNTAR } from '../../../untar/main.nf'
include { KRAKEN2_KRAKEN2 } from '../main.nf'

params.reads                 = null
params.db                    = null
params.save_output_fastqs    = false
params.save_reads_assignment = false
params.outdir                = null

workflow {
    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    db_archive_ch = Channel
        .fromPath(params.db, checkIfExists: true)
        .map { db -> [[id: 'kraken2_db'], db] }

    UNTAR(db_archive_ch)

    KRAKEN2_KRAKEN2(reads_ch, UNTAR.out.untar.map { meta, dir -> dir }, params.save_output_fastqs, params.save_reads_assignment)
}
