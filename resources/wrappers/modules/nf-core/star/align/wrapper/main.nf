#!/usr/bin/env nextflow
// Thin agent-facing adapter over ../main.nf (STAR_ALIGN). A pre-built STAR
// index (`index`) is used as-is; without one, ../genomegenerate/main.nf builds
// it from `fasta` + `gtf` first — the only way to align against a genome that
// has no index yet. This still composes only vendored modules directly,
// matching the composition rule in
// docs/design/phi-wrapper-agent-composition-design.md section 6.
nextflow.enable.dsl = 2

include { STAR_GENOMEGENERATE } from '../../genomegenerate/main.nf'
include { STAR_ALIGN } from '../main.nf'

params.index  = null
params.fasta  = null
params.gtf    = null
params.reads  = null
params.outdir = null

workflow {
    if (!params.index && !params.fasta) {
        error "star-align needs either `index` (a pre-built STAR index directory) or `fasta` to build one."
    }

    gtf_ch = Channel.fromPath(params.gtf, checkIfExists: true).map { f -> [[id: f.simpleName], f] }

    if (params.index) {
        index_ch = Channel.value([[id: 'star_index'], file(params.index, checkIfExists: true)])
    } else {
        fasta_ch = Channel.fromPath(params.fasta, checkIfExists: true).map { f -> [[id: f.simpleName], f] }
        STAR_GENOMEGENERATE(fasta_ch, gtf_ch)
        index_ch = STAR_GENOMEGENERATE.out.index.first()
    }

    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    STAR_ALIGN(reads_ch, index_ch, gtf_ch.first(), false)
}
