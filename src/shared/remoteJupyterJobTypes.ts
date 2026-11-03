export type RemoteJupyterStartJobState = 'running' | 'ready' | 'failed' | 'cancelled'

export type RemoteJupyterStartJobPhaseCode =
  | 'preparing'
  | 'connecting'
  | 'checking_configured_jupyter'
  | 'checking_server_path_jupyter'
  | 'missing_jupyter_using_managed'
  | 'using_existing_jupyter'
  | 'using_managed_jupyter'
  | 'allocating_ports'
  | 'starting_lease'
  | 'probing_through_tunnel'
  | 'ready'
  | 'cleaning'
  | 'reconciling'
  | 'disconnected'
  | 'failed'
  | 'cancelled'

export type RemoteJupyterStartJobEntryCode =
  | 'connecting'
  | 'checking_configured_jupyter'
  | 'checking_server_path_jupyter'
  | 'missing_jupyter_using_managed'
  | 'using_existing_jupyter'
  | 'using_managed_jupyter'
  | 'allocating_ports'
  | 'starting_lease'
  | 'probing_through_tunnel'
  | 'ready'
  | 'cleaning'
  | 'reconciling'
  | 'disconnected'
  | 'startup_cancelled'

export type RemoteJupyterStartJobStepCode = Exclude<
  RemoteJupyterStartJobEntryCode,
  'startup_cancelled'
>

export interface RemoteJupyterStartJobTextParams {
  serverLabel?: string
  configuredPath?: string
  environmentRef?: string
  jupyterPath?: string
  pythonPath?: string
  version?: string
  /** Raw server detail appended after Phi's localized step label. */
  detail?: string
}

export interface RemoteJupyterStartJobStepMetadata {
  code: RemoteJupyterStartJobStepCode
  params?: RemoteJupyterStartJobTextParams
}

export interface RemoteJupyterStartJobEntry {
  at: string
  /** `step`: what Phi is doing; `output`: the server's own stdout/stderr; `error`: why it failed. */
  kind: 'step' | 'output' | 'error'
  text: string
  code?: RemoteJupyterStartJobEntryCode
  params?: RemoteJupyterStartJobTextParams
}

/** One attempt to start a remote project's Jupyter Server, shown as a background job. */
export interface RemoteJupyterStartJob {
  id: string
  projectId: string
  projectName: string
  serverLabel: string
  state: RemoteJupyterStartJobState
  /** The latest step, for a one-line summary. */
  phase: string
  phaseCode?: RemoteJupyterStartJobPhaseCode
  phaseParams?: RemoteJupyterStartJobTextParams
  startedAt: string
  finishedAt?: string
  error?: string
  /** Newest last; capped, so a chatty server cannot grow it without bound. */
  entries: RemoteJupyterStartJobEntry[]
}

export const REMOTE_JUPYTER_JOB_MAX_ENTRIES = 400
