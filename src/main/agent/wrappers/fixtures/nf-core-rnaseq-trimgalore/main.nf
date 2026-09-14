#!/usr/bin/env nextflow
// Thin standalone launcher around nf-core/rnaseq 3.26.0's TRIMGALORE module
// (vendored unmodified at modules/nf-core/trimgalore/) — see this
// wrapper's wrapper.yaml doc comment for why this exists as its own Phi
// wrapper rather than only inside the full nf-core/rnaseq wrapper.
nextflow.enable.dsl = 2

include { TRIMGALORE } from './modules/nf-core/trimgalore/main'

workflow {
    Channel
        .fromFilePairs(params.reads, size: 2)
        .map { sample, reads -> [[id: sample, single_end: false], reads] }
        .set { reads_ch }

    TRIMGALORE(reads_ch)
}
