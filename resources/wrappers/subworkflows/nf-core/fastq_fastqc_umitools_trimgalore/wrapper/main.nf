#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored subworkflow at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1. Includes
// the subworkflow only — never another wrapper (section 6).
nextflow.enable.dsl = 2

include { FASTQ_FASTQC_UMITOOLS_TRIMGALORE } from '../main.nf'

params.reads             = null
params.skip_fastqc       = false
params.with_umi          = true
params.skip_umi_extract  = false
params.skip_trimming     = false
params.umi_discard_read  = 0
params.min_trimmed_reads = 1
params.outdir            = null

workflow {
    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    FASTQ_FASTQC_UMITOOLS_TRIMGALORE(
        reads_ch,
        params.skip_fastqc,
        params.with_umi,
        params.skip_umi_extract,
        params.skip_trimming,
        params.umi_discard_read,
        params.min_trimmed_reads
    )
}
