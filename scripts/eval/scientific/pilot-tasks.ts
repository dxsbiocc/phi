import {
  EVAL_CONTRACT_VERSION,
  freezeTaskSetDigest,
  type HiddenReferenceSpec,
  type VisibleEvalTaskCard
} from './contract'

/**
 * 6 frozen RNA-seq pilot task cards for R01 / R19 (36-trial pilot: 6 tasks × 2 arms × 3 reps).
 *
 * Clustering note: PILOT_RNASEQ_01..06 share the same underlying RNA-seq study/dataset
 * (`study_rnaseq_pilot_v1` / `ds_airway_subset_v1`) so downstream statistical analysis MUST
 * treat them as a single clustered dataset rather than 6 independent biological studies.
 *
 * All 6 cards are honestly marked `readiness: 'data_pending'` until the raw FASTQ/reference
 * archive is staged outside the repository and verified against its checksums.
 */

export const PILOT_STUDY_ID = 'study_rnaseq_pilot_v1'
export const PILOT_DATASET_ID = 'ds_airway_subset_v1'
export const PILOT_REFERENCE_VERSION = 'GRCh38.p14 / GENCODE v44'
export const PILOT_SCORING_VERSION = '1.0.0'

const SHARED_INPUT_SOURCE = {
  accession: 'SRP033351 (airway subset)',
  version: '2026-11-pilot-v1',
  summary: 'Paired-end bulk RNA-seq FASTQ subset (4 donors × 2 conditions: dex vs untrt) with donor metadata.',
  acquisitionSteps: [
    'Fetch paired-end FASTQ subset for SRP033351 (4 paired donors, dex vs untrt) from ENA/SRA.',
    'Stage human reference transcriptome/GTF (GRCh38.p14 / GENCODE v44) into the read-only shared reference cache.',
    'Verify SHA-256 checksums against the external pilot dataset manifest before marking readiness="ready".'
  ]
}

