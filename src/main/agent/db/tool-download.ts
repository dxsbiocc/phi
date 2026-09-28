import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { readAppSettings } from '../app-settings'
import { transferFile } from '../download/file-transfer'
import { getDbProxyTransport } from './egress-transport'
import { findDbConnectorCatalogEntry } from './catalog'
import { DbHttpError, executeDbHttpRequest, type DbEgressTransport, type DbSleep } from './policy'
import { getDbConnectorResultsDir } from './store'
import type {
  DbConnectorManifest,
  DbDownloadFileCandidate,
  DbDownloadSkippedFile,
  DbDownloadToolDetails,
  DbDownloadedFile
} from './manifest-types'

interface DbDownloadToolOptions {
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  timeoutMs?: number
  now?: () => Date
}

interface DownloadManifestRow {
  rowIndex: number
  accession?: string
  title?: string
  download_files: DbDownloadFileCandidate[]
}

interface DownloadManifest {
  kind: 'db_query_download_manifest'
  provenance: {
    database: string
    domain: string
    retrievedAt: string
  }
  rows: DownloadManifestRow[]
}

interface DownloadEntry {
  rowIndex: number
  accession?: string
  kind?: string
  url: string
  filename: string
  candidate: DbDownloadFileCandidate
}

const DEFAULT_MAX_FILES = 20
const MAX_FILES = 100
const DEFAULT_MAX_FILE_BYTES = 250 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numericParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringSet(value: unknown): Set<string> | undefined {
  const values = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : typeof value === 'string' && value.trim()
      ? value.split(',').map((item) => item.trim())
      : []
  return values.length > 0 ? new Set(values) : undefined
}

function numberSet(value: unknown): Set<number> | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is number => Number.isInteger(item) && item >= 0)
  return values.length > 0 ? new Set(values) : undefined
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = numericParam(value)
  if (numeric === undefined) return fallback
  return Math.min(Math.max(min, Math.floor(numeric)), max)
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function safeDownloadFilename(value: string, fallback: string): string {
  const filename = [...value]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '_' : char))
    .join('')
    .replace(/^\.+$/, '')
    .trim()
  return filename || fallback
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const filename = basename(decodeURIComponent(new URL(url).pathname))
    return filename && filename !== '/' ? filename : undefined
  } catch {
    return undefined
  }
}

function uniqueFilename(filename: string, seen: Map<string, number>): string {
  const count = seen.get(filename) ?? 0
  seen.set(filename, count + 1)
  if (count === 0) return filename
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return `${filename}-${count + 1}`
  return `${filename.slice(0, dot)}-${count + 1}${filename.slice(dot)}`
}

function readDownloadManifest(path: string, agentDir: string): DownloadManifest {
  const manifestPath = resolve(path)
  const allowedRoot = resolve(getDbConnectorResultsDir(agentDir))
  if (!pathInside(manifestPath, allowedRoot)) {
    throw new Error(`download manifest must be under ${allowedRoot}`)
  }

  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown
  if (!isRecord(parsed) || parsed.kind !== 'db_query_download_manifest') {
    throw new Error('file is not a db_query download manifest')
  }
  if (!isRecord(parsed.provenance) || typeof parsed.provenance.database !== 'string') {
    throw new Error('download manifest is missing database provenance')
  }
  if (!Array.isArray(parsed.rows)) {
    throw new Error('download manifest is missing rows')
  }
  return {
    kind: 'db_query_download_manifest',
    provenance: {
      database: parsed.provenance.database,
      domain: typeof parsed.provenance.domain === 'string' ? parsed.provenance.domain : '',
      retrievedAt:
        typeof parsed.provenance.retrievedAt === 'string' ? parsed.provenance.retrievedAt : ''
    },
    rows: parsed.rows.filter(isDownloadManifestRow)
  }
}

function isDownloadManifestRow(value: unknown): value is DownloadManifestRow {
  return isRecord(value) && Array.isArray(value.download_files)
}

function matchesFilters(
  entry: DownloadEntry,
  filters: {
    kinds?: Set<string>
    accessions?: Set<string>
    rowIndexes?: Set<number>
  }
): boolean {
  if (filters.kinds && (!entry.kind || !filters.kinds.has(entry.kind))) return false
  if (filters.accessions && (!entry.accession || !filters.accessions.has(entry.accession))) {
    return false
  }
  if (filters.rowIndexes && !filters.rowIndexes.has(entry.rowIndex)) return false
  return true
}

