import { protocolErrorCodes, type ProtocolErrorCode } from '../../../../../shared/kernel-protocol'
import { defineCopy } from '../../../lib/i18n'

export type KernelRecoveryAction = 'retry' | 'reopen' | 'reconnect' | 'refresh'

export interface KernelErrorPresentation {
  readonly code: ProtocolErrorCode
  readonly message: string
  readonly action: KernelRecoveryAction
  readonly actionLabel: string
}

const copy = defineCopy(
  {
    messages: {
      VERSION_UNSUPPORTED: 'This version of Phi cannot use the selected kernel.',
      NOT_NEGOTIATED: 'The kernel connection was not ready.',
      STALE_GENERATION: 'This request belongs to an older kernel connection.',
      NOT_CONTROLLER: 'Another connection currently controls this kernel.',
      UNKNOWN_METHOD: 'The running kernel does not support this operation.',
      INVALID_FRAME: 'The kernel received an invalid request.',
      INVALID_PARAMS: 'The kernel could not use these request parameters.',
      FRAME_TOO_LARGE: 'This request is too large for the kernel.',
      DUPLICATE_REQUEST: 'This request was already accepted.',
      SESSION_NOT_FOUND: 'The kernel session is no longer open.',
      SESSION_BUSY: 'This chat already has an active kernel operation.',
      MODEL_UNAVAILABLE: 'The selected model is unavailable.',
      MODEL_UNREACHABLE: 'Model access is temporarily unreachable.',
      MODEL_UNAUTHENTICATED: 'The selected model provider needs authentication.',
      MODEL_CONNECTION_LOST: 'The model connection was lost after output began.',
      CAPABILITY_UNAVAILABLE: 'This kernel capability is unavailable for the chat.',
      REPLAY_GAP: 'Some kernel events are no longer available for replay.',
      CANCELLED: 'The kernel operation was cancelled.',
      INTERNAL: 'The kernel could not complete the operation.'
    },
    actions: {
      retry: 'Try again.',
      reopen: 'Reopen the chat.',
      reconnect: 'Reconnect to the execution host.',
      refresh: 'Refresh the chat state.'
    }
  },
  {
    messages: {
      VERSION_UNSUPPORTED: '当前 Phi 版本无法使用所选内核。',
      NOT_NEGOTIATED: '内核连接尚未就绪。',
      STALE_GENERATION: '这次请求属于旧的内核连接。',
      NOT_CONTROLLER: '当前由另一个连接控制此内核。',
      UNKNOWN_METHOD: '正在运行的内核不支持此操作。',
      INVALID_FRAME: '内核收到的请求格式无效。',
      INVALID_PARAMS: '内核无法使用这些请求参数。',
      FRAME_TOO_LARGE: '这次请求超过了内核大小限制。',
      DUPLICATE_REQUEST: '这次请求已经被接受。',
      SESSION_NOT_FOUND: '内核会话已不再打开。',
      SESSION_BUSY: '此会话已有正在进行的内核操作。',
      MODEL_UNAVAILABLE: '所选模型当前不可用。',
      MODEL_UNREACHABLE: '暂时无法连接模型服务。',
      MODEL_UNAUTHENTICATED: '所选模型 Provider 需要重新认证。',
      MODEL_CONNECTION_LOST: '模型开始返回内容后连接中断。',
      CAPABILITY_UNAVAILABLE: '此会话当前无法使用该内核能力。',
      REPLAY_GAP: '部分内核事件已无法重放。',
      CANCELLED: '内核操作已取消。',
      INTERNAL: '内核未能完成此次操作。'
    },
    actions: {
      retry: '请重试。',
      reopen: '请重新打开会话。',
      reconnect: '请重新连接执行主机。',
      refresh: '请刷新会话状态。'
    }
  }
)

export const kernelRecoveryActions: Readonly<Record<ProtocolErrorCode, KernelRecoveryAction>> = {
  VERSION_UNSUPPORTED: 'reopen',
  NOT_NEGOTIATED: 'reconnect',
  STALE_GENERATION: 'reopen',
  NOT_CONTROLLER: 'reconnect',
  UNKNOWN_METHOD: 'refresh',
  INVALID_FRAME: 'refresh',
  INVALID_PARAMS: 'retry',
  FRAME_TOO_LARGE: 'retry',
  DUPLICATE_REQUEST: 'refresh',
  SESSION_NOT_FOUND: 'reopen',
  SESSION_BUSY: 'retry',
  MODEL_UNAVAILABLE: 'retry',
  MODEL_UNREACHABLE: 'reconnect',
  MODEL_UNAUTHENTICATED: 'retry',
  MODEL_CONNECTION_LOST: 'refresh',
  CAPABILITY_UNAVAILABLE: 'reopen',
  REPLAY_GAP: 'refresh',
  CANCELLED: 'retry',
  INTERNAL: 'retry'
}

const prefix = /\[PHI_KERNEL:([A-Z_]+)\]/u

export function kernelErrorPresentation(error: unknown): KernelErrorPresentation | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = message.match(prefix)?.[1]
  if (!code || !protocolErrorCodes.includes(code as ProtocolErrorCode)) return undefined
  const typed = code as ProtocolErrorCode
  const action = kernelRecoveryActions[typed]
  return {
    code: typed,
    message: copy.messages[typed],
    action,
    actionLabel: copy.actions[action]
  }
}

export function localizeKernelError(error: unknown): unknown {
  const presentation = kernelErrorPresentation(error)
  return presentation ? new Error(`${presentation.message} ${presentation.actionLabel}`) : error
}
