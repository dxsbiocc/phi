/**
 * Versioned cross-step scientific context contract (R13).
 *
 * Every scientific field carries explicit provenance (`observed`, `declared`, or
 * `unknown`) so model narration is never promoted to observed fact, and missing
 * metadata is always represented as `unknown` rather than guessed.
 */

export const SCIENTIFIC_CONTEXT_SCHEMA_VERSION = 1 as const

export type ScientificProvenanceStatus = 'observed' | 'declared' | 'unknown'

export type ProvenancedValue<T> =
  | {
      status: 'observed' | 'declared'
      value: T
      /** Concrete origin of this fact (e.g. `wrapper:salmon`, `sidecar:header`, `user_input`). */
      source: string
    }
  | {
      status: 'unknown'
      reason?: string
    }

export const MATRIX_VALUE_SEMANTICS = [
  'raw_counts',
  'normalized',
  'log_transformed',
  'tpm',
  'fpkm',
  'cpm',
  'zscore',
  'de_stats'
] as const

export type MatrixValueSemantics = (typeof MATRIX_VALUE_SEMANTICS)[number]

export interface ScientificReferenceInfo {
  assembly: string
  annotation?: string
  digest?: string
}

export interface ScientificSampleContext {
  sampleIds: string[]
  /** Maps sample ID -> biological donor/subject ID for donor-level analyses. */
  donorBySample?: Record<string, string>
}

export interface ScientificMatrixContext {
  rowIdType?: string
  columnIds?: string[]
  valueSemantics: MatrixValueSemantics
}

export interface ScientificArtifactIdentity {
  location: 'local' | 'remote'
  /** Remote host alias/profile when `location === 'remote'`, preventing local/remote path collisions. */
  host?: string
  /** Canonical path on the execution host. */
  path: string
  /** Real SHA-256 of artifact bytes when observed; omitted if bytes were not hashed. */
  contentSha256?: string
  contextVersion: typeof SCIENTIFIC_CONTEXT_SCHEMA_VERSION
}

export interface ScientificContextSidecar {
  schemaVersion: typeof SCIENTIFIC_CONTEXT_SCHEMA_VERSION
  capturedAt: string
  producer: {
    kind: 'wrapper' | 'notebook' | 'plan_step'
    id: string
    runId?: string
  }
  artifact: ScientificArtifactIdentity
  organism: ProvenancedValue<string>
  reference: ProvenancedValue<ScientificReferenceInfo>
  samples: ProvenancedValue<ScientificSampleContext>
  matrix: ProvenancedValue<ScientificMatrixContext>
}

export function unknownValue<T>(reason?: string): ProvenancedValue<T> {
  return reason ? { status: 'unknown', reason } : { status: 'unknown' }
}

export function observedValue<T>(value: T, source: string): ProvenancedValue<T> {
  return { status: 'observed', value, source }
}

export function declaredValue<T>(value: T, source: string): ProvenancedValue<T> {
  return { status: 'declared', value, source }
}
