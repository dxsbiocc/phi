// Orchestration for the FASTQC wrapper — nf-core convention places this
// kind of channel-setup + process-call logic in workflows/, distinct from
// modules/nf-core/ (vendored, unmodified upstream) and modules/local/
// (reserved for any locally authored process this wrapper doesn't
// currently need). See this wrapper's wrapper.yaml doc comment for why it
// exists standalone alongside the full nf-core/rnaseq pipeline wrapper.
nextflow.enable.dsl = 2

include { FASTQC } from '../modules/nf-core/fastqc/main'

workflow FASTQC_WF {
    Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample], reads] }
        .set { reads_ch }

    FASTQC(reads_ch)
}
