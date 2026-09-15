// Orchestration for the MultiQC wrapper — see fastqc/workflows/fastqc.nf's
// doc comment for the nf-core-convention rationale behind this file's
// existence (workflows/ vs modules/nf-core/ vs modules/local/).
nextflow.enable.dsl = 2

include { MULTIQC } from '../modules/nf-core/multiqc/main'

workflow MULTIQC_WF {
    // MULTIQC's module signature has four optional path inputs after the
    // file list (config/logo/replace_names/sample_names) — `[]` for each
    // means "not provided", matching how nf-core/rnaseq's own workflow
    // calls this same module.
    Channel
        .fromPath(params.input, checkIfExists: true)
        .collect()
        .map { files -> [[id: 'multiqc'], files, [], [], [], []] }
        .set { multiqc_input }

    MULTIQC(multiqc_input)
}
