#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored subworkflow at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
//
// FASTQ_ALIGN_HISAT2 expects a ready HISAT2 index and splice-sites file, so
// this first runs the two modules that produce them — the same setup chain
// nf-core's own subworkflow test uses (see ../tests/main.nf.test), and the
// same one hisat2/align/wrapper/main.nf uses. Those modules are included
// directly (section 6: never include another wrapper).
//
// Two explicit read-file params instead of one glob: Nextflow rejects glob
// patterns for https:// sources. `reads_2` is optional (single-end when unset).
nextflow.enable.dsl = 2

include { HISAT2_EXTRACTSPLICESITES } from '../../../../modules/nf-core/hisat2/extractsplicesites/main.nf'
include { HISAT2_BUILD              } from '../../../../modules/nf-core/hisat2/build/main.nf'
include { FASTQ_ALIGN_HISAT2        } from '../main.nf'

params.reads_1 = null
params.reads_2 = null
params.fasta   = null
params.gtf     = null
params.outdir  = null

workflow {
    ch_fasta = Channel.fromPath(params.fasta, checkIfExists: true)
    ch_gtf   = Channel.fromPath(params.gtf, checkIfExists: true)

    HISAT2_EXTRACTSPLICESITES(ch_gtf.map { gtf -> [[id: gtf.baseName], gtf] })

    ch_build_input = ch_fasta
        .combine(ch_gtf)
        .combine(HISAT2_EXTRACTSPLICESITES.out.txt.map { _meta, txt -> txt })
        .map { fasta, gtf, splicesites -> [[id: fasta.baseName], fasta, gtf, splicesites] }

    HISAT2_BUILD(ch_build_input, '1.GB')

    def single_end = !params.reads_2
    def reads      = [file(params.reads_1, checkIfExists: true)]
    if (!single_end) reads << file(params.reads_2, checkIfExists: true)
    reads_ch = channel.of([[id: 'sample', single_end: single_end], reads])

    ch_fasta_fai = channel.value([[:], [], []])

    FASTQ_ALIGN_HISAT2(
        reads_ch,
        HISAT2_BUILD.out.index,
        HISAT2_EXTRACTSPLICESITES.out.txt,
        ch_fasta_fai,
        false
    )
}
