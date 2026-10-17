import { posix } from 'node:path'
import type { RpcRuntimePreparationContext } from './ssh-stdio-factory'
import type { RemoteSessionRuntimeOptions } from './remote-session-runtime'
import {
  RPC_PROMPT_POLICY_FILE,
  rpcPromptPolicy,
  rpcPromptPolicyHash,
  type RpcPromptPolicy
} from '../phi-extension/lib/rpc-prompt-policy'
import { storageHost } from './session-storage/remote-preflight'

export async function publishRpcPromptPolicy(options: {
  context: RpcRuntimePreparationContext
  runtime: RemoteSessionRuntimeOptions['transport']['runtime']
  policy: Omit<
    RpcPromptPolicy,
    'schema' | 'nonce' | 'phiSessionId' | 'projectId' | 'projectRoot' | 'generation'
  >
  assertCurrent(): void
}): Promise<string> {
  const { context, runtime } = options
  const startup = context.startup
  context.signal.throwIfAborted()
  options.assertCurrent()
  if (
    !context.storage ||
    storageHost(context.storage) !== runtime.runtimeHost ||
    !runtime.runtimeHost.transfer ||
    !startup
  )
    throw new Error('Phi prompt publication requires its registered writer host')
  context.storage.lease.assertActive()
  const policy = rpcPromptPolicy({
    ...options.policy,
    schema: 1,
    nonce: context.bootstrap.nonce,
    phiSessionId: context.params.sessionId,
    projectId: context.bootstrap.projectId,
    projectRoot: context.params.cwd,
    generation: context.generation
  })
  const bytes = Buffer.from(JSON.stringify(policy)),
    hash = rpcPromptPolicyHash(policy)
  const destination = posix.join(context.generationDirectory, RPC_PROMPT_POLICY_FILE)
  context.signal.throwIfAborted()
  options.assertCurrent()
  startup.addFile({
    item: 'prompt-policy',
    path: destination,
    bytes,
    mode: 0o600,
    ifAbsent: true
  })
  options.assertCurrent()
  context.storage.lease.assertActive()
  context.signal.throwIfAborted()
  options.assertCurrent()
  return hash
}
