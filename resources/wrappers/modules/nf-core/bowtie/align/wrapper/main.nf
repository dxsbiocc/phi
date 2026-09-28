#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { BOWTIE_ALIGN } from '../main.nf'
include { BOWTIE_BUILD } from '../../build/main.nf'

params.reads      = null
params.fasta      = null
params.outdir     = null

workflow {
    reads_ch = Channel.value([[id: 'sample', single_end: true], file(params.reads, checkIfExists: true)])
    fasta_ch = Channel.value([[id: 'genome'], file(params.fasta, checkIfExists: true)])

    BOWTIE_BUILD(fasta_ch)
    BOWTIE_ALIGN(reads_ch, BOWTIE_BUILD.out.index, true)
}
