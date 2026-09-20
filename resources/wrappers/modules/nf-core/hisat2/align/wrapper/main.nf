#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf — see
// docs/design/phi-wrapper-agent-composition-design.md section 1.
//
// Composes HISAT2_EXTRACTSPLICESITES + HISAT2_BUILD + HISAT2_ALIGN — the
// exact same three-module chain nf-core's own HISAT2_ALIGN test builds as
// a setup step, since there's no pre-built index in test-datasets to just
// point this wrapper's default params.json at. Makes "align these reads to
// this genome" work as one wrapper run instead of three.
//
// Two explicit read-file params instead of one `reads` glob: Nextflow
// rejects glob patterns entirely for `https://` sources, so
// `Channel.fromFilePairs` can't match a `test_{1,2}.fastq.gz`-style
// pattern against remote test data.
nextflow.enable.dsl = 2

include { HISAT2_EXTRACTSPLICESITES } from '../../extractsplicesites/main.nf'
include { HISAT2_BUILD              } from '../../build/main.nf'
include { HISAT2_ALIGN              } from '../main.nf'

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

    reads_ch = channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    HISAT2_ALIGN(reads_ch, HISAT2_BUILD.out.index, HISAT2_EXTRACTSPLICESITES.out.txt, false)
}
