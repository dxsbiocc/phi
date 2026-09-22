import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads the bundled omics-visualization templates. Every `scripts/<family>/<name>/plot.R`
 * opens with the same header (Template-ID, Purpose, Inputs, ...), has the same CONFIG /
 * DATA PREPARATION / PLOT sections, and starts with the same block that hunts for
 * `lib/common.R` above the script. All of that is parsed here, so nobody has to read a
 * template top to bottom to find out what it takes and where to edit it.
 */

export interface SourceSection {
  /** 1-based, inclusive; the lines of the file that make up `text`. */
  startLine: number
  endLine: number
  text: string
}

export interface TemplateSource {
  id: string
  purpose: string
  /** The tables the script takes, in order: `['input']`, or `['nodes', 'links']`. */
  inputNames: string[]
  dependencies: string[]
  adaptation?: string
  assumptions?: string
  config?: SourceSection
  dataPreparation?: SourceSection
  plot?: SourceSection
}

export interface IndexedTemplateSource extends TemplateSource {
  /** Absolute path of the template's plot.R inside the skill. */
  path: string
}

const HEADER_LABEL = /^# ([A-Z][A-Za-z-]*(?: [a-z]+)*):[ \t]*(.*)$/
const SECTION_MARKER = /^# (CONFIG|DATA PREPARATION|PLOT|SAVE)\b/
const RULER = /^# -{10,}/
const BOOTSTRAP = /^local\(\{\n[\s\S]*?^\}\)\n/m

function headerFields(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>()
  let label: string | undefined
  let parts: string[] = []
  const flush = (): void => {
    if (label) fields.set(label, parts.join('\n').trim())
  }
  for (const line of lines) {
    if (!line.startsWith('#')) {
      if (line.trim() === '' && fields.size + parts.length > 0) break
      if (line.trim() !== '' && !line.startsWith('#!')) break
      continue
    }
    const heading = HEADER_LABEL.exec(line)
    if (heading) {
      flush()
      label = heading[1]
      parts = heading[2] ? [heading[2]] : []
    } else if (label) {
      parts.push(line.replace(/^#\s{0,2}/, ''))
    }
  }
  flush()
  return fields
}

function inputNamesOf(text: string): string[] {
  const names = /input_names\s*=\s*c\(([^)]*)\)/.exec(text)?.[1]
  if (!names) return ['input']
  const quoted = [...names.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
  return quoted.length > 0 ? quoted : ['input']
}

/** How many tables a (possibly edited) script takes, or undefined when it does not say. */
export function scriptInputNames(text: string): string[] | undefined {
  return /parse_io_args\s*\(/.test(text) ? inputNamesOf(text) : undefined
}

function sections(lines: readonly string[]): Map<string, SourceSection> {
  const markers = lines
    .map((line, index) => ({ name: SECTION_MARKER.exec(line)?.[1], index }))
    .filter(
      (marker): marker is { name: string; index: number } =>
        marker.name !== undefined && RULER.test(lines[marker.index + 1] ?? '')
    )
  const found = new Map<string, SourceSection>()
  markers.forEach((marker, position) => {
    const first = marker.index + 2
    const next = markers[position + 1]
    let last = next ? next.index - 2 : lines.length - 1
    while (last > first && lines[last].trim() === '') last -= 1
    if (last < first) return
    found.set(marker.name, {
      startLine: first + 1,
      endLine: last + 1,
      text: lines.slice(first, last + 1).join('\n')
    })
  })
  return found
}

export function parseTemplateSource(text: string): TemplateSource {
  const lines = text.split('\n')
  const header = headerFields(lines)
  const found = sections(lines)
  const dependencies = (header.get('Dependencies') ?? '')
    .split(/[\s,]+/)
    .filter((token) => /^[A-Za-z][A-Za-z0-9.]*$/.test(token) && token !== 'and')
  return {
    id: header.get('Template-ID') ?? '',
    purpose: (header.get('Purpose') ?? '').replace(/\s*\n\s*/g, ' '),
    inputNames: inputNamesOf(text),
    dependencies,
    ...(header.get('Agent adaptation')
      ? { adaptation: header.get('Agent adaptation')?.replace(/\s*\n\s*/g, ' ') }
      : {}),
    ...(header.get('Scientific assumptions')
      ? { assumptions: header.get('Scientific assumptions')?.replace(/\s*\n\s*/g, ' ') }
      : {}),
    ...(found.has('CONFIG') ? { config: found.get('CONFIG') } : {}),
    ...(found.has('DATA PREPARATION') ? { dataPreparation: found.get('DATA PREPARATION') } : {}),
    ...(found.has('PLOT') ? { plot: found.get('PLOT') } : {})
  }
}

function rString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A copy of a template no longer sits under `scripts/`, so the block that looks for
 * `lib/common.R` above the script finds nothing. Replaces it with a direct `source()` of the
 * installed, read-only helper.
 */
export function patchBootstrap(text: string, commonRPath: string): string {
  const block = BOOTSTRAP.exec(text)
  if (!block || !block[0].includes('common.R')) {
    throw new Error('The template has no common.R bootstrap block to replace.')
  }
  return `${text.slice(0, block.index)}source(${rString(commonRPath)})\n${text.slice(block.index + block[0].length)}`
}

const MAX_SCAN_DEPTH = 4
const indexCache = new Map<string, IndexedTemplateSource[]>()

function findPlotScripts(dir: string, depth: number): string[] {
  if (depth > MAX_SCAN_DEPTH) return []
  const found: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...findPlotScripts(full, depth + 1))
    else if (name === 'plot.R') found.push(full)
  }
  return found
}

/** Every template under `<skillRoot>/scripts`, in path order. Cached: the skill does not change while running. */
export function listTemplateSources(skillRoot: string): IndexedTemplateSource[] {
  const cached = indexCache.get(skillRoot)
  if (cached) return cached
  const scripts = join(skillRoot, 'scripts')
  const sources = existsSync(scripts)
    ? findPlotScripts(scripts, 0).flatMap((path): IndexedTemplateSource[] => {
        const source = parseTemplateSource(readFileSync(path, 'utf-8'))
        return source.id ? [{ ...source, path }] : []
      })
    : []
  indexCache.set(skillRoot, sources)
  return sources
}
