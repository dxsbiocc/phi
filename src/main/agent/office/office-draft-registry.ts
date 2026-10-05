import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { getSessionDir } from '../session/session-store'
import { officeArtifactKind, officeDocumentKindFromPath } from './office-document-kind'
import { OfficeFileError } from './office-file-contract'
import type { OfficeArtifact } from './office-files'
import { OFFICE_IMPORT_LIMITS } from './office-import-limits'

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]+$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_HASHABLE_SOURCE_BYTES = 25 * 1024 * 1024

export type OfficeDraftResolution =
  | { readonly kind: 'none'; readonly normalizedSourcePath: string }
  | {
      readonly kind: 'registered'
      readonly artifact: OfficeArtifact
      readonly match: 'draft' | 'source'
      readonly normalizedSourcePath: string
    }
  | {
      readonly kind: 'source_changed'
      readonly previousArtifact: OfficeArtifact
      readonly normalizedSourcePath: string
      readonly currentSourceHash: string | undefined
    }

export interface OfficeDraftLookupInput {
  readonly sessionId: string
  readonly projectId: string | null
  readonly sourcePath: string
  readonly fresh?: boolean
}

interface RegistryEntry {
  readonly artifact: OfficeArtifact
  readonly updatedAt: number
}

interface OfficeDraftRegistryDependencies {
  readonly warn?: (metadata: Readonly<Record<string, string>>) => void
}

function pathKey(path: string): string {
  const normalized = resolve(path).normalize('NFC')
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path)
}

function decodeArtifact(value: unknown, sessionId: string, directory: string): OfficeArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid record')
  const item = value as Record<string, unknown>
  const artifactId = item.artifactId
  const draftPath = item.draftPath
  if (
    typeof artifactId !== 'string' ||
    !ARTIFACT_ID_PATTERN.test(artifactId) ||
    artifactId !== basename(directory) ||
    item.sessionId !== sessionId ||
    typeof draftPath !== 'string' ||
    pathKey(dirname(draftPath)) !== pathKey(directory)
  ) {
    throw new Error('invalid identity')
  }
  if (officeDocumentKindFromPath(draftPath) !== officeArtifactKind(item)) {
    throw new Error('document kind mismatch')
  }
  if (item.origin === 'blank') return decodeBlankArtifact(item, artifactId, sessionId, draftPath)
  if (item.origin === 'import')
    return decodeImportedArtifact(item, artifactId, sessionId, draftPath)
  return decodeSourceArtifact(item, artifactId, sessionId, draftPath)
}

function decodeBlankArtifact(
  item: Record<string, unknown>,
  artifactId: string,
  sessionId: string,
  draftPath: string
): OfficeArtifact {
  if (item.sourcePath !== null || item.sourceHash !== null) throw new Error('invalid blank')
  return {
    artifactId,
    sessionId,
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    kind: officeArtifactKind(item),
    origin: 'blank',
    sourcePath: null,
    sourceHash: null,
    draftPath,
    ...(item.readOnly === true ? { readOnly: true } : {})
  }
}

function decodeSourceArtifact(
  item: Record<string, unknown>,
  artifactId: string,
  sessionId: string,
  draftPath: string
): OfficeArtifact {
  if (
    (item.origin !== undefined && item.origin !== 'source') ||
    typeof item.sourcePath !== 'string' ||
    typeof item.sourceHash !== 'string' ||
    !SHA256_PATTERN.test(item.sourceHash)
  ) {
    throw new Error('invalid source')
  }
  if (officeDocumentKindFromPath(item.sourcePath) !== officeArtifactKind(item)) {
    throw new Error('source kind mismatch')
  }
  return {
    artifactId,
    sessionId,
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    kind: officeArtifactKind(item),
    ...(item.origin === 'source' ? { origin: 'source' as const } : {}),
    sourcePath: item.sourcePath,
    sourceHash: item.sourceHash,
    draftPath,
    ...(item.readOnly === true ? { readOnly: true } : {})
  }
}

function decodeImportedArtifact(
  item: Record<string, unknown>,
  artifactId: string,
  sessionId: string,
  draftPath: string
): OfficeArtifact {
  const source = item.importSource
  if (
    officeArtifactKind(item) !== 'xlsx' ||
    typeof item.sourcePath !== 'string' ||
    typeof item.sourceHash !== 'string' ||
    !SHA256_PATTERN.test(item.sourceHash) ||
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    throw new Error('invalid imported artifact')
  }
  const metadata = source as Record<string, unknown>
  const format = metadata.format
  const delimiter = metadata.delimiter
  const rows = metadata.rows
  const columns = metadata.columns
  const cells = Number(rows) * Number(columns)
  if (
    typeof metadata.path !== 'string' ||
    metadata.path.length === 0 ||
    (format !== 'csv' && format !== 'tsv') ||
    delimiter !== (format === 'csv' ? ',' : '\t') ||
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    Number(rows) < 0 ||
    Number(columns) < 0 ||
    Number(rows) > OFFICE_IMPORT_LIMITS.maxRows ||
    Number(columns) > OFFICE_IMPORT_LIMITS.maxColumns ||
    cells > OFFICE_IMPORT_LIMITS.maxCells ||
    metadata.sha256 !== item.sourceHash
  ) {
    throw new Error('invalid import metadata')
  }
  return {
    artifactId,
    sessionId,
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    kind: 'xlsx',
    origin: 'import',
    sourcePath: item.sourcePath,
    sourceHash: item.sourceHash,
    importSource: {
      path: metadata.path,
      format,
      delimiter: format === 'csv' ? ',' : '\t',
      rows: Number(rows),
      columns: Number(columns),
      sha256: item.sourceHash
    },
    draftPath,
    ...(item.readOnly === true ? { readOnly: true } : {})
  }
}

