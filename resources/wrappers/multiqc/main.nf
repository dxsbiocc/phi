#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { MULTIQC_WF } from './workflows/multiqc'

workflow {
    MULTIQC_WF()
}
