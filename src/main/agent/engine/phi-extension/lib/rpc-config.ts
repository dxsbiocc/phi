import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const RPC_BOOTSTRAP_CONFIG_ENV = 'PHI_RPC_CONFIG'
export const RPC_BOOTSTRAP_OMP_VERSION = '18.10.3'
export const RPC_BOOTSTRAP_COMMAND = 'phi-rpc-attest'
export const RPC_BOOTSTRAP_DESCRIPTION = 'Phi RPC bootstrap attestation v1'

export interface RpcBootstrapConfig {
  schema: 1
  nonce: string
  sessionId: string
  projectId: string
  projectRoot: string
  ompVersion: typeof RPC_BOOTSTRAP_OMP_VERSION
  contentHash: string
}

export interface RpcBootstrapAttestation {
  type: 'phi_rpc_bootstrap_attestation'
  protocolVersion: 1
  nonce: string
  sessionId: string
  projectId: string
  projectRoot: string
  ompVersion: typeof RPC_BOOTSTRAP_OMP_VERSION
  contentHash: string
  guards: { projectBoundary: true; remoteUrl: true; writes: 'deny' }
}

const keys = [
  'schema',
  'nonce',
  'sessionId',
  'projectId',
  'projectRoot',
  'ompVersion',
  'contentHash'
]
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  ![...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)

/** Pure JSON only; no provider keys, runtime callbacks or settings discovery. */
export function validateRpcBootstrapConfig(value: unknown): RpcBootstrapConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Phi RPC bootstrap config must be an object')
  const config = value as Record<string, unknown>
  if (Object.keys(config).length !== keys.length || keys.some((key) => !Object.hasOwn(config, key)))
    throw new Error('Phi RPC bootstrap config has unexpected or missing fields')
  if (
    config.schema !== 1 ||
    config.ompVersion !== RPC_BOOTSTRAP_OMP_VERSION ||
    !identity(config.sessionId) ||
    !identity(config.projectId) ||
    typeof config.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(config.nonce) ||
    typeof config.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(config.contentHash) ||
    typeof config.projectRoot !== 'string' ||
    !isAbsolute(config.projectRoot) ||
    config.projectRoot !== resolve(config.projectRoot) ||
    config.projectRoot !== realpathSync(config.projectRoot) ||
    !statSync(config.projectRoot).isDirectory()
  )
    throw new Error('Phi RPC bootstrap config identity is invalid')
  return Object.freeze(config) as unknown as RpcBootstrapConfig
}

/** O_NOFOLLOW plus fd metadata avoids accepting a symlink or a broadly readable config. */
export function loadRpcBootstrapConfig(path: string | undefined): RpcBootstrapConfig {
  if (!path || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw new Error('Phi RPC bootstrap requires an absolute canonical config file')
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const metadata = fstatSync(descriptor)
    if (
      !metadata.isFile() ||
      metadata.size > 16 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())
    )
      throw new Error('Phi RPC bootstrap config must be a private owned file under 16 KiB')
    const bytes = Buffer.alloc(16 * 1024 + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size === bytes.length) throw new Error('Phi RPC bootstrap config exceeds 16 KiB')
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
    return validateRpcBootstrapConfig(JSON.parse(json))
  } finally {
    closeSync(descriptor)
  }
}
