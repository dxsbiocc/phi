#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored subworkflow at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
// Composes bowtie2/build directly (vendored module, not a wrapper) so
// callers only supply a reference FASTA instead of a pre-built Bowtie2
// index — same reasoning as the bowtie2/align module wrapper.
//
// Two explicit read-file params instead of one `reads` glob: Nextflow
// rejects glob patterns entirely for `https://` sources.
nextflow.enable.dsl = 2

include { BOWTIE2_BUILD } from '../../../../modules/nf-core/bowtie2/build/main.nf'
include { ALIGN_BOWTIE2 } from '../main.nf'

params.reads_1        = null
params.reads_2        = null
params.fasta          = null
params.save_unaligned = false
params.outdir         = null

workflow {
    fasta_ch = Channel
        .fromPath(params.fasta, checkIfExists: true)
        .map { fasta -> [[id: fasta.baseName], fasta] }

    BOWTIE2_BUILD(fasta_ch)

    reads_ch = Channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    index_ch = BOWTIE2_BUILD.out.index.map { meta, index -> index }

    fasta_fai_ch = Channel.value([[:], [], []])

    ALIGN_BOWTIE2(reads_ch, index_ch, fasta_fai_ch)
}
