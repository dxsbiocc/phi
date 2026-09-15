#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { TRIMGALORE_WF } from './workflows/trimgalore'

workflow {
    TRIMGALORE_WF()
}
