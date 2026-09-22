import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import { closestNames } from '../name-match'
import { resolveInsideProject } from './project-path'
import {
  listTemplateSources,
  parseTemplateSource,
  patchBootstrap,
  type SourceSection
} from './template-source'

const MAX_SUGGESTIONS = 4

export interface PreparedTemplate {
  template_id: string
  script: string
  /** An earlier copy was kept, edits included; pass `reset` to start over. */
  existing?: true
  /** Files and folders copied beside the script because the template reads them (a glyph, a folder of icons). */
  assets?: string[]
  purpose: string
  inputs: string[]
  run: string
  dependencies: string[]
  adaptation?: string
  assumptions?: string
  config?: LineSection
  data_preparation?: LineSection
  plot?: { start_line: number; end_line: number }
}

interface LineSection {
  start_line: number
  end_line: number
  text: string
}

export type PrepareOutcome = { ok: true; result: PreparedTemplate } | { ok: false; error: string }

function lineSection(section: SourceSection | undefined): LineSection | undefined {
  return section
    ? { start_line: section.startLine, end_line: section.endLine, text: section.text }
    : undefined
}

/** Tables next to a template are its example data; they are not read from the script's directory. */
const EXAMPLE_DATA_EXTENSIONS = new Set(['.tsv', '.csv'])
const NOT_ASSETS = new Set(['plot.R', 'preview.png'])

/**
 * Some templates load files from their own directory (`scatter-svg` its pin.svg, `bar-svg-icon`
 * a folder of icons). Copies those beside the script, and leaves example tables behind.
 */
function copyAssets(templateScript: string, targetDir: string): string[] {
  const from = dirname(templateScript)
  const copied = readdirSync(from)
    .filter(
      (name) => !NOT_ASSETS.has(name) && !EXAMPLE_DATA_EXTENSIONS.has(extname(name).toLowerCase())
    )
    .sort()
  for (const name of copied) cpSync(join(from, name), join(targetDir, name), { recursive: true })
  return copied
}

export function prepareTemplate(request: {
  skillRoot: string
  cwd: string
  templateId: string
  workdir: string
  reset?: boolean
}): PrepareOutcome {
  const templates = listTemplateSources(request.skillRoot)
  const template = templates.find((candidate) => candidate.id === request.templateId)
  if (!template) {
    const close = closestNames(
      request.templateId,
      templates.map((candidate) => candidate.id),
      MAX_SUGGESTIONS
    )
    return {
      ok: false,
      error: `There is no template "${request.templateId}".${
        close.length > 0 ? ` Closest: ${close.join(', ')}.` : ''
      } Use viz_route to find one for the data; do not guess template ids.`
    }
  }

  const dir = resolveInsideProject(request.cwd, request.workdir, 'The working directory')
  if (!dir.ok) return { ok: false, error: dir.error }
  const script = join(dir.path, 'plot.R')
  const existing = existsSync(script) && request.reset !== true
  if (!existing) {
    mkdirSync(dir.path, { recursive: true })
    const helper = join(request.skillRoot, 'scripts', 'lib', 'common.R')
    writeFileSync(script, patchBootstrap(readFileSync(template.path, 'utf-8'), helper), 'utf-8')
  }
  const assets = existing ? [] : copyAssets(template.path, dir.path)

  const current = parseTemplateSource(readFileSync(script, 'utf-8'))
  const config = lineSection(current.config)
  const dataPreparation = lineSection(current.dataPreparation)
  return {
    ok: true,
    result: {
      template_id: template.id,
      script,
      ...(existing ? { existing: true as const } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      purpose: template.purpose,
      inputs: template.inputNames,
      run: `Rscript ${script} ${template.inputNames.map((name) => `<${name}>`).join(' ')} <output>`,
      dependencies: template.dependencies,
      ...(template.adaptation ? { adaptation: template.adaptation } : {}),
      ...(template.assumptions ? { assumptions: template.assumptions } : {}),
      ...(config ? { config } : {}),
      ...(dataPreparation ? { data_preparation: dataPreparation } : {}),
      ...(current.plot
        ? { plot: { start_line: current.plot.startLine, end_line: current.plot.endLine } }
        : {})
    }
  }
}
