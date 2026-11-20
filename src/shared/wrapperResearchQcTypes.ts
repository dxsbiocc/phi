// Research QC sidecar contract for composition wrappers that declare a
// `research_qc` output. The scientific truth (which genes pass, which contrast
// was fitted) is owned by the wrapper package; the host only binds the sidecar
// to the actual results bytes and reports a small sanitized summary. No result
// rows, no raw file content and no domain analysis ever live here.

export type ResearchQcDisposition = 'eligible' | 'skip' | 'invalid' | 'needs_input'

/** Fixed, closed set of failure codes. Never derived from file content. */
export type ResearchQcInvalidReason =
  | 'declaration'
  | 'missing'
  | 'unsafe-path'
  | 'unreadable'
  | 'malformed'
  | 'integrity-mismatch'
  | 'declared-invalid'

export interface ResearchQcVerifiedSummary {
  disposition: 'eligible' | 'skip'
  schemaVersion: 1
  /** Actual coefficient/formula (advanced) or target vs reference (simple), as the package wrote it. */
  contrast: string
  geneIdColumn: string
  padjThreshold: number
  log2fcThreshold: number
  evaluated: number
  hits: number
  /** MD5 of the exact primary results TSV bytes, verified by the host (integrity, not security). */
  resultMd5: string
  integrityVerified: true
}

export interface ResearchQcInvalidRecord {
  disposition: 'invalid'
  reason: ResearchQcInvalidReason
}

export interface ResearchInputQuestionOption {
  label: string
  description: string
}

/** Static, domain-owned decision the wrapper published before stopping inference. */
export interface ResearchInputQuestion {
  header: string
  question: string
  options: ResearchInputQuestionOption[]
}

export interface ResearchQcNeedsInputRecord {
  disposition: 'needs_input'
  question: ResearchInputQuestion
}

export type WrapperResearchQc =
  ResearchQcVerifiedSummary | ResearchQcInvalidRecord | ResearchQcNeedsInputRecord

/** The one fixed status shown wherever a QC-gated run could not be verified. */
export const RESEARCH_QC_INVALID_STATUS =
  'Research QC invalid: results failed verification and must not be used or interpreted.'

/** Compact English line for agent-facing status and continuation messages. */
export function researchQcSummaryLine(qc: WrapperResearchQc): string {
  if (qc.disposition === 'needs_input') {
    const options = qc.question.options
      .map((option, index) => `(${index + 1}) ${option.label} — ${option.description}`)
      .join(' ')
    return (
      'Research QC needs input: the workflow stopped before inference and published a user decision. ' +
      'Relay it with ask_user_question and wait for the answer. ' +
      `header: ${qc.question.header}; question: ${qc.question.question}; options: ${options} ` +
      'Do not retry this run, read its log or use any of its outputs.'
    )
  }
  if (qc.disposition === 'invalid') {
    return `${RESEARCH_QC_INVALID_STATUS} (reason: ${qc.reason})`
  }
  return (
    `Research QC ${qc.disposition}: ${qc.hits} of ${qc.evaluated} genes passed; ` +
    `contrast ${qc.contrast}; padj < ${qc.padjThreshold}, |log2fc| >= ${qc.log2fcThreshold}; ` +
    `gene id column ${qc.geneIdColumn}; result MD5 verified.`
  )
}

/** True when a run is QC-gated: it has a verdict, or the wrapper declared one. */
export function isResearchQcGated(value: {
  researchQc?: WrapperResearchQc
  researchQcExpected?: true
}): boolean {
  return value.researchQc !== undefined || value.researchQcExpected === true
}
