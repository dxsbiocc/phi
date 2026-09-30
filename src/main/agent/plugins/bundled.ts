import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { toolPrefixError } from '../content/skill'
import { getBundledResourceDir } from '../runtime/runtime-adapter'

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/
const PACKAGE_FILE = 'phi-package.yaml'

export interface BundledPlugin {
  id: string
  dir: string
  agentsDir?: string
  skillsDir?: string
  environmentsDir?: string
  /** Present when phi-package.yaml declares a valid toolPrefix. */
  toolPrefix?: string
  /** Set when phi-package.yaml exists but toolPrefix is missing or invalid. */
  toolPrefixProblem?: string
}

export function bundledPluginsDir(): string {
  return getBundledResourceDir('plugins')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readToolPrefix(dir: string): { toolPrefix?: string; toolPrefixProblem?: string } {
  const file = join(dir, PACKAGE_FILE)
  if (!isFile(file)) return {}
  let document: unknown
  try {
    document = parseYaml(readFileSync(file, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { toolPrefixProblem: `phi-package.yaml: ${message}` }
  }
  if (!isRecord(document) || typeof document.toolPrefix !== 'string') {
    return { toolPrefixProblem: 'phi-package.yaml is missing toolPrefix' }
  }
  const problem = toolPrefixError(document.toolPrefix)
  if (problem) return { toolPrefixProblem: problem }
  return { toolPrefix: document.toolPrefix }
}

/**
 * A shipped template preview: `<skill>/scripts/<family>/<template>/preview.png`
 * under a bundled plugin's skills directory. Chat can show that image even though
 * it lives outside the project. Other skill files stay closed.
 */
export function isBundledSkillPreviewPath(target: string, pluginsDir?: string): boolean {
  if (!isAbsolute(target) || basename(target) !== 'preview.png') return false
  let realPath: string
  try {
    realPath = realpathSync(target)
    if (!statSync(realPath).isFile()) return false
  } catch {
    return false
  }
  for (const plugin of listBundledPlugins(pluginsDir)) {
    if (!plugin.skillsDir) continue
    let skillsRoot: string
    try {
      skillsRoot = realpathSync(plugin.skillsDir)
    } catch {
      continue
    }
    const parts = relative(skillsRoot, realPath).split(sep)
    if (
      parts.length === 5 &&
      parts[1] === 'scripts' &&
      parts[4] === 'preview.png' &&
      !parts.includes('..')
    ) {
      return true
    }
  }
  return false
}

/** Direct child directories with a plugin id. Optional component dirs are set only when present. */
export function listBundledPlugins(pluginsDir: string = bundledPluginsDir()): BundledPlugin[] {
  let names: string[]
  try {
    names = readdirSync(pluginsDir)
  } catch {
    return []
  }

  const plugins: BundledPlugin[] = []
  for (const id of names) {
    if (!PLUGIN_ID.test(id)) continue
    const dir = join(pluginsDir, id)
    if (!isDirectory(dir)) continue
    const plugin: BundledPlugin = { id, dir }
    const agentsDir = join(dir, 'agents')
    const skillsDir = join(dir, 'skills')
    const environmentsDir = join(dir, 'environments')
    if (isDirectory(agentsDir)) plugin.agentsDir = agentsDir
    if (isDirectory(skillsDir)) plugin.skillsDir = skillsDir
    if (isDirectory(environmentsDir)) plugin.environmentsDir = environmentsDir
    const prefix = readToolPrefix(dir)
    if (prefix.toolPrefix) plugin.toolPrefix = prefix.toolPrefix
    if (prefix.toolPrefixProblem) plugin.toolPrefixProblem = prefix.toolPrefixProblem
    plugins.push(plugin)
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id))
  return plugins
}