export const PILOT_VISIBLE_TASKS: readonly VisibleEvalTaskCard[] = [
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_01_QC',
    taskVersion: '1.0.0',
    title: 'Paired-end FASTQ QC and samplesheet integrity audit',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: ['PILOT_RNASEQ_06_E2E'],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Audit the staged paired-end FASTQ files, generate a validated samplesheet (sample, fastq_1, fastq_2), run FastQC, and write a structured QC summary table.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['wrapper:fastqc', 'notebook:python'],
    visibleOutputs: [
      {
        id: 'samplesheet',
        path: 'results/samplesheet.csv',
        format: 'csv',
        description: 'Validated paired-end samplesheet',
        requiredColumns: ['sample', 'fastq_1', 'fastq_2'],
        minDataRows: 4
      },
      {
        id: 'qc_summary',
        path: 'results/qc_summary.tsv',
        format: 'tsv',
        description: 'Per-sample read counts and GC/quality metrics',
        requiredColumns: ['sample', 'total_sequences', 'gc_percent'],
        minDataRows: 4
      }
    ],
    budget: { maxWallSeconds: 900, maxModelCalls: 25, maxCostUsd: 1.5, maxCpus: 4, maxMemoryGb: 8 },
    scoringVersion: PILOT_SCORING_VERSION
  },
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_02_TRIM',
    taskVersion: '1.0.0',
    title: 'Adapter trimming and post-filter read retention summary',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: ['PILOT_RNASEQ_01_QC', 'PILOT_RNASEQ_06_E2E'],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Trim adapters and low-quality bases with fastp across all paired-end samples and summarize before/after read counts and Q30 retention.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['wrapper:fastp', 'notebook:python'],
    visibleOutputs: [
      {
        id: 'trim_summary',
        path: 'results/trim_summary.tsv',
        format: 'tsv',
        description: 'Per-sample fastp retention and Q30 metrics',
        requiredColumns: ['sample', 'before_reads', 'after_reads', 'q30_rate'],
        minDataRows: 4
      }
    ],
    budget: { maxWallSeconds: 1200, maxModelCalls: 25, maxCostUsd: 1.5, maxCpus: 4, maxMemoryGb: 8 },
    scoringVersion: PILOT_SCORING_VERSION
  },
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_03_QUANT',
    taskVersion: '1.0.0',
    title: 'Gene-level raw count quantification against GRCh38/GENCODE v44',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: ['PILOT_RNASEQ_02_TRIM', 'PILOT_RNASEQ_04_DE', 'PILOT_RNASEQ_06_E2E'],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Quantify trimmed paired-end reads against the staged GRCh38.p14 / GENCODE v44 index and export a gene-by-sample raw count matrix plus mapping rate summary.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['wrapper:salmon', 'notebook:r'],
    visibleOutputs: [
      {
        id: 'gene_counts',
        path: 'results/gene_counts.tsv',
        format: 'tsv',
        description: 'Gene-by-sample raw count matrix',
        requiredColumns: ['gene_id'],
        minDataRows: 100
      },
      {
        id: 'mapping_summary',
        path: 'results/mapping_summary.tsv',
        format: 'tsv',
        description: 'Per-sample mapping rates',
        requiredColumns: ['sample', 'percent_mapped'],
        minDataRows: 4
      }
    ],
    budget: { maxWallSeconds: 1800, maxModelCalls: 30, maxCostUsd: 2.0, maxCpus: 4, maxMemoryGb: 16 },
    scoringVersion: PILOT_SCORING_VERSION
  },
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_04_DE',
    taskVersion: '1.0.0',
    title: 'Donor-paired differential expression (dex vs untrt) with DESeq2',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: ['PILOT_RNASEQ_03_QUANT', 'PILOT_RNASEQ_05_PATHWAY', 'PILOT_RNASEQ_06_E2E'],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Fit a donor-adjusted DESeq2 model (~ donor + condition, contrast dex vs untrt) on the provided raw gene count matrix and sample metadata, exporting full DE statistics.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['wrapper:deseq2', 'notebook:r'],
    visibleOutputs: [
      {
        id: 'de_results',
        path: 'results/deseq2_results.tsv',
        format: 'tsv',
        description: 'Full DESeq2 differential expression table',
        requiredColumns: ['gene_id', 'baseMean', 'log2FoldChange', 'pvalue', 'padj'],
        minDataRows: 100
      }
    ],
    budget: { maxWallSeconds: 900, maxModelCalls: 25, maxCostUsd: 1.5, maxCpus: 4, maxMemoryGb: 8 },
    scoringVersion: PILOT_SCORING_VERSION
  },
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_05_PATHWAY',
    taskVersion: '1.0.0',
    title: 'Ranked pathway enrichment from differential expression results',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: ['PILOT_RNASEQ_04_DE', 'PILOT_RNASEQ_06_E2E'],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Run gene-set enrichment against the provided frozen GMT gene sets using the DESeq2 results table and export ranked pathways with NES and adjusted p-values.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['notebook:r', 'notebook:python'],
    visibleOutputs: [
      {
        id: 'pathway_results',
        path: 'results/pathway_enrichment.tsv',
        format: 'tsv',
        description: 'Pathway enrichment results with NES and padj',
        requiredColumns: ['pathway', 'NES', 'padj'],
        minDataRows: 5
      }
    ],
    budget: { maxWallSeconds: 900, maxModelCalls: 25, maxCostUsd: 1.5, maxCpus: 4, maxMemoryGb: 8 },
    scoringVersion: PILOT_SCORING_VERSION
  },
  {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: 'PILOT_RNASEQ_06_E2E',
    taskVersion: '1.0.0',
    title: 'End-to-end bulk RNA-seq: FASTQ → QC → quantification → donor-paired DE → pathway',
    studyId: PILOT_STUDY_ID,
    datasetId: PILOT_DATASET_ID,
    relatedTaskIds: [
      'PILOT_RNASEQ_01_QC',
      'PILOT_RNASEQ_02_TRIM',
      'PILOT_RNASEQ_03_QUANT',
      'PILOT_RNASEQ_04_DE',
      'PILOT_RNASEQ_05_PATHWAY'
    ],
    split: 'dev',
    readiness: 'data_pending',
    prompt:
      'Execute the complete paired-end RNA-seq workflow from raw FASTQ to donor-adjusted DESeq2 (dex vs untrt) and pathway enrichment, exporting QC, counts, DE, and pathway tables.',
    inputSource: SHARED_INPUT_SOURCE,
    referenceVersion: PILOT_REFERENCE_VERSION,
    tools: ['wrapper:fastqc', 'wrapper:fastp', 'wrapper:salmon', 'wrapper:deseq2', 'notebook:r'],
    visibleOutputs: [
      {
        id: 'gene_counts',
        path: 'results/gene_counts.tsv',
        format: 'tsv',
        description: 'Gene-by-sample raw count matrix',
        requiredColumns: ['gene_id'],
        minDataRows: 100
      },
      {
        id: 'de_results',
        path: 'results/deseq2_results.tsv',
        format: 'tsv',
        description: 'Full DESeq2 differential expression table',
        requiredColumns: ['gene_id', 'baseMean', 'log2FoldChange', 'pvalue', 'padj'],
        minDataRows: 100
      },
      {
        id: 'pathway_results',
        path: 'results/pathway_enrichment.tsv',
        format: 'tsv',
        description: 'Pathway enrichment results',
        requiredColumns: ['pathway', 'NES', 'padj'],
        minDataRows: 5
      }
    ],
    budget: { maxWallSeconds: 3600, maxModelCalls: 60, maxCostUsd: 4.0, maxCpus: 4, maxMemoryGb: 16 },
    scoringVersion: PILOT_SCORING_VERSION
  }
]

/**
 * Hidden reference metadata keys stored separately from agent-visible task cards.
 * Actual reference files live strictly outside the trial workspace (enforced by R03).
 */
export const PILOT_HIDDEN_REFERENCES: readonly HiddenReferenceSpec[] = PILOT_VISIBLE_TASKS.map(
  (task) => ({
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    scoringVersion: task.scoringVersion,
    referenceArtifactKey: `${PILOT_STUDY_ID}/${task.taskId}@${task.taskVersion}`,
    tolerances: {
      absTol: 1e-3,
      relTol: 1e-2,
      minJaccard: 0.85,
      directionAgreementMin: 0.95
    }
  })
)

export const PILOT_TASK_SET_DIGEST = freezeTaskSetDigest(PILOT_VISIBLE_TASKS)
