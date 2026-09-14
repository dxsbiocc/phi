#!/usr/bin/env nextflow
// Thin standalone launcher chaining nf-core/rnaseq 3.26.0 modules
// (vendored unmodified) — extract a transcript FASTA (GFFREAD), build a
// Salmon index from it (SALMON_INDEX), then quantify reads against it
// (SALMON_QUANT), quasi-mapping mode. Non-decoy-aware (no genome_fasta
// passed to SALMON_INDEX) — simpler and enough for a standalone
// quantification wrapper; nf-core/rnaseq's own decoy-aware index is more
// accurate but needs its own genome/decoys prep this wrapper doesn't do.
// The index is rebuilt on every run, same tradeoff as the star-align
// wrapper in this namespace.
//
// GTF is gunzipped first when compressed — same real, verified-necessary
// fix as the star-align wrapper (see its main.nf doc comment): GFFREAD/
// downstream tools here were checked against an uncompressed GTF, not
// re-verified against a compressed one, so this keeps the same safe
// default rather than assuming gzip support.
nextflow.enable.dsl = 2

include { GUNZIP as GUNZIP_GTF } from './modules/nf-core/gunzip/main'
include { GFFREAD } from './modules/nf-core/gffread/main'
include { SALMON_INDEX } from './modules/nf-core/salmon/index/main'
include { SALMON_QUANT } from './modules/nf-core/salmon/quant/main'

workflow {
    ch_fasta = file(params.fasta)
    ch_gtf_raw = Channel.of([[id: 'genome'], file(params.gtf)])

    // GFFREAD and (below) SALMON_QUANT both consume ch_gtf_meta, so the
    // gunzip branch needs .first() to turn its process output back into a
    // reusable value channel — Channel.of() (the other branch) is one
    // already.
    if (params.gtf.toString().endsWith('.gz')) {
        GUNZIP_GTF(ch_gtf_raw)
        ch_gtf_meta = GUNZIP_GTF.out.gunzip.first()
    } else {
        ch_gtf_meta = ch_gtf_raw
    }

    GFFREAD(ch_gtf_meta, ch_fasta)
    ch_transcript_fasta = GFFREAD.out.gffread_fasta.map { meta, fasta -> fasta }.first()

    SALMON_INDEX([], ch_transcript_fasta)

    Channel
        .fromFilePairs(params.reads, size: 2)
        .map { sample, reads -> [[id: sample, single_end: false], reads] }
        .set { reads_ch }

    ch_gtf_plain = ch_gtf_meta.map { meta, gtf -> gtf }

    SALMON_QUANT(
        reads_ch,
        SALMON_INDEX.out.index.first(),
        ch_gtf_plain,
        [],
        false,
        'A'
    )
}
