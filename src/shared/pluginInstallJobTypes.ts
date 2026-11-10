/**
 * In-memory record of one Phi Plugin install/upgrade attempt.
 *
 * The main process owns the list; the renderer only reads it through IPC and
 * mirrors terminal records into its display-only background job history.
 */
export type PluginInstallAction = 'install' | 'upgrade'

export type PluginInstallState = 'running' | 'succeeded' | 'failed'

/**
 * Stable failure code. The renderer turns it into a short user-facing sentence;
 * the detailed cause is written to the main-process log instead of this record.
 */
export type PluginInstallFailure = 'install-failed' | 'upgrade-failed'

export interface PluginInstallJob {
  id: string
  pluginId: string
  /** Plugin display title at the time the attempt started. */
  title: string
  /** Target version at the time the attempt started. */
  version: string
  action: PluginInstallAction
  state: PluginInstallState
  startedAt: string
  finishedAt?: string
  failure?: PluginInstallFailure
}
