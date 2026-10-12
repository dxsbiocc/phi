export type RemoteJupyterStartJobState = 'running' | 'ready' | 'failed' | 'cancelled'

export interface RemoteJupyterStartJobEntry {
  at: string
  /** `step`: what Phi is doing; `output`: the server's own stdout/stderr; `error`: why it failed. */
  kind: 'step' | 'output' | 'error'
  text: string
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
  startedAt: string
  finishedAt?: string
  error?: string
  /** Newest last; capped, so a chatty server cannot grow it without bound. */
  entries: RemoteJupyterStartJobEntry[]
}

export const REMOTE_JUPYTER_JOB_MAX_ENTRIES = 400
