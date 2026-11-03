import type { JupyterServerRegistry } from './analysis-jupyter-server'
import type { NotebookToolDispatchControl } from './notebook-tools'

export interface NotebookServerReadinessDeps {
  jupyterServerRegistry: Pick<JupyterServerRegistry, 'status' | 'start'>
  delay: (ms: number) => Promise<void>
}

export interface NotebookServerReadiness {
  ensureJupyterServerReady: (
    projectCwd: string,
    control?: NotebookToolDispatchControl
  ) => Promise<void>
}

export function createNotebookServerReadiness(
  deps: NotebookServerReadinessDeps
): NotebookServerReadiness {
  async function ensureJupyterServerReady(
    projectCwd: string,
    control: NotebookToolDispatchControl = {}
  ): Promise<void> {
    let status = deps.jupyterServerRegistry.status(projectCwd)
    if (status.state !== 'ready' || !status.hasEndpoint) {
      status = deps.jupyterServerRegistry.start(projectCwd, {
        ...(control.runtimeSessionId ? { runtimeSessionId: control.runtimeSessionId } : {}),
        ...(control.signal ? { signal: control.signal } : {})
      })
    }
    for (
      let attempt = 0;
      attempt < 20 && (status.state !== 'ready' || !status.hasEndpoint);
      attempt += 1
    ) {
      if (status.state === 'error' || status.state === 'exited' || status.state === 'stopped') {
        break
      }
      await deps.delay(250)
      status = deps.jupyterServerRegistry.status(projectCwd)
    }
    if (status.state !== 'ready' || !status.hasEndpoint) {
      throw new Error(status.message ?? 'Jupyter Server 尚未就绪')
    }
  }

  return { ensureJupyterServerReady }
}
