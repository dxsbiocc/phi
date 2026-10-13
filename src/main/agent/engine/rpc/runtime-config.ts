import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { WorkspaceHost } from '../../workspace-host/types'
import type { RemoteUploadFileOptions } from '../../transfer/remote-upload-types'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'
import { privateRemotePrefix } from './extension-deployment/remote-commands'
import {
  RPC_RUNTIME_FILE,
  RPC_RUNTIME_MAX_BYTES,
  type RpcRuntimeConfig
} from '../phi-extension/lib/rpc-runtime-config'
import { storageHost } from './session-storage/remote-preflight'
import type { RpcRuntimePreparationContext } from './ssh-stdio-factory'

/** Only registered writer-owned launch context can publish capability material. */
export async function publishRpcRuntimeConfig(options: {
  readonly context: RpcRuntimePreparationContext
  readonly host: WorkspaceHost
  readonly config: RpcRuntimeConfig
  readonly uploadOptions?: RemoteUploadFileOptions
}): Promise<void> {
  const { context, host, config } = options
  const storage = context.storage
  if (!storage || storageHost(storage) !== host || !host.transfer)
    throw new Error('RPC composition requires registered persistent storage')
  storage.lease.assertActive()
  if (
    config.nonce !== context.bootstrap.nonce ||
    config.phiSessionId !== context.params.sessionId ||
    config.projectId !== storage.scope.projectId ||
    config.projectRoot !== storage.scope.projectRoot ||
    config.generation !== context.generation ||
    config.generationDirectory !== context.generationDirectory ||
    config.directory !== storage.paths.directory ||
    config.journals !== storage.paths.journals ||
    config.blobs !== storage.paths.blobs
  )
    throw new Error('RPC runtime publication differs from its owned launch')
  const bytes = Buffer.from(JSON.stringify(config))
  if (bytes.length > RPC_RUNTIME_MAX_BYTES)
    throw new Error('RPC runtime configuration exceeds its supported byte limit')
  const path = posix.join(context.generationDirectory, RPC_RUNTIME_FILE)
  const local = await mkdtemp(join(tmpdir(), 'phi-rpc-runtime-'))
  try {
    const source = join(local, RPC_RUNTIME_FILE)
    await writeFile(source, bytes, { mode: 0o600, flag: 'wx' })
    const digest = createHash('sha256').update(bytes).digest('hex')
    await host.transfer.uploadFile(source, path, {
      ...options.uploadOptions,
      signal: context.signal,
      expectedSha256: digest
    })
    context.signal.throwIfAborted()
    const result = await host.exec.run(
      [
        'sh',
        '-c',
        `${privateRemotePrefix(storage.scope.runtimeRoot)}\nprivate_file ${q(path)}\n[ "$(hash_file ${q(path)})" = ${q(digest)} ] || fail 'Private runtime configuration was corrupted'`
      ],
      {
        cwd: storage.scope.runtimeRoot,
        signal: context.signal,
        timeoutMs: 30_000,
        maxOutputBytes: 1024
      }
    )
    if (result.code !== 0 || result.truncated || result.terminationReason)
      throw new Error('Cannot publish private RPC runtime configuration')
    storage.lease.assertActive()
    context.signal.throwIfAborted()
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}
