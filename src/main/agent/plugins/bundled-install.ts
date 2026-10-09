import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import semver from 'semver'

import {
  installPlugin,
  upgradePlugin,
  type LoadedPlugin,
  type PluginLifecycleResult,
  type PluginUpgradeOptions
} from './loader'
import { readPluginRegistry } from './store'
import { validatePlugin, type PluginProblem } from './validate'

export interface BundledPluginInstallOptions extends PluginUpgradeOptions {
  /**
   * `install` only installs missing bundled plugins (a fast file copy; run it before agent
   * scans). `upgrade` only upgrades installed ones (may build environments; run it in the
   * background). Default: both.
   */
  phase?: 'install' | 'upgrade' | 'all'
  bundledDir?: string
}

export interface BundledPluginInstallResult {
  installed: LoadedPlugin[]
  upgraded: LoadedPlugin[]
  skipped: string[]
  errors: PluginProblem[]
  warnings: PluginProblem[]
}

function error(path: string, message: string): PluginProblem {
  return { level: 'error', path, message }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function childDirectories(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => isDirectory(join(root, name)))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function appendOperation(
  result: BundledPluginInstallResult,
  operation: PluginLifecycleResult,
  target: LoadedPlugin[]
): void {
  result.errors.push(...operation.errors)
  result.warnings.push(...operation.warnings)
  if (operation.ok && operation.plugin) target.push(operation.plugin)
}

/** Explicit legacy migration; current catalog installs use verified package registries. */
export async function installBundledPlugins(
  options: BundledPluginInstallOptions = {}
): Promise<BundledPluginInstallResult> {
  if (!options.bundledDir) {
    throw new Error('Legacy plugin migration requires an explicit bundledDir')
  }
  const bundledDir = options.bundledDir
  const result: BundledPluginInstallResult = {
    installed: [],
    upgraded: [],
    skipped: [],
    errors: [],
    warnings: []
  }

  for (const directoryName of childDirectories(bundledDir)) {
    const dir = join(bundledDir, directoryName)
    const validation = validatePlugin(dir)
    result.warnings.push(...validation.warnings)
    if (!validation.ok || !validation.plugin) {
      result.errors.push(
        ...validation.errors.map((problem) => ({
          ...problem,
          path: `${directoryName}/${problem.path}`
        }))
      )
      continue
    }
    const manifest = validation.plugin.manifest
    if (manifest.id !== directoryName) {
      result.errors.push(
        error(
          `${directoryName}/phi-package.yaml:id`,
          `bundled plugin id '${manifest.id}' must equal directory name '${directoryName}'`
        )
      )
      continue
    }

    const agentDir = options.agentDir
    const entry = readPluginRegistry(agentDir).plugins[manifest.id]
    if (entry?.uninstalledBundled) {
      result.skipped.push(manifest.id)
      continue
    }
    const phase = options.phase ?? 'all'
    if (!entry) {
      if (phase === 'upgrade') {
        result.skipped.push(manifest.id)
        continue
      }
      appendOperation(
        result,
        installPlugin(dir, { ...options, source: 'bundled' }),
        result.installed
      )
      continue
    }
    if (phase === 'install' || !semver.gt(manifest.version, entry.version)) {
      result.skipped.push(manifest.id)
      continue
    }
    appendOperation(
      result,
      await upgradePlugin(dir, { ...options, source: 'bundled' }),
      result.upgraded
    )
  }
  return result
}
