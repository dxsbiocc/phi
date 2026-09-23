#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
// Composes sylph/profile directly (vendored module, not a wrapper) so
// callers only supply reads + a Sylph db + a taxonomy map.
nextflow.enable.dsl = 2

include { SYLPH_PROFILE } from '../../../sylph/profile/main.nf'
include { SYLPHTAX_TAXPROF } from '../main.nf'

params.reads     = null
params.database  = null
params.taxonomy  = null
params.outdir    = null

workflow {
    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    database_ch = Channel.fromPath(params.database, checkIfExists: true)

    SYLPH_PROFILE(reads_ch, database_ch)

    taxonomy_ch = Channel.fromPath(params.taxonomy, checkIfExists: true)

    SYLPHTAX_TAXPROF(SYLPH_PROFILE.out.profile_out, taxonomy_ch)
}