function directDownloadEntries(
  manifest: DownloadManifest,
  filters: {
    kinds?: Set<string>
    accessions?: Set<string>
    rowIndexes?: Set<number>
  }
): { entries: DownloadEntry[]; skipped: DbDownloadSkippedFile[] } {
  const entries: DownloadEntry[] = []
  const skipped: DbDownloadSkippedFile[] = []
  const filenames = new Map<string, number>()

  manifest.rows.forEach((row, rowArrayIndex) => {
    const rowIndex = row.rowIndex ?? rowArrayIndex
    const accession = row.accession
    for (const candidate of row.download_files) {
      const kind = stringParam(candidate.kind)
      const url = stringParam(candidate.url)
      if (candidate.availability !== 'direct_url') {
        skipped.push({ rowIndex, accession, kind, url, reason: 'not_direct_url' })
        continue
      }
      if (!url) {
        skipped.push({ rowIndex, accession, kind, reason: 'missing_url' })
        continue
      }
      const fallback = `${accession ?? `row-${rowIndex + 1}`}-download-${entries.length + 1}`
      const filename = uniqueFilename(
        safeDownloadFilename(
          stringParam(candidate.filename) ?? filenameFromUrl(url) ?? fallback,
          fallback
        ),
        filenames
      )
      const entry = { rowIndex, accession, kind, url, filename, candidate }
      if (!matchesFilters(entry, filters)) {
        skipped.push({ rowIndex, accession, kind, url, reason: 'filtered_out' })
        continue
      }
      entries.push(entry)
    }
  })

  return { entries, skipped }
}

function downloadRequestManifest(
  manifest: DownloadManifest,
  agentDir: string,
  url: URL
): DbConnectorManifest {
  const sourceEntry = findDbConnectorCatalogEntry(manifest.provenance.database, agentDir)
  if (sourceEntry) {
    return {
      ...sourceEntry.manifest,
      baseUrl: `${url.origin}/`,
      auth: { type: 'none' }
    }
  }
  return {
    phiDbConnectorVersion: 1,
    id: `${manifest.provenance.database}/download`,
    name: 'Database Download',
    protocolFamily: 'generic-http',
    curationTier: 'curated',
    baseUrl: `${url.origin}/`,
    networkPolicy: {
      allowedHosts: [url.hostname],
      allowRedirects: true
    },
    auth: { type: 'none' },
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000
    },
    domains: []
  }
}

function statusFor(
  details: Omit<DbDownloadToolDetails, 'status'>
): DbDownloadToolDetails['status'] {
  if (details.downloadedCount === details.requestedCount && details.requestedCount > 0) {
    return 'complete'
  }
  if (details.downloadedCount > 0) return 'partial'
  if (details.failedCount > 0) return 'failed'
  return 'empty'
}

