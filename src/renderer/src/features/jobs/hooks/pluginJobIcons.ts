import { useEffect, useSyncExternalStore } from 'react'
import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'

/**
 * Icons of installed plugins, keyed by plugin ID, so a plugin job card can show
 * the plugin's own icon. The app publishes the installed list; job cards read it.
 */
type PluginIconSource = { id: string; icon?: ResourceIconRef }

const PLUGIN_JOB_KEY_PREFIX = 'plugin:'
const listeners = new Set<() => void>()
let icons: ReadonlyMap<string, ResourceIconRef> = new Map()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): ReadonlyMap<string, ResourceIconRef> {
  return icons
}

function publish(plugins: readonly PluginIconSource[]): void {
  icons = new Map(plugins.flatMap((plugin) => (plugin.icon ? [[plugin.id, plugin.icon]] : [])))
  for (const listener of listeners) listener()
}

/** Called once by the app with the installed plugins whenever that list changes. */
export function usePublishPluginJobIcons(plugins: readonly PluginIconSource[]): void {
  useEffect(() => publish(plugins), [plugins])
}

/** The plugin icon for a job key such as `plugin:literature-library`, if it has one. */
export function usePluginJobIcon(jobKey: string): ResourceIconRef | undefined {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  return jobKey.startsWith(PLUGIN_JOB_KEY_PREFIX)
    ? current.get(jobKey.slice(PLUGIN_JOB_KEY_PREFIX.length))
    : undefined
}
