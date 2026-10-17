import { posix } from 'node:path'
import type { WorkspaceHost } from '../../workspace-host/types'
import type { RemoteUploadFileOptions } from '../../transfer/remote-upload-types'
import {
  RPC_RUNTIME_FILE,
  RPC_RUNTIME_MAX_BYTES,
  type RpcRuntimeConfig
} from '../phi-extension/lib/rpc-runtime-config'
import { storageHost } from './session-storage/remote-preflight'
import type { RpcRuntimePreparationContext } from './ssh-stdio-factory'
import { executionRoster } from '../phi-extension/lib/rpc-execution-protocol'

/** Only registered writer-owned launch context can publish capability material. */
export async function publishRpcRuntimeConfig(options: {
  readonly context: RpcRuntimePreparationContext
  readonly host: WorkspaceHost
  readonly config: RpcRuntimeConfig
  readonly uploadOptions?: RemoteUploadFileOptions
}): Promise<void> {
  const { context, host, config } = options
  const storage = context.storage
  const startup = context.startup
  if (!storage || storageHost(storage) !== host || !host.transfer || !startup)
    throw new Error('RPC composition requires registered persistent storage')
  storage.lease.assertActive()
  if (config.childRuntimeRequired !== undefined && typeof config.childRuntimeRequired !== 'boolean')
    throw new Error('Invalid child runtime intent')
  const roster = executionRoster(config.execution.tools, {
    allowNativeTask: config.childRuntimeRequired === true
  })
  if (roster.tools.some((tool) => tool.name === 'task') !== (config.childRuntimeRequired === true))
    throw new Error('Native task requires matching private child runtime intent')
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
  context.signal.throwIfAborted()
  startup.addFile({ item: 'runtime-config', path, bytes, mode: 0o600, ifAbsent: true })
  storage.lease.assertActive()
  context.signal.throwIfAborted()
}
