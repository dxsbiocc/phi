import { isAbsolute } from 'node:path'
import type { WrapperJobStatus } from '../wrappers/composition/job-types'

export interface WrapperPublication {
  primary: string[]
  files: string[]
}

/** Project only the paths the trusted host actually published; never keep logs, rows or glob rules. */
export function verifiedWrapperPublication(
  status: WrapperJobStatus
): WrapperPublication | undefined {
  const qc = status.researchQc
  if (
    status.remote ||
    status.state !== 'completed' ||
    (qc?.disposition !== 'eligible' && qc?.disposition !== 'skip') ||
    qc.integrityVerified !== true
  )
    return undefined
  // Composition records a byte count only for a stat-confirmed regular file. Zero is valid.
  const files = (status.outputs ?? []).filter(
    (file) =>
      file.location === 'local' &&
      file.exists &&
      typeof file.bytes === 'number' &&
      Number.isSafeInteger(file.bytes) &&
      file.bytes >= 0 &&
      isAbsolute(file.path)
  )
  const primary = files.filter((file) => file.primary).map((file) => file.path)
  return primary.length ? { primary, files: files.map((file) => file.path) } : undefined
}

/** A reference to an ambiguous reused primary path cannot identify a particular publication. */
export function relatedPublicationFiles(
  evidence: readonly string[],
  publications: readonly WrapperPublication[],
  canonicalPath: (reference: string) => string | undefined
): string[] {
  const outputs = new Set<string>()
  const anchors = publications.map((publication) => ({
    publication,
    paths: new Set(publication.primary.map(canonicalPath))
  }))
  for (const ref of evidence) {
    const path = canonicalPath(ref)
    if (!path) continue
    const matches = anchors.filter((anchor) => anchor.paths.has(path))
    if (matches.length === 1) for (const file of matches[0].publication.files) outputs.add(file)
  }
  return [...outputs]
}
