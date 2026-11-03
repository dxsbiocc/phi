import type {
  AnalysisKernelDiagnostics,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  JupyterServerStatus
} from '../../../types'

/** What a project's notebook view had loaded, kept while another project is in front. */
export interface NotebookScopeSnapshot {
  files: Map<string, AnalysisNotebookFile>
  registry: AnalysisNotebookRegistry | null
  kernelDiagnostics: AnalysisKernelDiagnostics | null
  jupyterStatus: JupyterServerStatus | null
}

export const MAX_NOTEBOOK_SCOPE_SNAPSHOTS = 6

/** Keeps the most recently left projects; returning to one shows it without reading the server. */
export function rememberNotebookScope(
  snapshots: ReadonlyMap<string, NotebookScopeSnapshot>,
  cwd: string,
  snapshot: NotebookScopeSnapshot
): Map<string, NotebookScopeSnapshot> {
  const next = new Map(snapshots)
  next.delete(cwd)
  if (snapshot.files.size === 0 && !snapshot.registry) return next
  next.set(cwd, snapshot)
  while (next.size > MAX_NOTEBOOK_SCOPE_SNAPSHOTS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

/** A snapshot is handed back once; the view owns its state again from then on. */
export function takeNotebookScope(
  snapshots: ReadonlyMap<string, NotebookScopeSnapshot>,
  cwd: string
): { snapshot?: NotebookScopeSnapshot; remaining: Map<string, NotebookScopeSnapshot> } {
  const remaining = new Map(snapshots)
  const snapshot = remaining.get(cwd)
  remaining.delete(cwd)
  return snapshot ? { snapshot, remaining } : { remaining }
}
