#!/usr/bin/env nextflow
// Thin standalone launcher around nf-core/rnaseq 3.26.0's MULTIQC module
// (vendored unmodified at modules/nf-core/multiqc/) — see this wrapper's
// wrapper.yaml doc comment for why this exists as its own Phi wrapper
// rather than only inside the full nf-core/rnaseq wrapper.
nextflow.enable.dsl = 2

include { MULTIQC } from './modules/nf-core/multiqc/main'

workflow {
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
