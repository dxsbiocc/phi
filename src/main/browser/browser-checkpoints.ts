import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { BrowserTabSnapshot } from '../../shared/browserTypes'
import { getSessionDir } from '../agent/session/session-store'

export interface BrowserCheckpointTab {
  id: string
  title: string
  url: string
}

export interface BrowserCheckpoint {
  schemaVersion: 1
  tabs: BrowserCheckpointTab[]
  activeTabId: string | null
}

export interface BrowserCheckpointStore {
  load(sessionId: string): BrowserCheckpoint | null
  save(sessionId: string, checkpoint: BrowserCheckpoint): void
  remove(sessionId: string): void
}

export function createBrowserCheckpoint(
  tabs: readonly BrowserTabSnapshot[],
  activeTabId: string | null
): BrowserCheckpoint {
  if (tabs.length > MAX_TABS) throw new Error('Invalid browser checkpoint')
  return canonicalizeBrowserCheckpoint({
    schemaVersion: 1,
    tabs: tabs.map(({ id, title, url }) => ({ id, title, url })),
    activeTabId
  })
}

export function browserCheckpointSignature(checkpoint: BrowserCheckpoint): string {
  return JSON.stringify(checkpoint)
}

export interface FileSystemBrowserCheckpointStoreOptions {
  agentDir?: string
  maxBytes?: number
  now?: () => number
  randomId?: () => string
}

const CHECKPOINT_FILE = 'browser.json'
const DEFAULT_MAX_BYTES = 1024 * 1024
const MAX_TABS = 100
const MAX_ID_BYTES = 256
const MAX_TITLE_BYTES = 4096
const MAX_URL_BYTES = 16 * 1024

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseCheckpoint(value: unknown): BrowserCheckpoint | null {
  if (!record(value) || !exactKeys(value, ['activeTabId', 'schemaVersion', 'tabs'])) return null
  if (value.schemaVersion !== 1 || !Array.isArray(value.tabs) || value.tabs.length > MAX_TABS) {
    return null
  }
  const ids = new Set<string>()
  const tabs: BrowserCheckpointTab[] = []
  for (const item of value.tabs) {
    if (!record(item) || !exactKeys(item, ['id', 'title', 'url'])) return null
    if (
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      byteLength(item.id) > MAX_ID_BYTES ||
      typeof item.title !== 'string' ||
      byteLength(item.title) > MAX_TITLE_BYTES ||
      typeof item.url !== 'string' ||
      !item.url ||
      byteLength(item.url) > MAX_URL_BYTES ||
      ids.has(item.id)
    ) {
      return null
    }
    ids.add(item.id)
    tabs.push({ id: item.id, title: item.title, url: item.url })
  }
  if (
    value.activeTabId !== null &&
    (typeof value.activeTabId !== 'string' || !ids.has(value.activeTabId))
  ) {
    return null
  }
  if (tabs.length === 0 && value.activeTabId !== null) return null
  if (tabs.length > 0 && value.activeTabId === null) return null
  return { schemaVersion: 1, tabs, activeTabId: value.activeTabId }
}

export function canonicalizeBrowserCheckpoint(value: unknown): BrowserCheckpoint {
  const checkpoint = parseCheckpoint(value)
  if (!checkpoint) throw new Error('Invalid browser checkpoint')
  return checkpoint
}

export class FileSystemBrowserCheckpointStore implements BrowserCheckpointStore {
  readonly #agentDir?: string
  readonly #maxBytes: number
  readonly #now: () => number
  readonly #randomId: () => string

  constructor(options: FileSystemBrowserCheckpointStoreOptions = {}) {
    this.#agentDir = options.agentDir
    this.#maxBytes =
      Number.isFinite(options.maxBytes) &&
      Number.isInteger(options.maxBytes) &&
      (options.maxBytes ?? 0) > 0
        ? (options.maxBytes as number)
        : DEFAULT_MAX_BYTES
    this.#now = options.now ?? Date.now
    this.#randomId = options.randomId ?? randomUUID
  }

  load(sessionId: string): BrowserCheckpoint | null {
    const path = this.#path(sessionId)
    try {
      if (statSync(path).size > this.#maxBytes) return this.#quarantine(path)
      const raw = readFileSync(path, 'utf8')
      if (byteLength(raw) > this.#maxBytes) return this.#quarantine(path)
      try {
        return canonicalizeBrowserCheckpoint(JSON.parse(raw))
      } catch {
        return this.#quarantine(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError) return this.#quarantine(path)
      throw error
    }
  }

  save(sessionId: string, checkpoint: BrowserCheckpoint): void {
    const value = canonicalizeBrowserCheckpoint(checkpoint)
    const serialized = `${JSON.stringify(value)}\n`
    if (byteLength(serialized) > this.#maxBytes) {
      throw new Error('Browser checkpoint is too large')
    }
    const dir = getSessionDir(sessionId, this.#agentDir)
    const path = join(dir, CHECKPOINT_FILE)
    const temporaryPath = `${path}.tmp-${process.pid}-${this.#randomId()}`
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, path)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }

  remove(sessionId: string): void {
    rmSync(this.#path(sessionId), { force: true })
  }

  #path(sessionId: string): string {
    return join(getSessionDir(sessionId, this.#agentDir), CHECKPOINT_FILE)
  }

  #quarantine(path: string): null {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = `${path}.corrupt-${this.#now()}-${this.#randomId()}`
      try {
        linkSync(path, target)
        rmSync(path, { force: true })
        return null
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return null
        if (code !== 'EEXIST') throw error
      }
    }
    throw new Error('Unable to quarantine browser checkpoint')
  }
}
