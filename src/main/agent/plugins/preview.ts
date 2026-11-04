import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'

import { templatePreviewFile } from '../../../shared/visualizationTemplateTypes'
import { listInstalledPlugins } from './loader'

/**
 * Allow chat to display installed template previews while keeping every other
 * plugin file behind the normal project-file boundary.
 * A template may ship `preview.png` plus `preview_<name>.png` drawings.
 */
export function isPluginSkillPreviewPath(target: string, agentDir?: string): boolean {
  const fileName = basename(target)
  if (!isAbsolute(target) || !templatePreviewFile(fileName)) return false
  let realPath: string
  try {
    realPath = realpathSync(target)
    if (!statSync(realPath).isFile()) return false
  } catch {
    return false
  }

  for (const plugin of listInstalledPlugins(agentDir ? { agentDir } : {})) {
    for (const skillsRoot of plugin.components.skills) {
      let realRoot: string
      try {
        realRoot = realpathSync(skillsRoot)
      } catch {
        continue
      }
      const parts = relative(realRoot, realPath).split(sep)
      if (
        parts.length === 4 &&
        parts[0] === 'scripts' &&
        parts[3] === fileName &&
        templatePreviewFile(parts[3]) &&
        !parts.includes('..')
      ) {
        return true
      }
    }
  }
  return false
}
