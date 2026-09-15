#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { FASTQC_WF } from './workflows/fastqc'

workflow {
    FASTQC_WF()
}
