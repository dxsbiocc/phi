#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf — turns
// wrapper.yaml's `reads`/`outdir` params into the module's channel shape
// and lets the module's own publishDir (declared in this file's
// nextflow.config) land the outputs. Does not modify the module itself.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { FASTQC } from '../main.nf'

params.reads  = null
params.outdir = null

workflow {
    Channel
        .fromFilePairs(params.reads, size: -1)
        .map { sample, reads -> [[id: sample], reads] }
        .set { reads_ch }

    FASTQC(reads_ch)
}
