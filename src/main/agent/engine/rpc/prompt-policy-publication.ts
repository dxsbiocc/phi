import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { createHash } from 'node:crypto'
import type { RpcRuntimePreparationContext } from './ssh-stdio-factory'
import type { RemoteSessionRuntimeOptions } from './remote-session-runtime'
import {
  RPC_PROMPT_POLICY_FILE,
  rpcPromptPolicy,
  rpcPromptPolicyHash,
  type RpcPromptPolicy
} from '../phi-extension/lib/rpc-prompt-policy'
import { privateRemotePrefix } from './extension-deployment/remote-commands'
import { storageHost } from './session-storage/remote-preflight'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'

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
  context.signal.throwIfAborted()
  options.assertCurrent()
  if (
    !context.storage ||
    storageHost(context.storage) !== runtime.runtimeHost ||
    !runtime.runtimeHost.transfer
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
  const local = await mkdtemp(join(tmpdir(), 'phi-prompt-publication-'))
  try {
    const source = join(local, RPC_PROMPT_POLICY_FILE),
      destination = posix.join(context.generationDirectory, RPC_PROMPT_POLICY_FILE)
    await writeFile(source, bytes, { mode: 0o600, flag: 'wx' })
    context.signal.throwIfAborted()
    options.assertCurrent()
    await runtime.runtimeHost.transfer.uploadFile(source, destination, {
      ...runtime.uploadOptions,
      signal: context.signal,
      expectedSha256: createHash('sha256').update(bytes).digest('hex')
    })
    options.assertCurrent()
    const result = await runtime.runtimeHost.exec.run(
      [
        'sh',
        '-c',
        privateRemotePrefix(runtime.runtimeRoot) +
          `\nprivate_file ${q(destination)}\n[ "$(hash_file ${q(destination)})" = ${q(hash)} ] || fail 'Phi prompt publication was corrupted'`
      ],
      {
        cwd: runtime.runtimeRoot,
        signal: context.signal,
        timeoutMs: 30000,
        maxOutputBytes: 1024
      }
    )
    if (result.code !== 0 || result.truncated || result.terminationReason)
      throw new Error('Cannot publish private Phi prompt policy')
    context.storage.lease.assertActive()
    context.signal.throwIfAborted()
    options.assertCurrent()
    return hash
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}
