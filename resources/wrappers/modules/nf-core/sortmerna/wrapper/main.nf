#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { SORTMERNA } from '../main.nf'

params.reads      = null
params.rrna_fasta = null
params.outdir     = null

workflow {
    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample], reads] }

    fastas_ch = Channel.value([[id: 'rrna_ref'], [file(params.rrna_fasta, checkIfExists: true)]])

    index_ch = Channel.value([[:], []])

    SORTMERNA(reads_ch, fastas_ch, index_ch)
}
