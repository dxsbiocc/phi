import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface TemplateContract {
  id: string
  family: string
  title: string
  preview: string
  intent_keywords?: string[]
  use_when?: string
  avoid_when?: string
  roles?: { required?: string[] }
}

interface ContractCatalog {
  templates?: TemplateContract[]
}

export interface FigureExample {
  template_id: string
  title: string
  family: string
  preview: string
  preview_markdown: string
  use_when: string
  avoid_when: string
  required_roles: string[]
}

const MAX_EXAMPLES = 4
const GENERIC_TERMS = new Set([
  'example',
  'examples',
  'preview',
  'previews',
  'show',
  'template',
  'templates',
  'plot',
  'figure',
  '示例',
  '模板',
  '预览',
  '图片',
  '图'
])

function termsFor(purpose: string): string[] {
  return purpose
    .toLowerCase()
    .split(/[\s,;，；。:：/]+/)
    .filter((term) => term && !GENERIC_TERMS.has(term))
}

function scoreTemplate(template: TemplateContract, terms: string[]): number {
  if (terms.length === 0) return 1
  const labels = [
    template.id,
    template.title,
    template.family,
    ...(template.intent_keywords ?? [])
  ].map((value) => value.toLowerCase())
  const useWhen = (template.use_when ?? '').toLowerCase()
  return terms.reduce((score, term) => {
    const labelMatch = labels.some((label) => label.includes(term) || term.includes(label))
    return score + (labelMatch ? 4 : useWhen.includes(term) ? 1 : 0)
  }, 0)
}

/** Only bundled template preview PNGs are eligible for chat's read-only image preview. */
export function isInstalledFigurePreviewPath(path: string, skillRoot: string): boolean {
  if (!isAbsolute(path) || basename(path) !== 'preview.png') return false
  try {
    const root = realpathSync(skillRoot)
    const realPath = realpathSync(path)
    const parts = relative(root, realPath).split(sep)
    return (
      parts.length === 4 &&
      parts[0] === 'scripts' &&
      parts[3] === 'preview.png' &&
      statSync(realPath).isFile()
    )
  } catch {
    return false
  }
}

function installedPreview(skillRoot: string, template: TemplateContract): string | undefined {
  if (!template.preview || isAbsolute(template.preview)) return undefined
  const path = resolve(skillRoot, template.preview)
  return isInstalledFigurePreviewPath(path, skillRoot) ? realpathSync(path) : undefined
}

/** Lists installed example PNGs without executing a plotting script or touching the project. */
export function findFigureExamples(
  skillRoot: string,
  purpose: string,
  requestedTop = MAX_EXAMPLES
): {
  purpose: string
  source: string
  dataFitted: false
  totalMatches: number
  candidates: FigureExample[]
} {
  const path = join(skillRoot, 'references', 'template_contracts.json')
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as ContractCatalog
  const terms = termsFor(purpose)
  const matches = (catalog.templates ?? [])
    .map((template, order) => ({ template, order, score: scoreTemplate(template, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
  const candidates: FigureExample[] = []
  const top = Number.isFinite(requestedTop)
    ? Math.min(Math.max(Math.floor(requestedTop), 1), MAX_EXAMPLES)
    : MAX_EXAMPLES
  for (const { template } of matches) {
    const preview = installedPreview(skillRoot, template)
    if (!preview) continue
    candidates.push({
      template_id: template.id,
      title: template.title,
      family: template.family,
      preview,
      preview_markdown: `![${template.id}](${preview})`,
      use_when: template.use_when ?? '',
      avoid_when: template.avoid_when ?? '',
      required_roles: template.roles?.required ?? []
    })
    if (candidates.length >= top) break
  }
  return {
    purpose,
    source: 'bundled-template-preview',
    dataFitted: false,
    totalMatches: matches.length,
    candidates
  }
}
