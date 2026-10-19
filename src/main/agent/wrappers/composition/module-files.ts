import { parse as parseYaml } from 'yaml'

import type {
  WrapperModuleDetails,
  WrapperModuleMeta,
  WrapperModuleTool
} from '../../../../shared/wrapperModuleDetailsTypes'

import { isRecord } from '../../../../shared/guards'
/** Reads one file of a wrapper's component by name; `undefined` when it does not exist. */
export type ReadComponentFile = (name: string) => string | undefined

const DAG_FILE = 'dag.mmd'

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

/**
 * `meta.yml`'s `tools` field is a YAML list of single-key maps, e.g.
 * `[{fastqc: {description, homepage, licence, ...}}]` — one entry per tool
 * the module wraps (almost always exactly one).
 */
function parseTools(value: unknown): WrapperModuleTool[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools: WrapperModuleTool[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const [name, info] = Object.entries(item)[0] ?? []
    if (typeof name !== 'string' || !isRecord(info)) continue
    tools.push({
      name,
      description: typeof info.description === 'string' ? info.description.trim() : undefined,
      homepage: typeof info.homepage === 'string' ? info.homepage : undefined,
      documentation: typeof info.documentation === 'string' ? info.documentation : undefined,
      licence: asStringArray(info.licence),
      doi: typeof info.doi === 'string' ? info.doi : undefined,
      identifier:
        typeof info.identifier === 'string' && info.identifier ? info.identifier : undefined
    })
  }
  return tools.length > 0 ? tools : undefined
}

function parseModuleMeta(yamlText: string): WrapperModuleMeta | undefined {
  const doc: unknown = parseYaml(yamlText)
  if (!isRecord(doc)) return undefined
  return {
    description: typeof doc.description === 'string' ? doc.description : undefined,
    keywords: asStringArray(doc.keywords),
    tools: parseTools(doc.tools),
    authors: asStringArray(doc.authors)
  }
}

/**
 * The curated subset of a component's `meta.yml` / `environment.yml`. Works on any file source
 * (the installed tree or a package archive); a missing or malformed file leaves its field unset.
 */
export function readModuleDetails(read: ReadComponentFile): WrapperModuleDetails | undefined {
  const metaText = read('meta.yml')
  let meta: WrapperModuleMeta | undefined
  if (metaText !== undefined) {
    try {
      meta = parseModuleMeta(metaText)
    } catch {
      meta = undefined
    }
  }
  const environment = read('environment.yml')
  if (!meta && environment === undefined) return undefined
  return { meta, environment }
}

/** The pre-generated Mermaid DAG next to a wrapper's `wrapper.yaml`, when one exists. */
export function readWrapperDag(read: ReadComponentFile): string | undefined {
  return read(DAG_FILE)
}
