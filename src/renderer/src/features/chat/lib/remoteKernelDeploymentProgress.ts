import type { ChatItem } from '../../../types'
import { defineCopy } from '../../../lib/i18n'

type RemoteKernelDeploymentProgressEvent = {
  type?: string
  runId?: string
  phase?: unknown
  bytesTransferred?: unknown
  totalBytes?: unknown
  createdAt?: string
}

const copy = defineCopy(
  {
    checking: 'Checking remote runtime components…',
    uploading: 'Uploading remote runtime components…',
    uploadingBytes: (transferred: string, total: string) =>
      `Uploading remote runtime components: ${transferred} / ${total} MB`,
    verifying: 'Verifying remote runtime components…'
  },
  {
    checking: '正在检查远程运行组件…',
    uploading: '正在上传远程运行组件…',
    uploadingBytes: (transferred: string, total: string) =>
      `正在上传远程运行组件：${transferred} / ${total} MB`,
    verifying: '正在验证远程运行组件…'
  }
)

const progressId = (runId?: string): string =>
  `remote-kernel-deployment-${runId && runId.length > 0 ? runId : 'current'}`

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function formatMib(bytes: number): string {
  const value = bytes / (1024 * 1024)
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1).replace(/\.0$/u, '')
}

function content(event: RemoteKernelDeploymentProgressEvent): string {
  if (
    event.phase === 'uploading' &&
    validBytes(event.bytesTransferred) &&
    validBytes(event.totalBytes) &&
    event.totalBytes > 0
  ) {
    return copy.uploadingBytes(
      formatMib(Math.min(event.bytesTransferred, event.totalBytes)),
      formatMib(event.totalBytes)
    )
  }
  if (event.phase === 'uploading') return copy.uploading
  if (event.phase === 'verifying') return copy.verifying
  return copy.checking
}

function item(event: RemoteKernelDeploymentProgressEvent): ChatItem | null {
  if (!['checking', 'uploading', 'verifying'].includes(String(event.phase))) return null
  return {
    id: progressId(event.runId),
    role: 'warning',
    noticeKind: 'remote_kernel_deployment',
    ...(event.runId ? { runId: event.runId } : {}),
    get content() {
      return content(event)
    },
    ...(event.createdAt ? { createdAt: event.createdAt } : {})
  }
}

export function applyRemoteKernelDeploymentProgress(
  items: ChatItem[],
  event: RemoteKernelDeploymentProgressEvent
): boolean {
  if (event.type !== 'remote_kernel_deployment_progress') return false
  const id = progressId(event.runId)
  const index = items.findIndex((candidate) => candidate.id === id)
  const next = item(event)
  if (!next) {
    if (index >= 0) items.splice(index, 1)
    return true
  }
  if (index >= 0) items[index] = next
  else items.push(next)
  return true
}

export function clearRemoteKernelDeploymentProgress(
  items: ChatItem[],
  runId: string | undefined
): void {
  const id = progressId(runId)
  const index = items.findIndex((candidate) => candidate.id === id)
  if (index >= 0) items.splice(index, 1)
}
