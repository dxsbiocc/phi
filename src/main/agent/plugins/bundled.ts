import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getBundledResourceDir } from '../runtime/runtime-adapter'

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/

export interface BundledPlugin {
  id: string
  dir: string
  agentsDir?: string
  skillsDir?: string
  environmentsDir?: string
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
    plugins.push(plugin)
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id))
  return plugins
}
