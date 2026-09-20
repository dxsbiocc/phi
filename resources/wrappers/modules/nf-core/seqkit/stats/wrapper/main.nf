#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { SEQKIT_STATS } from '../main.nf'

params.reads  = null
params.outdir = null

workflow {
    Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample], reads] }
        .set { reads_ch }

    SEQKIT_STATS(reads_ch)
}
