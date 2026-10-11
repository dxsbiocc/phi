import { basename, isAbsolute, resolve } from 'node:path'
import type {
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult,
  WrapperResultReadRequest
} from '../../../shared/wrapperResultTypes'
import type { FileTransferCoordinator } from '../transfer'
import { getPhiAgentDir } from '../runtime-paths'
import type { RemoteStdioProcess } from './remote-ssh-session'
import {
  captureWrapperDownloadTarget,
  transferAuthorizedWrapperResult
} from './remote-result-transfer'
import { withAuthorizedWrapperResultPath, type WrapperResultDependencies } from './remote-results'

const activeDestinations = new Set<string>()

export function validateWrapperResultDownloadRequest(input: unknown): WrapperResultReadRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Wrapper 下载请求无效')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['projectId', 'hostProfileId', 'runId', 'scope', 'path', 'requestId'].includes(key)
    ) ||
    typeof record.projectId !== 'string' ||
    typeof record.hostProfileId !== 'string' ||
    typeof record.runId !== 'string' ||
    (record.scope !== 'run' && record.scope !== 'output') ||
    typeof record.path !== 'string' ||
    !record.path ||
    record.path.startsWith('/') ||
    /^ssh:\/\//i.test(record.path) ||
    record.path.split('/').includes('..') ||
    record.path.includes('\0') ||
    typeof record.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(record.requestId)
  ) {
    throw new Error('Wrapper 下载请求只能指定已保存的运行与相对文件路径')
  }
  return record as unknown as WrapperResultReadRequest
}

function pathRequest(request: WrapperResultReadRequest): Record<string, unknown> {
  return {
    projectId: request.projectId,
    hostProfileId: request.hostProfileId,
    runId: request.runId,
    scope: request.scope,
    ...(request.path !== undefined ? { path: request.path } : {})
  }
}

/** Main-process only: destination comes from the native save dialog, never the renderer. */
export async function downloadWrapperResultToPath(
  input: unknown,
  destinationInput: string,
  dependencies: WrapperResultDependencies & {
    onProgress?: (progress: WrapperResultDownloadProgress) => void
    expectedSha256?: string
    transferCoordinator?: FileTransferCoordinator
    transferHelperConnect?: () => Promise<RemoteStdioProcess>
  } = {}
): Promise<Extract<WrapperResultDownloadResult, { status: 'saved' }>> {
  const request = validateWrapperResultDownloadRequest(input)
  if (
    !isAbsolute(destinationInput) ||
    destinationInput.includes('\0') ||
    basename(destinationInput) === '.' ||
    basename(destinationInput) === '..'
  ) {
    throw new Error('本地保存路径必须来自有效的绝对文件位置')
  }
  const destination = resolve(destinationInput)
  if (activeDestinations.has(destination)) throw new Error('该本地文件正在下载中')
  activeDestinations.add(destination)
  try {
    return await withAuthorizedWrapperResultPath(
      pathRequest(request),
      async (authorized, session) => {
        const transferred = await transferAuthorizedWrapperResult({
          requestId: request.requestId,
          authorized,
          session,
          destination,
          agentDir: dependencies.agentDir ?? getPhiAgentDir(),
          signal: dependencies.signal,
          expectedSha256: dependencies.expectedSha256,
          onProgress: dependencies.onProgress,
          targetBefore: await captureWrapperDownloadTarget(destination),
          coordinator: dependencies.transferCoordinator,
          helperConnect: dependencies.transferHelperConnect
        })
        return {
          status: 'saved' as const,
          path: destination,
          bytes: transferred.bytes,
          sha256: `sha256:${transferred.sha256}`,
          remoteDigestVerified: true
        }
      },
      dependencies
    )
  } finally {
    activeDestinations.delete(destination)
  }
}
