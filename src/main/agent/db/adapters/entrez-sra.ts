import type { DbDownloadFileCandidate } from '../manifest-types'
import {
  firstString,
  normalizeXmlText,
  parseOptionalNumber,
  uniqueStrings,
  xmlAttr
} from './entrez-utils'

interface SraRunDetails {
  accession?: string
  total_spots?: number
  total_bases?: number
  size?: number
  published?: string
}

type SraDownloadFile = DbDownloadFileCandidate

interface SraFetchDetails {
  accession?: string
  title?: string
  study_accession?: string
  experiment_accession?: string
  sample_accession?: string
  biosample_accession?: string
  bioproject_accession?: string
  organism?: string
  tax_id?: number
  platform?: string
  instrument_model?: string
  library_strategy?: string
  library_source?: string
  library_selection?: string
  library_layout?: string
  run_accessions?: string[]
  runs?: SraRunDetails[]
  download_urls?: Record<string, Record<string, string>>
  download_files?: SraDownloadFile[]
}

export function addSraFetchDetails(
  rows: Record<string, unknown>[],
  xml: string
): Record<string, unknown>[] {
  const details = parseSraFetchXml(xml)
  return rows.map((row) => {
    const match = lookupSraDetails(row, details)
    return match ? mergeSraDetails(row, match) : row
  })
}

function lookupSraDetails(
  row: Record<string, unknown>,
  details: Map<string, SraFetchDetails>
): SraFetchDetails | undefined {
  const candidates = [
    firstString(row.uid),
    firstString(row.accession),
    firstString(row.study_accession),
    firstString(row.experiment_accession),
    firstString(row.sample_accession),
    firstString(row.biosample_accession),
    ...(Array.isArray(row.run_accessions)
      ? row.run_accessions.filter((item): item is string => typeof item === 'string')
      : [])
  ].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const match = details.get(candidate)
    if (match) return match
  }
  return undefined
}

function mergeSraDetails(
  row: Record<string, unknown>,
  details: SraFetchDetails
): Record<string, unknown> {
  const merged = { ...row }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (key === 'run_accessions') {
        const existing = Array.isArray(merged.run_accessions)
          ? merged.run_accessions.filter((item): item is string => typeof item === 'string')
          : []
        const runAccessions = uniqueStrings([...existing, ...value])
        if (runAccessions.length > 0) merged.run_accessions = runAccessions
        continue
      }
      if (merged[key] === undefined || merged[key] === '') merged[key] = value
      continue
    }
    if (merged[key] === undefined || merged[key] === '') merged[key] = value
  }
  return merged
}

function parseSraFetchXml(xml: string): Map<string, SraFetchDetails> {
  const details = new Map<string, SraFetchDetails>()
  for (const match of xml.matchAll(/<EXPERIMENT_PACKAGE\b[\s\S]*?<\/EXPERIMENT_PACKAGE>/g)) {
    const parsed = parseSraExperimentPackage(match[0])
    for (const key of sraDetailKeys(parsed)) {
      if (!details.has(key)) details.set(key, parsed)
    }
  }
  return details
}

function parseSraExperimentPackage(record: string): SraFetchDetails {
  const experimentScope = firstSraScope(record, 'EXPERIMENT') ?? record
  const sampleScope = firstSraScope(record, 'SAMPLE') ?? record
  const experimentTag = experimentScope.match(/^<EXPERIMENT\b[^>]*>/)?.[0] ?? ''
  const studyRefTag = record.match(/<STUDY_REF\b[^>]*>/)?.[0] ?? ''
  const sampleDescriptorTag = record.match(/<SAMPLE_DESCRIPTOR\b[^>]*>/)?.[0] ?? ''
  const sampleTag = sampleScope.match(/^<SAMPLE\b[^>]*>/)?.[0] ?? ''
  const platformScope = firstSraScope(experimentScope, 'PLATFORM')
  const runs = parseSraRuns(record)
  const experimentAccession = xmlAttr(experimentTag, 'accession')
  const runAccessions = uniqueStrings(runs.map((run) => run.accession).filter(Boolean) as string[])
  return {
    accession: experimentAccession,
    title: firstSraTagText(experimentScope, 'TITLE'),
    study_accession:
      xmlAttr(studyRefTag, 'accession') ??
      xmlAttr(record.match(/^<STUDY\b[^>]*>/)?.[0] ?? '', 'accession'),
    experiment_accession: experimentAccession,
    sample_accession: xmlAttr(sampleDescriptorTag, 'accession') ?? xmlAttr(sampleTag, 'accession'),
    biosample_accession: sraExternalAccession(sampleScope, 'BioSample'),
    bioproject_accession: sraExternalAccession(record, 'BioProject'),
    organism: firstSraTagText(sampleScope, 'SCIENTIFIC_NAME'),
    tax_id: parseOptionalNumber(firstSraTagText(sampleScope, 'TAXON_ID')),
    platform: sraPlatform(platformScope),
    instrument_model: firstSraTagText(platformScope ?? '', 'INSTRUMENT_MODEL'),
    library_strategy: firstSraTagText(experimentScope, 'LIBRARY_STRATEGY'),
    library_source: firstSraTagText(experimentScope, 'LIBRARY_SOURCE'),
    library_selection: firstSraTagText(experimentScope, 'LIBRARY_SELECTION'),
    library_layout: sraLibraryLayout(experimentScope),
    run_accessions: runAccessions,
    runs,
    download_urls: sraDownloadUrls(runAccessions),
    download_files: parseSraDownloadFiles(record, runAccessions)
  }
}

