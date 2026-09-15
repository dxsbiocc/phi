#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { STAR_ALIGN_WF } from './workflows/star_align'

workflow {
    STAR_ALIGN_WF()
}
