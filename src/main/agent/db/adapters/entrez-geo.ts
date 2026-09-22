import type { DbDownloadFileCandidate } from '../manifest-types'
import {
  firstString,
  isRecord,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings
} from './entrez-utils'

interface GeoSampleDetails {
  accession?: string
  title?: string
}

interface GeoDownloadUrls {
  series_ftp: string
  series_https: string
  matrix_dir: string
  matrix: string
  soft_dir: string
  soft_family: string
  miniml_dir: string
  miniml_family: string
  supplementary_dir: string
  raw_tar: string
}

export interface GeoDirectoryListingRequest {
  kind: 'matrix' | 'soft' | 'miniml' | 'supplementary'
  url: string
}

interface GeoDownloadFile extends DbDownloadFileCandidate {
  label: string
  accession: string
  format: string
  source: 'derived_from_gse_accession' | 'geo_directory_listing'
}

interface GeoFetchDetails {
  uid?: string
  accession?: string
  title?: string
  fetch_summary?: string
  organism?: string
  entry_type?: string
  gds_type?: string
  series_accession?: string
  platform_accession?: string
  dataset_accession?: string
  sample_accessions?: string[]
  sample_count?: number
  ftp_link?: string
  download_urls?: GeoDownloadUrls
  download_files?: GeoDownloadFile[]
}

export function addGeoFetchDetails(
  rows: Record<string, unknown>[],
  text: string
): Record<string, unknown>[] {
  const details = parseGeoFetchText(text)
  return rows.map((row) => {
    const match = lookupGeoDetails(row, details)
    return match ? mergeGeoDetails(row, match) : row
  })
}

