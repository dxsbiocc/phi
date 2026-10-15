import type { NotebookAiGenerationJob } from '../../../../../shared/notebookAiJobTypes'
import type { RemoteJupyterStartJob } from '../../../../../shared/remoteJupyterJobTypes'
import { notebookAiBackgroundJob, type UnifiedBackgroundJob } from './backgroundJobs'

/** Asks the panel to open the newest Jupyter startup job, whichever project it belongs to. */
export const LATEST_JUPYTER_JOB_KEY = 'jupyter:latest'

const NOTEBOOK_AI_REQUEST_PREFIX = 'notebook-ai-request:'

export function notebookAiJobRequestKey(requestId: string): string {
  return `${NOTEBOOK_AI_REQUEST_PREFIX}${requestId}`
}

/** Explicitly opening a live Notebook attempt does not restore a cleared history row. */
export function resolveSelectedBackgroundJob(
  selectedKey: string | null,
  visibleJobs: readonly UnifiedBackgroundJob[],
  notebookAiJobs: readonly NotebookAiGenerationJob[]
): UnifiedBackgroundJob | undefined {
  if (!selectedKey) return undefined
  const visible = visibleJobs.find((item) => item.key === selectedKey)
  if (visible) return visible
  const notebookJob = notebookAiJobs.find((job) => `notebook-ai:${job.id}` === selectedKey)
  return notebookJob ? notebookAiBackgroundJob(notebookJob) : undefined
}

/** An unresolved Notebook request stays pending until its first job reaches the poller. */
export function resolveRequestedBackgroundJobKey(
  requestedKey: string,
  data: {
    jupyterJobs: readonly RemoteJupyterStartJob[]
    notebookAiJobs: readonly NotebookAiGenerationJob[]
  },
  recent: readonly UnifiedBackgroundJob[]
): string | undefined {
  if (requestedKey.startsWith(NOTEBOOK_AI_REQUEST_PREFIX)) {
    const requestId = requestedKey.slice(NOTEBOOK_AI_REQUEST_PREFIX.length)
    let latest: NotebookAiGenerationJob | undefined
    for (const job of data.notebookAiJobs) {
      if (job.requestId === requestId && (!latest || job.startedAt > latest.startedAt)) latest = job
    }
    return latest ? `notebook-ai:${latest.id}` : undefined
  }
  if (requestedKey === LATEST_JUPYTER_JOB_KEY) {
    return data.jupyterJobs[0]
      ? `jupyter:${data.jupyterJobs[0].id}`
      : recent.find((item) => item.kind === 'history' && item.snapshot.sourceKind === 'jupyter')
          ?.key
  }
  return requestedKey
}
