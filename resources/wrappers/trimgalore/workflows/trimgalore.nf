// Orchestration for the TRIMGALORE wrapper — see fastqc/workflows/fastqc.nf's
// doc comment for the nf-core-convention rationale behind this file's
// existence (workflows/ vs modules/nf-core/ vs modules/local/).
nextflow.enable.dsl = 2

include { TRIMGALORE } from '../modules/nf-core/trimgalore/main'

workflow TRIMGALORE_WF {
    Channel
        .fromFilePairs(params.reads, size: 2)
        .map { sample, reads -> [[id: sample, single_end: false], reads] }
        .set { reads_ch }

    TRIMGALORE(reads_ch)
}