function lookupGeoDetails(
  row: Record<string, unknown>,
  details: Map<string, GeoFetchDetails>
): GeoFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.series_accession),
    firstString(row.platform_accession),
    firstString(row.dataset_accession),
    ...(Array.isArray(row.sample_accessions)
      ? row.sample_accessions.filter((item): item is string => typeof item === 'string')
      : [])
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeGeoDetails(
  row: Record<string, unknown>,
  details: GeoFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'sample_accessions') {
        const existing = Array.isArray(merged.sample_accessions)
          ? merged.sample_accessions.filter((item): item is string => typeof item === 'string')
          : []
        const sampleAccessions = uniqueStrings([...existing, ...value])
        if (sampleAccessions.length > 0) merged.sample_accessions = sampleAccessions
        continue
      }
      if (merged[key] === undefined || merged[key] === '') merged[key] = value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseGeoFetchText(text: string): Map<string, GeoFetchDetails> {
  const details = new Map<string, GeoFetchDetails>()
  for (const record of geoTextRecords(text)) {
    const parsed = parseGeoTextRecord(record)
    for (const key of geoDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function geoTextRecords(text: string): string[] {
  const matches = [...text.matchAll(/(^|\n)\d+\.\s+/g)]
  if (matches.length === 0) return text.trim() ? [text.trim()] : []
  return matches
    .map((match, index) => {
      const start = match.index + (match[1] ? 1 : 0)
      const end = matches[index + 1]?.index ?? text.length
      return text.slice(start, end).trim()
    })
    .filter(Boolean)
}

function parseGeoTextRecord(record: string): GeoFetchDetails {
  const firstLine = record
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  const title = firstLine?.replace(/^\d+\.\s+/, '').trim()
  const accession = geoTextAccession(record)
  const details: GeoFetchDetails = {
    uid: record.match(/\bID:\s*(\d+)\b/)?.[1],
    accession,
    title,
    fetch_summary: geoTextSummary(record),
    organism: geoTextValue(record, 'Organism'),
    gds_type: geoTextValue(record, 'Type'),
    platform_accession: geoTextPlatformAccession(record),
    sample_count: geoTextSampleCount(record),
    ftp_link: record.match(/FTP download:\s*(?:GEO\s*)?(ftp:\/\/\S+)/i)?.[1]
  }
  addGeoAccessionLinks(details, accession)
  addGeoDownloadUrls(details, details.series_accession ?? accession)
  return details
}

function geoDetailKeys(details: GeoFetchDetails): string[] {
  return uniqueStrings(
    [
      details.uid,
      details.accession,
      details.series_accession,
      details.platform_accession,
      details.dataset_accession,
      ...(details.sample_accessions ?? [])
    ].filter(Boolean) as string[]
  )
}

function addGeoAccessionLinks(details: GeoFetchDetails, accession: string | undefined): void {
  const prefix = geoAccessionPrefix(accession)
  if (!prefix || !accession) return
  details.entry_type ??= prefix
  if (prefix === 'GSE') details.series_accession ??= accession
  if (prefix === 'GPL') details.platform_accession ??= accession
  if (prefix === 'GDS') details.dataset_accession ??= accession
  if (prefix === 'GSM') details.sample_accessions = uniqueStrings([accession])
}

export function addGeoDownloadUrls(
  details: GeoFetchDetails | Record<string, unknown>,
  accession: string | undefined
): void {
  const downloadUrls = geoSeriesDownloadUrls(accession)
  if (!downloadUrls) return
  details.download_urls ??= downloadUrls
  details.download_files ??= geoSeriesDownloadFiles(downloadUrls, accession)
}

export function geoDirectoryListingRequests(
  row: Record<string, unknown>
): GeoDirectoryListingRequest[] {
  const urls = isRecord(row.download_urls) ? row.download_urls : {}
  const requests: GeoDirectoryListingRequest[] = []
  const matrix = firstString(urls.matrix_dir)
  const soft = firstString(urls.soft_dir)
  const miniml = firstString(urls.miniml_dir)
  const supplementary = firstString(urls.supplementary_dir)
  if (matrix) requests.push({ kind: 'matrix', url: matrix })
  if (soft) requests.push({ kind: 'soft', url: soft })
  if (miniml) requests.push({ kind: 'miniml', url: miniml })
  if (supplementary) requests.push({ kind: 'supplementary', url: supplementary })
  return requests
}

export function addGeoDirectoryListingDownloadFiles(
  row: Record<string, unknown>,
  request: GeoDirectoryListingRequest,
  html: string
): Record<string, unknown> {
  const accession = firstString(row.series_accession, row.accession)?.toUpperCase()
  if (!accession) return row
  const listedFiles = geoDirectoryListingDownloadFiles(html, request, accession)
  if (listedFiles.length === 0) return row

  const existing = Array.isArray(row.download_files)
    ? row.download_files.filter((candidate): candidate is DbDownloadFileCandidate =>
        isRecord(candidate)
      )
    : []
  const merged = [...existing]
  const urlIndexes = new Map<string, number>()
  merged.forEach((candidate, index) => {
    const url = firstString(candidate.url)
    if (url) urlIndexes.set(url, index)
  })
  for (const file of listedFiles) {
    const existingIndex = urlIndexes.get(file.url)
    if (existingIndex !== undefined) {
      merged[existingIndex] = { ...merged[existingIndex], ...file }
      continue
    }
    urlIndexes.set(file.url, merged.length)
    merged.push(file)
  }
  return { ...row, download_files: merged }
}

function geoSeriesDownloadUrls(accession: string | undefined): GeoDownloadUrls | undefined {
  const series = accession?.match(/^(GSE)(\d+)$/i)
  if (!series) return undefined
  const gse = `${series[1].toUpperCase()}${series[2]}`
  const bucket = geoSeriesBucket(gse)
  const seriesPath = `/geo/series/${bucket}/${gse}`
  const ftpBase = `ftp://ftp.ncbi.nlm.nih.gov${seriesPath}`
  const httpsBase = `https://ftp.ncbi.nlm.nih.gov${seriesPath}`
  return {
    series_ftp: `${ftpBase}/`,
    series_https: `${httpsBase}/`,
    matrix_dir: `${httpsBase}/matrix/`,
    matrix: `${httpsBase}/matrix/${gse}_series_matrix.txt.gz`,
    soft_dir: `${httpsBase}/soft/`,
    soft_family: `${httpsBase}/soft/${gse}_family.soft.gz`,
    miniml_dir: `${httpsBase}/miniml/`,
    miniml_family: `${httpsBase}/miniml/${gse}_family.xml.tgz`,
    supplementary_dir: `${httpsBase}/suppl/`,
    raw_tar: `${httpsBase}/suppl/${gse}_RAW.tar`
  }
}

function geoSeriesDownloadFiles(
  urls: GeoDownloadUrls,
  accession: string | undefined
): GeoDownloadFile[] {
  const seriesAccession = accession?.toUpperCase() ?? ''
  return [
    {
      kind: 'series_matrix',
      label: 'Series Matrix',
      accession: seriesAccession,
      url: urls.matrix,
      format: 'txt',
      compression: 'gzip',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'series_matrix_directory',
      label: 'Series Matrix Directory',
      accession: seriesAccession,
      url: urls.matrix_dir,
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'soft_family',
      label: 'SOFT Family',
      accession: seriesAccession,
      url: urls.soft_family,
      format: 'soft',
      compression: 'gzip',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'miniml_family',
      label: 'MINiML Family',
      accession: seriesAccession,
      url: urls.miniml_family,
      format: 'xml',
      compression: 'tgz',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'supplementary_directory',
      label: 'Supplementary Directory',
      accession: seriesAccession,
      url: urls.supplementary_dir,
      format: 'directory',
      availability: 'directory',
      source: 'derived_from_gse_accession'
    },
    {
      kind: 'raw_tar',
      label: 'Raw Supplementary Archive',
      accession: seriesAccession,
      url: urls.raw_tar,
      format: 'tar',
      availability: 'candidate_file',
      source: 'derived_from_gse_accession'
    }
  ]
}

function geoDirectoryListingDownloadFiles(
  html: string,
  request: GeoDirectoryListingRequest,
  accession: string
): GeoDownloadFile[] {
  return geoDirectoryListingEntries(html, request.url).flatMap((entry) => {
    const file = geoDirectoryEntryDownloadFile(entry, request.kind, accession)
    return file ? [file] : []
  })
}

interface GeoDirectoryListingEntry {
  filename: string
  url: string
  size?: number
}

function geoDirectoryListingEntries(
  html: string,
  directoryUrl: string
): GeoDirectoryListingEntry[] {
  const entries: GeoDirectoryListingEntry[] = []
  for (const line of html.split(/\r?\n/)) {
    const href = line.match(/<a\s+href="([^"]+)"/i)?.[1]
    if (!href || href.startsWith('/') || href.startsWith('?') || href === '../') continue
    if (/parent directory/i.test(line)) continue
    const filename = normalizeXmlText(href)
    if (!filename || filename.endsWith('/')) continue
    const size = parseDirectorySize(
      line.match(/<\/a>\s*(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})?\s*([0-9.]+\s*[KMGT]?|-)\s*$/i)?.[1]
    )
    entries.push({
      filename,
      url: new URL(href, directoryUrl).toString(),
      ...(size === undefined ? {} : { size })
    })
  }
  return entries
}

function geoDirectoryEntryDownloadFile(
  entry: GeoDirectoryListingEntry,
  directoryKind: GeoDirectoryListingRequest['kind'],
  accession: string
): GeoDownloadFile | undefined {
  const filename = entry.filename
  const format = geoFileFormat(filename)
  const compression = geoFileCompression(filename)
  const base = {
    accession,
    url: entry.url,
    filename,
    format,
    ...(compression ? { compression } : {}),
    ...(entry.size === undefined ? {} : { size: entry.size }),
    availability: 'direct_url' as const,
    source: 'geo_directory_listing' as const
  }

  if (directoryKind === 'matrix') {
    return {
      ...base,
      kind: filename.match(/_series_matrix\.txt\.gz$/i) ? 'series_matrix' : 'series_matrix_file',
      label: 'Series Matrix'
    }
  }
  if (directoryKind === 'soft') {
    return {
      ...base,
      kind: filename.match(/_family\.soft\.gz$/i) ? 'soft_family' : 'soft_file',
      label: 'SOFT Family'
    }
  }
  if (directoryKind === 'miniml') {
    return {
      ...base,
      kind: filename.match(/_family\.xml\.tgz$/i) ? 'miniml_family' : 'miniml_file',
      label: 'MINiML Family'
    }
  }
  return {
    ...base,
    kind: filename.match(/_RAW\.tar$/i) ? 'raw_tar' : 'supplementary_file',
    label: filename.match(/_RAW\.tar$/i) ? 'Raw Supplementary Archive' : 'Supplementary File'
  }
}

function geoFileCompression(filename: string): string | undefined {
  if (filename.match(/\.tgz$/i)) return 'tgz'
  if (filename.match(/\.tar\.gz$/i)) return 'gzip'
  if (filename.match(/\.gz$/i)) return 'gzip'
  if (filename.match(/\.zip$/i)) return 'zip'
  return undefined
}

function geoFileFormat(filename: string): string {
  const withoutCompression = filename
    .replace(/\.tar\.gz$/i, '.tar')
    .replace(/\.tgz$/i, '.xml')
    .replace(/\.(?:gz|zip)$/i, '')
  const match = withoutCompression.match(/\.([A-Za-z0-9]+)$/)
  return match?.[1]?.toLowerCase() ?? 'file'
}

function parseDirectorySize(value: string | undefined): number | undefined {
  const text = value?.trim()
  if (!text || text === '-') return undefined
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT])?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2]?.toUpperCase()
  const multiplier =
    unit === 'T'
      ? 1024 ** 4
      : unit === 'G'
        ? 1024 ** 3
        : unit === 'M'
          ? 1024 ** 2
          : unit === 'K'
            ? 1024
            : 1
  return Math.round(amount * multiplier)
}

