#!/usr/bin/env nextflow
// Thin agent-facing adapter over the vendored module at ../main.nf.
// See docs/design/phi-wrapper-agent-composition-design.md section 1.
nextflow.enable.dsl = 2

include { SUBREAD_FEATURECOUNTS } from '../main.nf'

params.bam          = null
params.gtf          = null
params.outdir       = null
params.strandedness = 'unstranded'
params.feature_type = 'exon'
params.single_end   = false

workflow {
    gtf = file(params.gtf, checkIfExists: true)

    Channel
        .fromPath(params.bam, checkIfExists: true)
        .map { bam ->
            [[id: bam.simpleName, single_end: params.single_end, strandedness: params.strandedness], bam, gtf]
        }
        .set { counts_ch }

    SUBREAD_FEATURECOUNTS(counts_ch)
}
