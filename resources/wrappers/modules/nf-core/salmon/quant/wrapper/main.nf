#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf — see
// docs/design/phi-wrapper-agent-composition-design.md section 1.
//
// Composes SALMON_INDEX + SALMON_QUANT internally (builds a transcript-only
// index from `transcript_fasta` first) — same reasoning as the bowtie2/
// hisat2 align wrappers: there's no pre-built index in test-datasets to
// just point this wrapper's default params.json at.
//
// Two explicit read-file params instead of one `reads` glob: Nextflow
// rejects glob patterns entirely for `https://` sources.
//
// alignment_mode is left false (mapping-based mode, using the built
// index) and lib_type empty (auto-detect), matching the module's own
// defaults.
nextflow.enable.dsl = 2

include { SALMON_INDEX } from '../../index/main.nf'
include { SALMON_QUANT } from '../main.nf'

params.reads_1          = null
params.reads_2          = null
params.transcript_fasta = null
params.gtf              = null
params.outdir           = null

workflow {
    ch_transcript_fasta = file(params.transcript_fasta, checkIfExists: true)

    SALMON_INDEX([], ch_transcript_fasta)

    reads_ch = channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    SALMON_QUANT(
        reads_ch,
        SALMON_INDEX.out.index,
        file(params.gtf, checkIfExists: true),
        ch_transcript_fasta,
        false,
        ''
    )
}
