import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  realpathSync
} from 'node:fs'
import { join } from 'node:path'
import type { RpcRuntimeConfig } from './rpc-runtime-config'
import {
  RPC_PROMPT_POLICY_FILE,
  RPC_PROMPT_POLICY_MAX_BYTES,
  rpcPromptPolicy,
  rpcPromptPolicyHash,
  type RpcPromptPolicy
} from './rpc-prompt-policy'

/** Fixed private sibling with immutable generation publication; no arbitrary path reads. */
export function loadRpcPromptPolicy(
  runtime: RpcRuntimeConfig
): Readonly<RpcPromptPolicy> | undefined {
  if (!runtime.promptPolicyHash) return undefined
  const path = join(runtime.generationDirectory, RPC_PROMPT_POLICY_FILE)
  if (realpathSync(path) !== path) throw new Error('Phi prompt publication must be canonical')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > RPC_PROMPT_POLICY_MAX_BYTES
    )
      throw new Error('Invalid private Phi prompt publication')
    const buffer = Buffer.alloc(RPC_PROMPT_POLICY_MAX_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
    if (size !== stat.size || size > RPC_PROMPT_POLICY_MAX_BYTES)
      throw new Error('Phi prompt publication changed')
    for (const current of [fstatSync(fd), lstatSync(path)])
      if (
        ['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].some(
          (key) => current[key as keyof typeof current] !== stat[key as keyof typeof stat]
        )
      )
        throw new Error('Phi prompt publication changed')
    const policy = rpcPromptPolicy(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    )
    if (
      rpcPromptPolicyHash(policy) !== runtime.promptPolicyHash ||
      policy.nonce !== runtime.nonce ||
      policy.phiSessionId !== runtime.phiSessionId ||
      policy.projectId !== runtime.projectId ||
      policy.projectRoot !== runtime.projectRoot ||
      policy.generation !== runtime.generation
    )
      throw new Error('Phi prompt generation identity changed')
    return policy
  } finally {
    closeSync(fd)
  }
}
