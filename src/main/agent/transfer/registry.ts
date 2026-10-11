import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

import { DEFAULT_TRANSFER_POLICY } from './types'

export type TransferRegistryStatus = 'active' | 'paused' | 'cancelled' | 'failed'

export type TransferRegistryEntry = Readonly<{
  transferId: string
  hostKey: string
  partialLocator: string
  manifestLocator: string
  status: TransferRegistryStatus
  retainedBytes: number
  createdAt: number
  updatedAt: number
}>

type RegistryDocument = Readonly<{
  version: 1
  entries: readonly TransferRegistryEntry[]
}>

export type RegistryCleanupResult = Readonly<{
  removedTransferIds: readonly string[]
  retainedBytes: number
  quotaBytes: number
}>

const EMPTY_DOCUMENT: RegistryDocument = Object.freeze({ version: 1, entries: Object.freeze([]) })

function parseDocument(value: unknown): RegistryDocument {
  if (typeof value !== 'object' || value === null) return EMPTY_DOCUMENT
  const candidate = value as { version?: unknown; entries?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return EMPTY_DOCUMENT
  const entries = candidate.entries.filter((entry): entry is TransferRegistryEntry => {
    if (typeof entry !== 'object' || entry === null) return false
    const item = entry as Record<string, unknown>
    return (
      typeof item.transferId === 'string' &&
      typeof item.hostKey === 'string' &&
      typeof item.partialLocator === 'string' &&
      typeof item.manifestLocator === 'string' &&
      ['active', 'paused', 'cancelled', 'failed'].includes(String(item.status)) &&
      typeof item.retainedBytes === 'number' &&
      typeof item.createdAt === 'number' &&
      typeof item.updatedAt === 'number'
    )
  })
  return { version: 1, entries }
}

export class FileTransferRegistry {
  private mutation: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async list(): Promise<readonly TransferRegistryEntry[]> {
    try {
      const raw = await readFile(this.path, 'utf8')
      return parseDocument(JSON.parse(raw)).entries.map((entry) => ({ ...entry }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async upsert(entry: TransferRegistryEntry): Promise<void> {
    await this.mutate(async (entries) => [
      ...entries.filter((candidate) => candidate.transferId !== entry.transferId),
      { ...entry }
    ])
  }

  async remove(transferId: string): Promise<void> {
    await this.mutate(async (entries) =>
      entries.filter((candidate) => candidate.transferId !== transferId)
    )
  }

  async cleanupRetained(
    options: Readonly<{
      hostKey: string
      freeBytes?: number
      now?: number
      removeOwned: (entry: TransferRegistryEntry) => Promise<void>
    }>
  ): Promise<RegistryCleanupResult> {
    const now = options.now ?? Date.now()
    const filesystem = options.freeBytes === undefined ? await statfs(dirname(this.path)) : null
    const freeBytes = options.freeBytes ?? Number(filesystem!.bavail) * Number(filesystem!.bsize)
    const quotaBytes = Math.min(
      DEFAULT_TRANSFER_POLICY.retainedPartialHostMaxBytes,
      Math.floor(Math.max(0, freeBytes) * DEFAULT_TRANSFER_POLICY.retainedPartialFreeSpaceFraction)
    )
    const all = await this.list()
    const candidates = all
      .filter((entry) => entry.hostKey === options.hostKey && entry.status !== 'active')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    const expired = new Set(
      candidates
        .filter((entry) => now - entry.updatedAt >= DEFAULT_TRANSFER_POLICY.retainedPartialTtlMs)
        .map((entry) => entry.transferId)
    )
    let retainedBytes = candidates
      .filter((entry) => !expired.has(entry.transferId))
      .reduce((sum, entry) => sum + entry.retainedBytes, 0)
    const removeIds = new Set(expired)
    for (const entry of candidates) {
      if (retainedBytes <= quotaBytes) break
      if (removeIds.has(entry.transferId)) continue
      removeIds.add(entry.transferId)
      retainedBytes -= entry.retainedBytes
    }
    for (const entry of candidates) {
      if (!removeIds.has(entry.transferId)) continue
      await options.removeOwned(entry)
    }
    if (removeIds.size > 0) {
      await this.mutate(async (entries) =>
        entries.filter((entry) => !removeIds.has(entry.transferId))
      )
    }
    return {
      removedTransferIds: [...removeIds],
      retainedBytes,
      quotaBytes
    }
  }

  private async mutate(
    update: (entries: readonly TransferRegistryEntry[]) => Promise<readonly TransferRegistryEntry[]>
  ): Promise<void> {
    const operation = this.mutation.then(async () => {
      const entries = await this.list()
      await this.write({ version: 1, entries: await update(entries) })
    })
    this.mutation = operation.catch(() => undefined)
    await operation
  }

  private async write(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    const metadata = await stat(this.path)
    if (!metadata.isFile()) throw new Error('Transfer registry is not a regular file')
  }
}
