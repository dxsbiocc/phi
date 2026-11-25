import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isRecord } from '../../../shared/guards'
import {
  SCIENTIFIC_CONTEXT_SCHEMA_VERSION,
  unknownValue,
  type ProvenancedValue,
  type ScientificArtifactIdentity,
  type ScientificContextSidecar,
  type ScientificMatrixContext,
  type ScientificReferenceInfo,
  type ScientificSampleContext
} from '../../../shared/scientificContextTypes'

export const SCIENTIFIC_CONTEXT_SIDECAR_SUFFIX = '.phi-context.json'

export function scientificContextSidecarPath(artifactPath: string): string {
  return `${artifactPath}${SCIENTIFIC_CONTEXT_SIDECAR_SUFFIX}`
}

/** Computes real SHA-256 of an existing local regular file; returns undefined if absent/unreadable. */
export function computeArtifactSha256(filePath: string): string | undefined {
  try {
    const abs = resolve(filePath)
    const stats = lstatSync(abs)
    if (!stats.isFile()) return undefined
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch {
    return undefined
  }
}

export interface CreateScientificContextInput {
  producer: ScientificContextSidecar['producer']
  location: 'local' | 'remote'
  host?: string
  path: string
  /** If true and `location === 'local'`, hashes actual file bytes. Never fabricates a hash. */
  hashLocalBytes?: boolean
  contentSha256?: string
  organism?: ProvenancedValue<string>
  reference?: ProvenancedValue<ScientificReferenceInfo>
  samples?: ProvenancedValue<ScientificSampleContext>
  matrix?: ProvenancedValue<ScientificMatrixContext>
  capturedAt?: string
}

export function buildScientificContextSidecar(
  input: CreateScientificContextInput
): ScientificContextSidecar {
  const contentSha256 =
    input.contentSha256 ??
    (input.hashLocalBytes && input.location === 'local'
      ? computeArtifactSha256(input.path)
      : undefined)

  const artifact: ScientificArtifactIdentity = {
    location: input.location,
    ...(input.location === 'remote' && input.host ? { host: input.host } : {}),
    path: input.path,
    ...(contentSha256 ? { contentSha256 } : {}),
    contextVersion: SCIENTIFIC_CONTEXT_SCHEMA_VERSION
  }

  return {
    schemaVersion: SCIENTIFIC_CONTEXT_SCHEMA_VERSION,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    producer: { ...input.producer },
    artifact,
    organism: input.organism ?? unknownValue('not recorded'),
    reference: input.reference ?? unknownValue('not recorded'),
    samples: input.samples ?? unknownValue('not recorded'),
    matrix: input.matrix ?? unknownValue('not recorded')
  }
}

export function writeScientificContextSidecar(
  artifactPath: string,
  input: CreateScientificContextInput
): ScientificContextSidecar {
  const sidecar = buildScientificContextSidecar(input)
  writeFileSync(
    scientificContextSidecarPath(artifactPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    'utf-8'
  )
  return sidecar
}

function normalizeProvenanced<T>(value: unknown, fallbackReason: string): ProvenancedValue<T> {
  if (!isRecord(value)) return unknownValue(fallbackReason)
  if (
    (value.status === 'observed' || value.status === 'declared') &&
    'value' in value &&
    typeof value.source === 'string' &&
    value.source.trim().length > 0
  ) {
    return {
      status: value.status,
      value: value.value as T,
      source: value.source
    }
  }
  return unknownValue(typeof value.reason === 'string' ? value.reason : fallbackReason)
}

function parseSidecarProducer(
  rawProducer: Record<string, unknown>
): ScientificContextSidecar['producer'] {
  const kind =
    rawProducer.kind === 'wrapper' ||
    rawProducer.kind === 'notebook' ||
    rawProducer.kind === 'plan_step'
      ? rawProducer.kind
      : 'plan_step'
  return {
    kind,
    id: typeof rawProducer.id === 'string' ? rawProducer.id : 'unknown',
    ...(typeof rawProducer.runId === 'string' ? { runId: rawProducer.runId } : {})
  }
}

function parseSidecarArtifact(
  rawArtifact: Record<string, unknown>,
  artifactPath: string
): ScientificArtifactIdentity {
  return {
    location: rawArtifact.location === 'remote' ? 'remote' : 'local',
    ...(typeof rawArtifact.host === 'string' ? { host: rawArtifact.host } : {}),
    path: typeof rawArtifact.path === 'string' ? rawArtifact.path : artifactPath,
    ...(typeof rawArtifact.contentSha256 === 'string'
      ? { contentSha256: rawArtifact.contentSha256 }
      : {}),
    contextVersion: SCIENTIFIC_CONTEXT_SCHEMA_VERSION
  }
}

/**
 * Parses a raw JSON text string into a normalized `ScientificContextSidecar` (or fallback).
 * Shared by both local disk and remote SSH sidecar readers.
 */
export function parseScientificContextSidecarJson(
  rawJson: string | undefined,
  artifactPath: string,
  location: 'local' | 'remote' = 'local',
  host?: string
): { found: boolean; sidecar: ScientificContextSidecar } {
  const fallback = (): { found: false; sidecar: ScientificContextSidecar } => ({
    found: false,
    sidecar: buildScientificContextSidecar({
      producer: { kind: 'plan_step', id: 'unknown' },
      location,
      host,
      path: artifactPath,
      organism: unknownValue('sidecar missing'),
      reference: unknownValue('sidecar missing'),
      samples: unknownValue('sidecar missing'),
      matrix: unknownValue('sidecar missing')
    })
  })

  if (rawJson === undefined) return fallback()
  let raw: unknown
  try {
    raw = JSON.parse(rawJson)
  } catch {
    return fallback()
  }
  if (!isRecord(raw) || raw.schemaVersion !== SCIENTIFIC_CONTEXT_SCHEMA_VERSION) {
    return fallback()
  }

  return {
    found: true,
    sidecar: {
      schemaVersion: SCIENTIFIC_CONTEXT_SCHEMA_VERSION,
      capturedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : new Date(0).toISOString(),
      producer: parseSidecarProducer(isRecord(raw.producer) ? raw.producer : {}),
      artifact: parseSidecarArtifact(isRecord(raw.artifact) ? raw.artifact : {}, artifactPath),
      organism: normalizeProvenanced<string>(raw.organism, 'missing organism'),
      reference: normalizeProvenanced<ScientificReferenceInfo>(raw.reference, 'missing reference'),
      samples: normalizeProvenanced<ScientificSampleContext>(raw.samples, 'missing samples'),
      matrix: normalizeProvenanced<ScientificMatrixContext>(raw.matrix, 'missing matrix')
    }
  }
}

/**
 * Reads a sidecar for `artifactPath`. Missing or legacy artifacts without a sidecar
 * return an explicit all-`unknown` sidecar — never guessing reference versions or raw counts.
 */
export function readScientificContextSidecar(
  artifactPath: string,
  location: 'local' | 'remote' = 'local',
  host?: string
): { found: boolean; sidecar: ScientificContextSidecar } {
  const sidecarFile = scientificContextSidecarPath(artifactPath)
  if (!existsSync(sidecarFile)) {
    return parseScientificContextSidecarJson(undefined, artifactPath, location, host)
  }
  try {
    return parseScientificContextSidecarJson(
      readFileSync(sidecarFile, 'utf-8'),
      artifactPath,
      location,
      host
    )
  } catch {
    return parseScientificContextSidecarJson(undefined, artifactPath, location, host)
  }
}
