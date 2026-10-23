import { errorMessage } from '../shared/errorCodes'
import { writeAppLog } from './agent/app-logger'
import { getEnablementSnapshot, setEnabled } from './agent/enablement'
import { refreshPersistedManagedStdioServers } from './agent/mcp-connectors'
import { readPluginRegistry, writePluginRegistry } from './agent/plugins/store'

export function migrateStartupPluginEnablement(
  agentDir: string,
  getRuntimeRoot: () => string
): void {
  try {
    const refreshed = refreshPersistedManagedStdioServers({
      agentDir,
      runtimeRoot: getRuntimeRoot()
    })
    if (refreshed.failures.length > 0) {
      writeAppLog({
        level: 'warn',
        event: 'mcp_managed_stdio_refresh_failed',
        metadata: {
          failures: refreshed.failures.map(({ name, ref, error }) => ({
            name,
            ref,
            error: error.message
          }))
        }
      })
    }
  } catch (error) {
    writeAppLog({
      level: 'warn',
      event: 'mcp_managed_stdio_refresh_failed',
      metadata: { error: errorMessage(error) }
    })
  }
  try {
    const registry = readPluginRegistry(agentDir)
    const global = getEnablementSnapshot({ agentDir }).global
    const plugins = { ...registry.plugins }
    const migratedPlugins: string[] = []
    let hadLegacyEnablement = false
    for (const [id, entry] of Object.entries(plugins)) {
      if (typeof entry.enabled !== 'boolean') continue
      hadLegacyEnablement = true
      const key = `plugin:${id}` as const
      if (!Object.hasOwn(global, key)) {
        setEnabled(key, entry.enabled, { agentDir })
        migratedPlugins.push(id)
      }
      const lifecycleEntry = { ...entry }
      delete lifecycleEntry.enabled
      plugins[id] = lifecycleEntry
    }
    if (hadLegacyEnablement) writePluginRegistry({ version: 1, plugins }, agentDir)
    if (migratedPlugins.length > 0) {
      writeAppLog({
        event: 'enablement_plugin_registry_migrated',
        metadata: { plugins: migratedPlugins }
      })
    }
  } catch (error) {
    writeAppLog({
      event: 'enablement_plugin_registry_migration_failed',
      level: 'warn',
      metadata: { error: errorMessage(error) }
    })
  }
}