function geoSeriesBucket(accession: string): string {
  return accession.replace(/\d{1,3}$/, 'nnn')
}

function geoTextAccession(record: string): string | undefined {
  return record.match(/\bAccession:\s*((?:GSE|GSM|GPL|GDS)\d+)\b/i)?.[1]?.toUpperCase()
}

function geoTextPlatformAccession(record: string): string | undefined {
  return record.match(/\bPlatform:\s*((?:GPL)\d+)\b/i)?.[1]?.toUpperCase()
}

function geoTextSampleCount(record: string): number | undefined {
  return parseOptionalNumber(record.match(/\bPlatform:.*?\b(\d+)\s+Samples?\b/i)?.[1])
}

function geoTextValue(record: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = record.match(new RegExp(`(?:^|\\n)${escaped}:\\s*([^\\n]+)`, 'i'))
  return match ? normalizeXmlText(match[1]) : undefined
}

function geoTextSummary(record: string): string | undefined {
  const lines = record
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const summaryLines: string[] = []
  for (const line of lines.slice(1)) {
    if (/^(Organism|Type|Platform|FTP download|Series|DataSet|Dataset|Sample)\b/i.test(line)) {
      break
    }
    summaryLines.push(line)
  }
  const summary = summaryLines.join(' ')
  return summary ? normalizeXmlText(summary) : undefined
}

