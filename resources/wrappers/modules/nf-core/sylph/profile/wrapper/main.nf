#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { SYLPH_PROFILE } from '../main.nf'

params.reads    = null
params.database = null
params.outdir   = null

workflow {
    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    database_ch = Channel.fromPath(params.database, checkIfExists: true)

    SYLPH_PROFILE(reads_ch, database_ch)
}
