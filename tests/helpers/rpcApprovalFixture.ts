import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import {
  RpcApprovalBridge,
  type RpcApprovalBridgeOptions,
  type RpcApprovalRun
} from '../../src/main/agent/engine/rpc/approval-bridge'
import {
  createApprovalEnvelope,
  RPC_APPROVAL_TITLE,
  type RpcApprovalIdentity
} from '../../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import { createBootstrapFixture } from '../engine-contract/bootstrap-stdio-fixture'
import {
  createRpcToolApprovalExtension,
  type RpcToolApprovalOptions
} from '../../src/main/agent/engine/phi-extension/extensions/rpc-tool-approval'
import { createInitializationWire, deferred } from './rpc-initialization-wire'

export { deferred }
export const approvalIdentity: RpcApprovalIdentity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'phi-session',
  ompSessionId: 'omp-session',
  projectId: 'project',
  cwd: '/project',
  generation: 1,
  runId: 'run-1'
}
export async function approvalWire(
  overrides: Partial<Omit<RpcApprovalBridgeOptions, 'connection' | 'scope'>> = {}
): Promise<{
  wire: ReturnType<typeof createInitializationWire>
  connection: RpcConnection
  bridge: RpcApprovalBridge
  runController: AbortController
  setRun(value: RpcApprovalRun | undefined): void
  emit(id: string, changes?: Record<string, unknown>): void
  responses(): Array<Record<string, unknown>>
  close(): Promise<void>
}> {
  const wire = createInitializationWire((command) => command.type === 'extension_ui_response')
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  const runController = new AbortController()
  let run: RpcApprovalRun | undefined = Object.freeze({
    id: approvalIdentity.runId,
    signal: runController.signal,
    authorizeCall: () => 'main' as const
  })
  const bridge = new RpcApprovalBridge({
    connection,
    scope: { ...approvalIdentity, currentRun: () => run },
    shouldGate: () => true,
    requestToolApproval: () => 'approved',
    ...overrides
  })
  return {
    wire,
    connection,
    bridge,
    runController,
    setRun: (value) => {
      run = value
    },
    emit(id, changes = {}) {
      wire.emit({
        type: 'extension_ui_request',
        method: 'confirm',
        id,
        title: RPC_APPROVAL_TITLE,
        message: JSON.stringify(
          createApprovalEnvelope(approvalIdentity, `call-${id}`, 'write', {
            path: 'note.txt',
            content: 'approved text'
          })
        ),
        ...changes
      })
    },
    responses: () => wire.commands.filter((command) => command.type === 'extension_ui_response'),
    async close() {
      bridge.dispose()
      await connection.close()
    }
  }
}

/** Real CLI; the fixture-only factory activates this module without changing production readonly entry. */
export async function realApprovalFixture(
  options: { ready?: boolean; classify?: boolean } = {}
): Promise<Awaited<ReturnType<typeof createBootstrapFixture>> & { identity: RpcApprovalIdentity }> {
  const f = await createBootstrapFixture({ missingEntry: true })
  const modulePath = fileURLToPath(
    new URL(
      '../../src/main/agent/engine/phi-extension/extensions/rpc-tool-approval.ts',
      import.meta.url
    )
  )
  writeFileSync(
    join(f.root, 'missing-entry.ts'),
    `import { createRpcToolApprovalExtension } from ${JSON.stringify(modulePath)};
export default async (pi) => {
  let ompSessionId = '';
  const lifetime = new AbortController();
  pi.on('session_start', (_, ctx) => { ompSessionId = ctx.sessionManager.getSessionId(); });
  pi.registerCommand('phi-approval-fixture', { description: 'Approval fixture loaded', handler: async () => {} });
  await createRpcToolApprovalExtension({
    readiness: () => (${options.ready === false ? 'undefined' : `{ nonce: ${JSON.stringify(approvalIdentity.nonce)}, phiSessionId: 'phi-session', ompSessionId, projectId: 'project', cwd: ${JSON.stringify(f.cwd)}, generation: 1, runId: 'run-1', signal: lifetime.signal }`}),
    classifyTool: (name) => ${options.classify === false ? 'undefined' : `['write', 'edit'].includes(name) ? 'write' : ['bash', 'powershell'].includes(name) ? 'exec' : ['read', 'grep', 'glob'].includes(name) ? 'read' : undefined`}
  })(pi);
};`,
    { mode: 0o600 }
  )
  try {
    await f.connection.start()
    const commands = await f.connection.request<{
      commands: Array<{ name: string; description?: string }>
    }>({ type: 'get_available_commands' })
    if (
      !commands.commands.some(
        (command) =>
          command.name === 'phi-approval-fixture' &&
          command.description === 'Approval fixture loaded'
      )
    )
      throw new Error(`Approval fixture did not load: ${f.stderr()}`)
    const state = await f.connection.request<{ sessionId: string }>({ type: 'get_state' })
    return { ...f, identity: { ...approvalIdentity, cwd: f.cwd, ompSessionId: state.sessionId } }
  } catch (error) {
    await f.close()
    throw error
  }
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
/** Narrow hook capture only; never creates a fake SDK session or engine. Real CLI is the effect oracle. */
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
