import { readableErrorMessage } from '../../../lib/sessionNotifications'
import type {
  AnalysisNotebookFile,
  JupyterServerStatus,
  NotebookCellJumpTarget,
  RendererApi
} from '../../../types'

export function analysisNotebookMatchesTarget(
  file: AnalysisNotebookFile,
  target: NotebookCellJumpTarget
): boolean {
  return (
    (target.path !== undefined && file.path === target.path) ||
    (target.relativePath !== undefined && file.relativePath === target.relativePath)
  )
}

export function cacheAnalysisNotebookFile(
  cache: Map<string, AnalysisNotebookFile>,
  file: AnalysisNotebookFile
): Map<string, AnalysisNotebookFile> {
  const next = new Map(cache)
  next.set(file.path, file)
  next.set(file.relativePath, file)
  return next
}

export function removeAnalysisNotebookFileCacheEntry(
  cache: Map<string, AnalysisNotebookFile>,
  path: string
): Map<string, AnalysisNotebookFile> {
  const next = new Map(cache)
  const file = next.get(path)
  if (file) {
    next.delete(file.path)
    next.delete(file.relativePath)
  }
  next.delete(path)
  return next
}

export function requireRendererApiMethod<K extends keyof RendererApi>(
  rendererApi: RendererApi,
  method: K,
  fallbackMessage: string
): RendererApi[K] {
  const candidate = rendererApi[method]
  if (typeof candidate !== 'function') {
    throw new Error(fallbackMessage)
  }
  return candidate
}

export function jupyterServerIsReady(status: JupyterServerStatus | null | undefined): boolean {
  return status?.state === 'ready' && status.hasEndpoint
}

export function missingJupyterRuntimeHandler(error: unknown): boolean {
  const message = readableErrorMessage(error, '')
  return (
    message.includes("No handler registered for 'analysis:jupyterRuntimeStatus'") ||
    message.includes('analysis:jupyterRuntimeStatus')
  )
}

export function notebookEnvironmentErrorMessage(error: unknown, fallback: string): string {
  const message = readableErrorMessage(error, fallback)
  const environmentNotBuilt =
    message.includes('环境未构建') ||
    /环境[^。\n]*尚未构建/u.test(message) ||
    /environment\s+\S+\s+is not (?:ready|built)/iu.test(message)
  if (!environmentNotBuilt || message.includes('设置 → 环境')) return message
  return `${message} 请前往“设置 → 环境”的“托管环境”构建后重试。`
}

export function waitForRendererDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