async function sourceHash(path: string): Promise<string | undefined> {
  const details = await stat(path)
  if (!details.isFile() || details.size > MAX_HASHABLE_SOURCE_BYTES) return undefined
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export class OfficeDraftRegistry {
  private readonly cache = new Map<string, Promise<readonly RegistryEntry[]>>()

  constructor(private readonly dependencies: OfficeDraftRegistryDependencies = {}) {}

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  async findByArtifactId(
    sessionId: string,
    artifactId: string
  ): Promise<OfficeArtifact | undefined> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return undefined
    const entry = (await this.entries(sessionId)).find(
      ({ artifact }) => artifact.artifactId === artifactId
    )
    return entry?.artifact
  }

  async resolve(input: OfficeDraftLookupInput): Promise<OfficeDraftResolution> {
    await assertRequestedRegisteredKind(input)
    const entries = (await this.entries(input.sessionId)).filter(
      ({ artifact }) => artifact.projectId === input.projectId
    )
    const direct = entries.find(
      ({ artifact }) => pathKey(artifact.draftPath) === pathKey(input.sourcePath)
    )
    if (direct) {
      return {
        kind: 'registered',
        artifact: direct.artifact,
        match: 'draft',
        normalizedSourcePath: direct.artifact.draftPath
      }
    }
    const normalizedSourcePath = await canonicalPath(input.sourcePath)
    if (input.fresh) return { kind: 'none', normalizedSourcePath }
    const candidates = await this.sourceCandidates(entries, normalizedSourcePath)
    if (candidates.length === 0) return { kind: 'none', normalizedSourcePath }
    const hash = await sourceHash(normalizedSourcePath)
    const matched = candidates.find(({ artifact }) => artifact.sourceHash === hash)
    if (matched) {
      return {
        kind: 'registered',
        artifact: matched.artifact,
        match: 'source',
        normalizedSourcePath
      }
    }
    return {
      kind: 'source_changed',
      previousArtifact: candidates[0]!.artifact,
      normalizedSourcePath,
      currentSourceHash: hash
    }
  }

  private entries(sessionId: string): Promise<readonly RegistryEntry[]> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const loading = this.scan(sessionId)
    this.cache.set(sessionId, loading)
    return loading
  }

  private async scan(sessionId: string): Promise<readonly RegistryEntry[]> {
    const root = join(getSessionDir(sessionId), 'artifacts', 'office')
    const directories = await readdir(root, { withFileTypes: true }).catch(() => [])
    const entries = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readEntry(root, entry.name, sessionId))
    )
    return entries
      .filter((entry): entry is RegistryEntry => entry !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private async readEntry(
    root: string,
    name: string,
    sessionId: string
  ): Promise<RegistryEntry | undefined> {
    const directory = join(root, name)
    try {
      const registration = join(directory, 'artifact.json')
      const [body, details] = await Promise.all([
        readFile(registration, 'utf8'),
        stat(registration)
      ])
      return {
        artifact: decodeArtifact(JSON.parse(body), sessionId, directory),
        updatedAt: details.mtimeMs
      }
    } catch {
      this.dependencies.warn?.({ event: 'office_draft_registration_skipped', sessionId })
      return undefined
    }
  }

  private async sourceCandidates(
    entries: readonly RegistryEntry[],
    normalizedSourcePath: string
  ): Promise<readonly RegistryEntry[]> {
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (entry.artifact.origin === 'blank') return undefined
        const source = await canonicalPath(entry.artifact.sourcePath).catch(() => undefined)
        return source && pathKey(source) === pathKey(normalizedSourcePath) ? entry : undefined
      })
    )
    return results.filter((entry): entry is RegistryEntry => entry !== undefined)
  }
}

async function assertRequestedRegisteredKind(input: OfficeDraftLookupInput): Promise<void> {
  const root = join(getSessionDir(input.sessionId), 'artifacts', 'office')
  const requestedPath = resolve(input.sourcePath)
  const artifactDir = dirname(requestedPath)
  if (pathKey(dirname(artifactDir)) !== pathKey(root)) return
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(artifactDir, 'artifact.json'), 'utf8'))
  } catch {
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    typeof record.draftPath !== 'string' ||
    pathKey(record.draftPath) !== pathKey(requestedPath)
  ) {
    return
  }
  try {
    if (officeArtifactKind(record) === officeDocumentKindFromPath(requestedPath)) return
  } catch {
    // Invalid explicit kinds and unsupported extensions are the same authority mismatch.
  }
  throw new OfficeFileError('document_kind_mismatch', 'Office 草稿登记的文档类型与文件扩展名不一致')
}
