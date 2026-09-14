#!/usr/bin/env nextflow
// Thin standalone launcher around nf-core/rnaseq 3.26.0's FASTQC module
// (vendored unmodified at modules/nf-core/fastqc/) — see this wrapper's
// wrapper.yaml doc comment for why this exists as its own Phi wrapper
// rather than only inside the full nf-core/rnaseq wrapper.
nextflow.enable.dsl = 2

include { FASTQC } from './modules/nf-core/fastqc/main'

workflow {
    Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample], reads] }
        .set { reads_ch }

    FASTQC(reads_ch)
}
