#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf — see
// docs/design/phi-wrapper-agent-composition-design.md section 1.
//
// Unlike the single-process wrappers elsewhere in this tree, this one
// composes two real modules — BOWTIE2_BUILD then BOWTIE2_ALIGN — because
// alignment always needs a bowtie2 index first, and nf-core's own module
// tests build that index as a setup step rather than shipping one
// pre-built in test-datasets: there's no ready-made index to just point
// this wrapper's default params.json at. This makes "align these reads to
// this genome" work as one wrapper run instead of two.
//
// No reference FASTA passed to BOWTIE2_ALIGN: its own script only uses one
// for CRAM output, which this wrapper's default BAM output never needs.
//
// Two explicit read-file params instead of one `reads` glob: Nextflow
// rejects glob patterns entirely for `https://` sources ("Glob pattern not
// allowed for files with scheme: https"), so `Channel.fromFilePairs` can't
// match a `test_{1,2}.fastq.gz`-style pattern against remote test data the
// way the local-fixture wrappers elsewhere in this tree do.
nextflow.enable.dsl = 2

include { BOWTIE2_BUILD } from '../../build/main.nf'
include { BOWTIE2_ALIGN } from '../main.nf'

params.reads_1 = null
params.reads_2 = null
params.fasta   = null
params.outdir  = null

workflow {
    ch_fasta = Channel
        .fromPath(params.fasta, checkIfExists: true)
        .map { fasta -> [[id: fasta.baseName], fasta] }

    BOWTIE2_BUILD(ch_fasta)

    reads_ch = channel.of([
        [id: 'test', single_end: false],
        [file(params.reads_1, checkIfExists: true), file(params.reads_2, checkIfExists: true)]
    ])

    ch_empty_fasta = channel.value([[:], []])

    BOWTIE2_ALIGN(reads_ch, BOWTIE2_BUILD.out.index, ch_empty_fasta, false, true)
}