function sraDetailKeys(details: SraFetchDetails): string[] {
  return uniqueStrings(
    [
      details.accession,
      details.study_accession,
      details.experiment_accession,
      details.sample_accession,
      details.biosample_accession,
      ...(details.run_accessions ?? [])
    ].filter(Boolean) as string[]
  )
}

function firstSraScope(record: string, tag: string): string | undefined {
  return record.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`))?.[0]
}

export function firstSraTagText(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? normalizeXmlText(match[1]) : undefined
}

function sraExternalAccession(record: string, namespace: string): string | undefined {
  const match = record.match(
    new RegExp(`<EXTERNAL_ID\\b[^>]*namespace="${namespace}"[^>]*>([\\s\\S]*?)</EXTERNAL_ID>`)
  )
  return match ? normalizeXmlText(match[1]) : undefined
}

function sraPlatform(platformScope: string | undefined): string | undefined {
  if (!platformScope) return undefined
  const inner = platformScope.replace(/^<PLATFORM\b[^>]*>/, '')
  const match = inner.match(/<([A-Z0-9_]+)\b/)
  return match?.[1]
}

function sraLibraryLayout(experimentScope: string): string | undefined {
  const layoutScope = firstSraScope(experimentScope, 'LIBRARY_LAYOUT')
  if (!layoutScope) return undefined
  const inner = layoutScope.replace(/^<LIBRARY_LAYOUT\b[^>]*>/, '')
  return inner.match(/<([A-Z0-9_]+)\b/)?.[1]
}

function parseSraRuns(record: string): SraRunDetails[] {
  return [...record.matchAll(/<RUN\b[^>]*>/g)]
    .map((match) => {
      const tag = match[0]
      return {
        accession: xmlAttr(tag, 'accession'),
        total_spots: parseOptionalNumber(xmlAttr(tag, 'total_spots')),
        total_bases: parseOptionalNumber(xmlAttr(tag, 'total_bases')),
        size: parseOptionalNumber(xmlAttr(tag, 'size')),
        published: xmlAttr(tag, 'published')
      }
    })
    .filter((run) => run.accession !== undefined)
}

function sraRunBrowserUrl(accession: string): string {
  return `https://trace.ncbi.nlm.nih.gov/Traces/?view=run_browser&acc=${encodeURIComponent(accession)}`
}

function sraRecordUrl(accession: string): string {
  return `https://www.ncbi.nlm.nih.gov/sra/${encodeURIComponent(accession)}`
}

function sraDownloadUrls(
  runAccessions: string[]
): Record<string, Record<string, string>> | undefined {
  if (runAccessions.length === 0) return undefined
  return {
    run_browser: Object.fromEntries(
      runAccessions.map((accession) => [accession, sraRunBrowserUrl(accession)])
    ),
    sra_record: Object.fromEntries(
      runAccessions.map((accession) => [accession, sraRecordUrl(accession)])
    )
  }
}

function parseSraDownloadFiles(record: string, runAccessions: string[]): SraDownloadFile[] {
  const files: SraDownloadFile[] = []
  for (const runMatch of record.matchAll(/<RUN\b[\s\S]*?<\/RUN>|<RUN\b[^>]*\/>/g)) {
    const runRecord = runMatch[0]
    const runTag = runRecord.match(/^<RUN\b[^>]*\/?>/)?.[0] ?? ''
    const runAccession = xmlAttr(runTag, 'accession')
    for (const fileMatch of runRecord.matchAll(/<SRAFile\b[^>]*>/g)) {
      const tag = fileMatch[0]
      const url = xmlAttr(tag, 'url')
      if (!url) continue
      files.push({
        kind: 'sra_file',
        ...(runAccession ? { accession: runAccession } : {}),
        url,
        format: 'sra',
        ...(xmlAttr(tag, 'filename') ? { filename: xmlAttr(tag, 'filename') } : {}),
        ...(parseOptionalNumber(xmlAttr(tag, 'size')) !== undefined
          ? { size: parseOptionalNumber(xmlAttr(tag, 'size')) }
          : {}),
        ...(xmlAttr(tag, 'md5') ? { md5: xmlAttr(tag, 'md5') } : {}),
        ...(xmlAttr(tag, 'semantic_name') ? { semantic_name: xmlAttr(tag, 'semantic_name') } : {}),
        ...(xmlAttr(tag, 'supertype') ? { supertype: xmlAttr(tag, 'supertype') } : {}),
        ...(xmlAttr(tag, 'cluster') ? { cluster: xmlAttr(tag, 'cluster') } : {}),
        availability: 'direct_url',
        source: 'sra_efetch_xml'
      })
    }
  }

  for (const accession of runAccessions) {
    files.push({
      kind: 'sra_run_browser',
      accession,
      url: sraRunBrowserUrl(accession),
      format: 'html',
      availability: 'landing_page',
      source: 'derived_from_run_accession'
    })
  }

  return uniqueSraDownloadFiles(files)
}

function uniqueSraDownloadFiles(files: SraDownloadFile[]): SraDownloadFile[] {
  const seen = new Set<string>()
  const unique: SraDownloadFile[] = []
  for (const file of files) {
    const key = `${file.kind}:${file.accession ?? ''}:${file.url}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(file)
  }
  return unique
}
