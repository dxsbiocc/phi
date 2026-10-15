import { resolve } from 'node:path'
import { rpcIdentifier } from './control-frame'
import { webSearchRecord } from './desktop-websearch-protocol'

export interface ImportedProjectMemory {
  fingerprint: string
  id: string
  model: { provider: string; id: string }
  published?: boolean
}
export interface ProjectMemoryManifest {
  schema: 1
  epoch: number
  clearCutoff: number
  imports: Record<string, ImportedProjectMemory>
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sdkId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)

/** A cache contains identifiers, never filesystem authority. Missing cleared rollouts are valid. */
export function importedMemoryRolloutPath(directory: string, id: string): string {
  if (!sdkId(id)) throw new Error('Invalid imported SDK memory identity')
  return resolve(directory, id + '.jsonl')
}
export function parseProjectMemoryManifest(value: unknown): ProjectMemoryManifest {
  if (
    !webSearchRecord(value) ||
    Object.keys(value).sort().join(',') !== 'clearCutoff,epoch,imports,schema' ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    typeof value.clearCutoff !== 'number' ||
    !Number.isFinite(value.clearCutoff) ||
    value.clearCutoff < 0 ||
    !webSearchRecord(value.imports)
  )
    throw new Error('Invalid memory import manifest')
  const imports: Record<string, ImportedProjectMemory> = Object.create(null)
  for (const [key, raw] of Object.entries(value.imports)) {
    if (
      !hash(key) ||
      !webSearchRecord(raw) ||
      !hash(raw.fingerprint) ||
      !sdkId(raw.id) ||
      Object.keys(raw).some(
        (field) => !['fingerprint', 'id', 'model', 'published'].includes(field)
      ) ||
      !webSearchRecord(raw.model) ||
      Object.keys(raw.model).sort().join(',') !== 'id,provider' ||
      !rpcIdentifier(raw.model.provider) ||
      !rpcIdentifier(raw.model.id) ||
      (raw.published !== undefined && typeof raw.published !== 'boolean')
    )
      throw new Error('Invalid imported memory checkpoint')
    imports[key] = {
      fingerprint: raw.fingerprint,
      id: raw.id,
      model: { provider: raw.model.provider, id: raw.model.id },
      ...(raw.published === undefined ? {} : { published: raw.published })
    }
  }
  return { schema: 1, epoch: Number(value.epoch), clearCutoff: value.clearCutoff, imports }
}
