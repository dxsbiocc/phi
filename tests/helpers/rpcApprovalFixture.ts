import {
  createRpcToolApprovalExtension,
  type RpcToolApprovalOptions
} from '../../src/main/agent/engine/phi-extension/extensions/rpc-tool-approval'
import type { RpcApprovalIdentity } from '../../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'

export function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export const approvalIdentity: RpcApprovalIdentity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'phi-session',
  ompSessionId: 'omp-session',
  projectId: 'project',
  cwd: '/project',
  generation: 1,
  runId: 'run-1'
}

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected approval state did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface ApprovalHookContext {
  cwd: string
  agent: { kind: 'main' | 'sub' }
  sessionManager: { getSessionId(): string }
  ui: {
    confirm(
      title: string,
      message: string,
      options?: { signal?: AbortSignal; timeout?: number }
    ): Promise<boolean>
  }
}

type ApprovalHook = (
  event: {
    type: 'tool_call'
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  },
  context: ApprovalHookContext
) => Promise<unknown>

export async function captureApprovalHook(options: RpcToolApprovalOptions): Promise<ApprovalHook> {
  let hook: ApprovalHook | undefined
  const factory = createRpcToolApprovalExtension(options)
  type Api = Parameters<typeof factory>[0]
  const api = {
    on(event: string, callback: unknown): void {
      if (event === 'tool_call') hook = callback as ApprovalHook
    }
  }
  await factory(api as unknown as Api)
  if (!hook) throw new Error('Expected tool_call handler')
  return hook
}
