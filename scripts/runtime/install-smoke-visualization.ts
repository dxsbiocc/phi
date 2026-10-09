import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  getEnablementPath,
  readEnablementState,
  writeEnablementState
} from '../../src/main/agent/enablement'
import { installPlugin, type LoadedPlugin } from '../../src/main/agent/plugins/loader'
import { validatePlugin } from '../../src/main/agent/plugins/validate'
import { requirePackageSourceRoot, requireSourceDirectory } from '../content/source-roots.mjs'

interface SmokePluginInstallOptions {
  /** The smoke account's isolated directory; never inferred from the user's environment. */
  agentDir: string
  sourceRoot?: string
}

/** Explicit fixture setup, separate from production startup's installed-only loading. */
export function installVisualizationSmokePlugin(options: SmokePluginInstallOptions): LoadedPlugin {
  if (!options.agentDir.trim()) throw new Error('Visualization smoke requires an isolated agentDir')
  const source = requireSourceDirectory(
    requirePackageSourceRoot(options.sourceRoot),
    'resources/plugins/visualization'
  )
  const validation = validatePlugin(source)
  if (!validation.ok || !validation.plugin) {
    const problems = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
    throw new Error(`Visualization smoke source is invalid: ${problems}`)
  }
  const manifest = validation.plugin.manifest
  if (manifest.type !== 'plugin' || manifest.id !== 'visualization') {
    throw new Error(`Visualization smoke source must contain plugin:visualization: ${source}`)
  }

  const agentDir = resolve(options.agentDir)
  // Loader warnings use the process logger. Check existing state with a local
  // logger and prepare fresh defaults so this setup cannot log into the user's account.
  if (existsSync(getEnablementPath(agentDir))) {
    let warning: string | undefined
    readEnablementState({
      agentDir,
      logger: {
        info: (): void => undefined,
        warn: (message): void => {
          warning = message
        }
      }
    })
    if (warning) throw new Error(`Visualization smoke has invalid enablement state: ${warning}`)
  } else {
    writeEnablementState({ version: 1, global: {}, projects: {} }, { agentDir })
  }
  const result = installPlugin(source, {
    agentDir,
    runtimeRoot: join(agentDir, 'runtime'),
    source: 'local'
  })
  if (!result.ok || !result.plugin) {
    const problems = result.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
    throw new Error(`Visualization smoke installation failed: ${problems}`)
  }
  return result.plugin
}
