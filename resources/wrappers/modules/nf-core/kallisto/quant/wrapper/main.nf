#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf — see
// docs/design/phi-wrapper-agent-composition-design.md section 1.
//
// Composes KALLISTO_INDEX + KALLISTO_QUANT internally — same reasoning as
// the other aligner/quantifier wrappers in this tree: no pre-built index in
// test-datasets to just point this wrapper's default params.json at.
//
// Two explicit read-file params instead of one `reads` glob: Nextflow
// rejects glob patterns entirely for `https://` sources. No gtf/chromosomes
// and no fragment-length: paired-end reads never need the latter (the
// module only checks it for single-end data), matching its own defaults.
nextflow.enable.dsl = 2

include { KALLISTO_INDEX } from '../../index/main.nf'
include { KALLISTO_QUANT } from '../main.nf'

params.reads_1 = null
params.reads_2 = null
params.fasta   = null
params.outdir  = null

workflow {
    ch_fasta = Channel
        .fromPath(params.fasta, checkIfExists: true)
        .map { fasta -> [[id: fasta.baseName], fasta] }

    KALLISTO_INDEX(ch_fasta)

    reads_ch = channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    KALLISTO_QUANT(reads_ch, KALLISTO_INDEX.out.index, [], [], '', '')
}
