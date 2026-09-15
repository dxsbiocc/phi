import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addCustomWrapper, type WrapperCatalogEntry } from '../../src/main/agent/wrappers/catalog'
import { parseWrapperManifest } from '../../src/main/agent/wrappers/manifest'
import type { WrapperManifest } from '../../src/shared/wrapperManifestTypes'

type LegacyWrapperKind = 'fastq-qc' | 'rnaseq'

const FIXTURE_FILES: Record<LegacyWrapperKind, string> = {
  'fastq-qc': '../fixtures/legacy-fastq-qc-wrapper.yaml',
  rnaseq: '../fixtures/legacy-rnaseq-wrapper.yaml'
}

function fixtureUrl(kind: LegacyWrapperKind): URL {
  return new URL(FIXTURE_FILES[kind], import.meta.url)
}

function readLegacyWrapperManifestText(kind: LegacyWrapperKind): string {
  return readFileSync(fixtureUrl(kind), 'utf-8')
}

function parseLegacyWrapperManifest(kind: LegacyWrapperKind): WrapperManifest {
  const result = parseWrapperManifest(readLegacyWrapperManifestText(kind))
  if (!result.manifest) {
    throw new Error(`Legacy wrapper fixture failed to parse: ${result.errors.join('; ')}`)
  }
  return result.manifest
}

function writeLegacyWrapperSource(kind: LegacyWrapperKind, dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'wrapper.yaml'), readLegacyWrapperManifestText(kind), 'utf-8')
  writeFileSync(join(dir, 'main.nf'), '#!/usr/bin/env nextflow\n', 'utf-8')
  writeFileSync(join(dir, 'nextflow.config'), '// test wrapper config\n', 'utf-8')
}

function installLegacyWrapper(
  kind: LegacyWrapperKind,
  agentDir: string,
  parentDir: string
): WrapperCatalogEntry {
  const sourceDir = join(parentDir, `.legacy-${kind}-wrapper`)
  writeLegacyWrapperSource(kind, sourceDir)
  return addCustomWrapper(sourceDir, agentDir)
}

export function readLegacyFastqQcWrapperManifestText(): string {
  return readLegacyWrapperManifestText('fastq-qc')
}

export function readLegacyFastqQcWrapperManifest(): WrapperManifest {
  return parseLegacyWrapperManifest('fastq-qc')
}

export function installLegacyFastqQcWrapper(
  agentDir: string,
  parentDir: string
): WrapperCatalogEntry {
  return installLegacyWrapper('fastq-qc', agentDir, parentDir)
}

export function installLegacyRnaseqWrapper(
  agentDir: string,
  parentDir: string
): WrapperCatalogEntry {
  return installLegacyWrapper('rnaseq', agentDir, parentDir)
}
