interface DisposableRemoteNotebookBackend {
  dispose: () => Promise<void>
}

export interface RemoteNotebookBackendDisposalDeps {
  remoteNotebookBackends: {
    get: (projectId: string) => DisposableRemoteNotebookBackend | undefined
    delete: (projectId: string) => boolean
  }
  remoteNotebookSessionIds: {
    delete: (projectId: string) => boolean
  }
}

export interface RemoteNotebookBackendDisposal {
  disposeRemoteNotebookBackend: (projectId: string) => Promise<void>
}

export function createRemoteNotebookBackendDisposal(
  deps: RemoteNotebookBackendDisposalDeps
): RemoteNotebookBackendDisposal {
  async function disposeRemoteNotebookBackend(projectId: string): Promise<void> {
    const backend = deps.remoteNotebookBackends.get(projectId)
    if (!backend) return
    await backend.dispose()
    deps.remoteNotebookBackends.delete(projectId)
    deps.remoteNotebookSessionIds.delete(projectId)
  }

  return { disposeRemoteNotebookBackend }
}
