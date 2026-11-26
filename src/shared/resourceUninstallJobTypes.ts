export type ResourceUninstallTargetKind = 'skill' | 'wrapper' | 'connector'

export type ResourceUninstallState = 'running' | 'succeeded' | 'failed'

/**
 * Renderer-tracked background uninstall/removal record for Skills, Wrappers, and Connectors.
 * Completed attempts are persisted through the shared background job history store.
 */
export interface ResourceUninstallJob {
  id: string
  targetKind: ResourceUninstallTargetKind
  targetId: string
  title: string
  version?: string
  detail?: string
  state: ResourceUninstallState
  startedAt: string
  finishedAt?: string
  error?: string
}