function errorMessage(error: unknown): string {
  if (error instanceof DbHttpError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export function buildDbDownloadTool(
  agentDir: string,
  options: DbDownloadToolOptions = {}
): CustomTool {
  return {
    name: 'db_download',
    label: 'Download Database Files',
    description:
      'Download direct_url files from a db_query download_manifest_json artifact into controlled DB artifacts storage. Use this instead of bash/curl when Database needs to fetch GEO supplementary files, Series Matrix files, or other direct database files. This tool only accepts a manifest path produced by db_query and skips candidate_file, directory, and landing_page entries.',
    parameters: {
      type: 'object',
      required: ['manifestPath'],
      properties: {
        manifestPath: { type: 'string' },
        maxFiles: { type: 'integer', default: DEFAULT_MAX_FILES, minimum: 1, maximum: MAX_FILES },
        maxFileBytes: {
          type: 'integer',
          default: DEFAULT_MAX_FILE_BYTES,
          minimum: 1,
          maximum: MAX_FILE_BYTES
        },
        kinds: { type: 'array', items: { type: 'string' } },
        accessions: { type: 'array', items: { type: 'string' } },
        rowIndexes: { type: 'array', items: { type: 'integer' } }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const record = isRecord(params) ? params : {}
      const manifestPath = stringParam(record.manifestPath)
      if (!manifestPath) {
        return {
          content: [{ type: 'text', text: 'manifestPath is required' }],
          isError: true,
          details: {
            kind: 'db_download_result',
            status: 'failed',
            manifestPath: '',
            outputDir: '',
            requestedCount: 0,
            downloadedCount: 0,
            skippedCount: 0,
            failedCount: 1,
            files: [],
            skipped: [],
            failures: [{ reason: 'missing_manifestPath' }]
          } satisfies DbDownloadToolDetails
        }
      }

      try {
        const resolvedManifestPath = resolve(manifestPath)
        const manifest = readDownloadManifest(resolvedManifestPath, agentDir)
        const outputDir = join(dirname(resolvedManifestPath), 'downloads')
        ensureDir(outputDir)
        const maxFiles = clampInteger(record.maxFiles, DEFAULT_MAX_FILES, 1, MAX_FILES)
        const maxFileBytes = clampInteger(
          record.maxFileBytes,
          DEFAULT_MAX_FILE_BYTES,
          1,
          MAX_FILE_BYTES
        )
        const { entries, skipped } = directDownloadEntries(manifest, {
          kinds: stringSet(record.kinds),
          accessions: stringSet(record.accessions),
          rowIndexes: numberSet(record.rowIndexes)
        })
        const selectedEntries = entries.slice(0, maxFiles)
        for (const entry of entries.slice(maxFiles)) {
          skipped.push({
            rowIndex: entry.rowIndex,
            accession: entry.accession,
            kind: entry.kind,
            url: entry.url,
            reason: 'maxFiles_exceeded'
          })
        }

        const settings = readAppSettings(agentDir)
        const files: DbDownloadedFile[] = []
        const failures: DbDownloadSkippedFile[] = []
        for (const entry of selectedEntries) {
          const outputPath = join(outputDir, entry.filename)
          const declaredSize =
            typeof entry.candidate.size === 'number' && Number.isFinite(entry.candidate.size)
              ? entry.candidate.size
              : undefined
          if (declaredSize !== undefined && declaredSize > maxFileBytes) {
            failures.push({
              rowIndex: entry.rowIndex,
              accession: entry.accession,
              kind: entry.kind,
              url: entry.url,
              reason: `declared size ${declaredSize} exceeds maxFileBytes ${maxFileBytes}`
            })
            continue
          }
          try {
            const url = new URL(entry.url)
            let lastProgress = 0
            const transferred = await transferFile({
              url: entry.url,
              destination: outputPath,
              maxBytes: maxFileBytes,
              signal,
              ...(options.sleep ? { sleep: options.sleep } : {}),
              onProgress(bytes, totalBytes) {
                if (bytes - lastProgress < 1024 * 1024 && bytes !== totalBytes) return
                lastProgress = bytes
                onUpdate?.({
                  content: [
                    {
                      type: 'text',
                      text: `${entry.filename}: ${bytes}${totalBytes ? ` / ${totalBytes}` : ''} bytes`
                    }
                  ]
                })
              },
              request: async (headers, requestSignal) => {
                const result = await executeDbHttpRequest({
                  manifest: downloadRequestManifest(manifest, agentDir, url),
                  path: entry.url,
                  method: 'GET',
                  headers,
                  defaultProxyMode: settings.defaultProxyMode,
                  transport: options.transport,
                  proxyTransport: options.proxyTransport ?? getDbProxyTransport(),
                  sleep: options.sleep,
                  timeoutMs: options.timeoutMs,
                  maxResponseBytes: maxFileBytes,
                  streamResponse: true,
                  cacheTtlMs: 0,
                  signal: requestSignal,
                  idempotent: true
                })
                return result.response
              }
            })
            files.push({
              rowIndex: entry.rowIndex,
              ...(entry.accession ? { accession: entry.accession } : {}),
              ...(entry.kind ? { kind: entry.kind } : {}),
              url: entry.url,
              sourcePath: resolvedManifestPath,
              path: outputPath,
              filename: entry.filename,
              bytes: transferred.bytes,
              sha256: transferred.sha256
            })
            onUpdate?.({
              content: [
                {
                  type: 'text',
                  text: `Downloaded ${files.length}/${selectedEntries.length}: ${entry.filename}`
                }
              ]
            })
          } catch (error) {
            failures.push({
              rowIndex: entry.rowIndex,
              accession: entry.accession,
              kind: entry.kind,
              url: entry.url,
              reason: errorMessage(error)
            })
          }
        }

        const baseDetails = {
          kind: 'db_download_result' as const,
          manifestPath: resolvedManifestPath,
          outputDir,
          requestedCount: selectedEntries.length,
          downloadedCount: files.length,
          skippedCount: skipped.length,
          failedCount: failures.length,
          files,
          skipped,
          failures
        }
        const details: DbDownloadToolDetails = {
          ...baseDetails,
          status: statusFor(baseDetails)
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
          details,
          ...(details.status === 'failed' ? { isError: true as const } : {})
        }
      } catch (error) {
        const details: DbDownloadToolDetails = {
          kind: 'db_download_result',
          status: 'failed',
          manifestPath: resolve(manifestPath),
          outputDir: '',
          requestedCount: 0,
          downloadedCount: 0,
          skippedCount: 0,
          failedCount: 1,
          files: [],
          skipped: [],
          failures: [{ reason: errorMessage(error) }]
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
          isError: true,
          details
        }
      }
    }
  }
}
