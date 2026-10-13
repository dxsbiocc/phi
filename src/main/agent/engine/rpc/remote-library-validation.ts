import type { LibraryIndex, SavedPaper } from '../../library/library-types'
import {
  REMOTE_LIBRARY_MAX_INDEX_BYTES,
  REMOTE_LIBRARY_MAX_PAPER_BYTES,
  RemoteLibraryError
} from './remote-library-types'

function fail(): never {
  throw new RemoteLibraryError('FILE_INVALID', 'Remote literature library metadata is invalid')
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= 10000 && value.every((item) => typeof item === 'string')
  )
}
function entries(value: unknown, fields: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every(
      (item) =>
        record(item) &&
        Object.keys(item).every((field) => fields.includes(field)) &&
        fields.every((field) => typeof item[field] === 'string')
    )
  )
}
export function validLibraryStorageKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}-[a-f0-9]{12}$/.test(value)
}
export function validateRemoteLibraryIndex(value: unknown): LibraryIndex {
  if (
    !record(value) ||
    Object.keys(value).some(
      (field) => !['schemaVersion', 'createdAt', 'updatedAt', 'papers'].includes(field)
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.papers) ||
    value.papers.length > 10000
  )
    fail()
  for (const paper of value.papers) {
    if (
      !record(paper) ||
      Object.keys(paper).some(
        (field) =>
          ![
            'canonicalId',
            'storageKey',
            'aliases',
            'source',
            'sourceId',
            'title',
            'authors',
            'abstract',
            'doi',
            'identifiers',
            'links',
            'priorityTier',
            'processingStage',
            'tags',
            'notes',
            'collectionId',
            'provenance',
            'xrefs',
            'savedAt',
            'updatedAt',
            'revision',
            'fullTextStatus'
          ].includes(field)
      ) ||
      !validLibraryStorageKey(paper.storageKey) ||
      !['canonicalId', 'source', 'title', 'savedAt', 'updatedAt'].every(
        (field) => typeof paper[field] === 'string'
      ) ||
      !strings(paper.aliases) ||
      !strings(paper.authors) ||
      !strings(paper.tags) ||
      !entries(paper.identifiers, ['kind', 'value']) ||
      !entries(paper.links, ['kind', 'url']) ||
      !entries(paper.xrefs, ['targetId', 'relation']) ||
      !Number.isSafeInteger(paper.revision) ||
      Number(paper.revision) < 1 ||
      typeof paper.priorityTier !== 'string' ||
      !['must', 'weekly', 'radar', 'drop'].includes(paper.priorityTier) ||
      typeof paper.processingStage !== 'string' ||
      !['discovered', 'skimmed', 'deep_read', 'synthesized'].includes(paper.processingStage) ||
      typeof paper.fullTextStatus !== 'string' ||
      !['available', 'unavailable', 'not_attempted'].includes(paper.fullTextStatus) ||
      typeof paper.provenance !== 'string' ||
      !['manual', 'auto'].includes(paper.provenance) ||
      ['sourceId', 'abstract', 'doi', 'notes', 'collectionId'].some(
        (field) => paper[field] !== undefined && typeof paper[field] !== 'string'
      )
    )
      fail()
    if (Buffer.byteLength(JSON.stringify(paper)) > REMOTE_LIBRARY_MAX_PAPER_BYTES)
      throw new RemoteLibraryError('LIMIT_EXCEEDED', 'One remote library paper exceeds 512 KiB')
  }
  if (Buffer.byteLength(JSON.stringify(value)) > REMOTE_LIBRARY_MAX_INDEX_BYTES)
    throw new RemoteLibraryError('LIMIT_EXCEEDED', 'Remote literature library index exceeds 4 MiB')
  return value as unknown as LibraryIndex
}
export function paperProjection(paper: SavedPaper): Buffer {
  return Buffer.from(`${JSON.stringify(paper, null, 2)}\n`)
}
