#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { SALMON_QUANT_WF } from './workflows/salmon_quant'

workflow {
    SALMON_QUANT_WF()
}
