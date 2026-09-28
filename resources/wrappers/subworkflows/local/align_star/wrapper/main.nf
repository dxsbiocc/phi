#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored subworkflow at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
// Composes star/genomegenerate directly (vendored module, not a wrapper) so
// callers only supply a genome FASTA/GTF instead of a pre-built STAR index
// — same reasoning as the star/align module wrapper.
nextflow.enable.dsl = 2

include { STAR_GENOMEGENERATE } from '../../../../modules/nf-core/star/genomegenerate/main.nf'
include { ALIGN_STAR } from '../main.nf'

params.reads_1              = null
params.reads_2              = null
params.fasta                = null
params.gtf                  = null
params.star_ignore_sjdbgtf  = false
params.skip_markduplicates  = false
params.outdir               = null

workflow {
    fasta_ch = Channel.value([[id: 'genome'], [file(params.fasta, checkIfExists: true)]])
    gtf_ch   = Channel.value([[id: 'genome'], [file(params.gtf, checkIfExists: true)]])

    STAR_GENOMEGENERATE(fasta_ch, gtf_ch)

    reads_ch = Channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    fasta_fai_ch = Channel.value([[id: 'genome'], file(params.fasta, checkIfExists: true), []])

    ALIGN_STAR(
        reads_ch,
        STAR_GENOMEGENERATE.out.index,
        gtf_ch,
        params.star_ignore_sjdbgtf,
        fasta_fai_ch,
        params.skip_markduplicates
    )
}
