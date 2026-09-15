#!/usr/bin/env nextflow
// Thin agent-facing adapter composing the two vendored modules a standalone
// "align with STAR" tool actually needs: ../genomegenerate/main.nf builds
// the index ../align/main.nf (STAR_ALIGN) requires — there is no such thing
// as aligning against a genome that hasn't been indexed yet. This still
// composes only vendored modules directly, matching the composition rule
// in docs/design/phi-wrapper-agent-composition-design.md section 6; it
// just does so inline rather than as a separate subworkflow component,
// since index-then-align is STAR's own fixed two-step contract rather than
// agent-driven composition of otherwise-independent tools.
nextflow.enable.dsl = 2

include { STAR_GENOMEGENERATE } from '../../genomegenerate/main.nf'
include { STAR_ALIGN } from '../main.nf'

params.fasta  = null
params.gtf    = null
params.reads  = null
params.outdir = null

workflow {
    fasta_ch = Channel.fromPath(params.fasta, checkIfExists: true).map { f -> [[id: f.simpleName], f] }
    gtf_ch   = Channel.fromPath(params.gtf, checkIfExists: true).map { f -> [[id: f.simpleName], f] }

    STAR_GENOMEGENERATE(fasta_ch, gtf_ch)

    reads_ch = Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample, single_end: reads instanceof List ? reads.size() == 1 : true], reads] }

    STAR_ALIGN(reads_ch, STAR_GENOMEGENERATE.out.index.first(), gtf_ch.first(), false)
}
