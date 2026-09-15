// Orchestration for the STAR alignment wrapper — see fastqc/workflows/fastqc.nf's
// doc comment for the nf-core-convention rationale behind this file's
// existence (workflows/ vs modules/nf-core/ vs modules/local/).
//
// Chains two nf-core/rnaseq 3.26.0 modules (vendored unmodified) —
// STAR_GENOMEGENERATE then STAR_ALIGN — since alignment needs an index and
// there's no standalone "STAR index" wrapper yet to depend on (Phi has no
// wrapper-composition mechanism; see this wrapper's wrapper.yaml doc
// comment). The index is rebuilt on every run rather than cached/reused
// across runs — fine for this wrapper's scope, worth revisiting if
// repeated runs against the same reference turn out to matter.
//
// GTF is gunzipped first when compressed: verified against a real
// reference — STAR's own genomeGenerate refuses a gzipped
// --sjdbGTFfile ("Fatal INPUT FILE error, no exon lines in the GTF file
// ... Make sure the GTF file is unzipped"), which nf-core/rnaseq's own
// full pipeline handles via its own GUNZIP_GTF step; this wrapper needs
// the same fix since it drives the same module.
nextflow.enable.dsl = 2

include { GUNZIP as GUNZIP_GTF } from '../modules/nf-core/gunzip/main'
include { STAR_GENOMEGENERATE } from '../modules/nf-core/star/genomegenerate/main'
include { STAR_ALIGN } from '../modules/nf-core/star/align/main'

workflow STAR_ALIGN_WF {
    ch_fasta = Channel.of([[id: 'genome'], file(params.fasta)])
    ch_gtf_raw = Channel.of([[id: 'genome'], file(params.gtf)])

    // Both STAR_GENOMEGENERATE and STAR_ALIGN consume the same gtf below,
    // so the gunzip branch needs .first() to turn its process output back
    // into a reusable value channel — Channel.of() (the other branch) is
    // one already.
    if (params.gtf.toString().endsWith('.gz')) {
        GUNZIP_GTF(ch_gtf_raw)
        ch_gtf = GUNZIP_GTF.out.gunzip.first()
    } else {
        ch_gtf = ch_gtf_raw
    }

    STAR_GENOMEGENERATE(ch_fasta, ch_gtf)

    Channel
        .fromFilePairs(params.reads, size: 2)
        .map { sample, reads -> [[id: sample, single_end: false], reads] }
        .set { reads_ch }

    STAR_ALIGN(
        reads_ch,
        STAR_GENOMEGENERATE.out.index.first(),
        ch_gtf,
        false
    )
}