export function prefixedGeoAccession(
  prefix: 'GSE' | 'GSM' | 'GPL' | 'GDS',
  value: unknown
): string | undefined {
  const raw = firstString(value)?.trim()
  if (!raw) return undefined
  const upper = raw.toUpperCase()
  if (upper.startsWith(prefix)) return upper
  return /^\d+$/.test(raw) ? `${prefix}${raw}` : raw
}

function geoAccessionPrefix(
  accession: string | undefined
): 'GSE' | 'GSM' | 'GPL' | 'GDS' | undefined {
  return accession?.match(/^(GSE|GSM|GPL|GDS)\d+$/i)?.[1]?.toUpperCase() as
    'GSE' | 'GSM' | 'GPL' | 'GDS' | undefined
}

export function geoSamplesFromSummary(value: unknown): GeoSampleDetails[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): GeoSampleDetails | undefined => {
      if (typeof item === 'string') return { accession: item }
      if (!isRecord(item)) return undefined
      const accession = firstString(item.accession)
      const title = firstString(item.title)
      return accession || title ? { accession, title } : undefined
    })
    .filter((item): item is GeoSampleDetails => item !== undefined)
}

export function geoStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(
      value.map((item) => firstString(item)).filter((item): item is string => item !== undefined)
    )
  }
  if (typeof value === 'string') {
    return uniqueStrings(value.split(/[,;]/).map((item) => item.trim()))
  }
  return []
}

export function parseGeoBoolean(value: unknown): boolean | undefined {
  const text = firstString(value)?.toLowerCase()
  if (text === 'yes' || text === 'true' || text === '1') return true
  if (text === 'no' || text === 'false' || text === '0') return false
  return undefined
}
