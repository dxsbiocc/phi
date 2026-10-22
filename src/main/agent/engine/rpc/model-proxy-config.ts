import { posix } from 'node:path'
import type { SafeModelDescriptor } from '../model-gateway-types'
import {
  RPC_MODEL_METADATA_FILENAME,
  RPC_MODEL_METADATA_MAX_BYTES,
  validateRpcModelMetadata,
  type RpcModelMetadata
} from '../phi-extension/lib/rpc-model-metadata'
import type { RemoteSshSession } from '../../wrappers/remote-ssh-session'
import { assertTunnelPort } from '../../wrappers/remote-ssh-reverse-tunnel'
import { privateRemotePrefix } from './extension-deployment/remote-commands'
import type { RpcStartupTransactionWriter } from './startup-transaction'

export interface RemoteModelProxyConfigOptions {
  readonly session: Pick<RemoteSshSession, 'execWithInput' | 'execBounded'>
  readonly startup: RpcStartupTransactionWriter
  readonly agentDir: string
  readonly models: readonly SafeModelDescriptor[]
  readonly remotePort: number
  readonly gatewayBearer: string
  readonly cursor?: { readonly remotePort: number; readonly bearer: string }
  readonly sessionId: string
  readonly projectRoot: string
  readonly gatewayGeneration: number
  readonly signal?: AbortSignal
}

export type ModelProxyConfigPublication = Pick<
  RpcModelMetadata,
  'nonce' | 'sessionId' | 'projectRoot' | 'gatewayGeneration'
>

type RoutingOptions = Pick<
  RemoteModelProxyConfigOptions,
  'models' | 'remotePort' | 'gatewayBearer' | 'cursor'
>

/** SDK schema placeholders only. Exact nullable limits require the paired metadata selection. */
export function serializeRemoteModelProxyConfig(options: RoutingOptions): string {
  assertTunnelPort(options.remotePort)
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.gatewayBearer))
    throw new Error('Invalid model gateway bearer')
  const providers: Record<string, Record<string, unknown>> = Object.create(null)
  if (!Array.isArray(options.models) || !options.models.length)
    throw new Error('Model gateway needs an approved model')
  if (options.cursor) {
    assertTunnelPort(options.cursor.remotePort)
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.cursor.bearer))
      throw new Error('Invalid Cursor gateway bearer')
  }
  for (const model of options.models) {
    const safe: Record<string, unknown> = {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens })
    }
    if (model.cost !== undefined) {
      const { input, output, cacheRead, cacheWrite } = model.cost
      safe.cost = { input, output, cacheRead, cacheWrite }
    }
    if (model.provider === 'cursor' && !options.cursor)
      throw new Error('Cursor model requires its scoped native tunnel')
    if (model.provider === 'cursor') {
      // OMP's custom-model schema does not accept the bundled cursor-agent API.
      // Override only the bundled Cursor row so its native API and tool handlers
      // remain intact. The selected row is checked again by the RPC extension.
      const baseUrl = `http://127.0.0.1:${options.cursor!.remotePort}`
      const provider = (providers.cursor ??= {
        baseUrl,
        apiKey: options.cursor!.bearer,
        modelOverrides: Object.create(null)
      })
      const overrides = provider.modelOverrides as Record<string, unknown>
      overrides[model.id] = {
        ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens })
      }
    } else {
      const provider = (providers[model.provider] ??= {
        baseUrl: `http://127.0.0.1:${options.remotePort}`,
        transport: 'pi-native',
        api: 'openai-completions',
        apiKey: options.gatewayBearer,
        models: [] as Array<Record<string, unknown>>
      })
      ;(provider.models as Array<Record<string, unknown>>).push(safe)
    }
  }
  const content = JSON.stringify({ providers })
  if (Buffer.byteLength(content) > RPC_MODEL_METADATA_MAX_BYTES)
    throw new Error('Model proxy configuration exceeds the private write limit')
  return content
}

function generationPaths(agentDir: string): { root: string; nonce: string; directories: string[] } {
  if (
    !posix.isAbsolute(agentDir) ||
    posix.normalize(agentDir) !== agentDir ||
    /[\0\r\n]/.test(agentDir)
  )
    throw new Error('Model proxy config requires a canonical private generation directory')
  const match = /^(.*)\/rpc-sessions\/([A-Za-z0-9_-]{16,128})\/home\/(\.omp\/)?agent$/.exec(
    agentDir
  )
  if (!match) throw new Error('Model proxy config cannot use a shared or user agent directory')
  const root = match[1]
  privateRemotePrefix(root)
  const session = posix.join(root, 'rpc-sessions', match[2])
  return {
    root,
    nonce: match[2],
    directories: [
      posix.join(root, 'rpc-sessions'),
      session,
      posix.join(session, 'home'),
      ...(match[3] ? [posix.join(session, 'home', '.omp')] : []),
      agentDir
    ]
  }
}

function metadataFor(options: RemoteModelProxyConfigOptions, nonce: string): RpcModelMetadata {
  // Never spread a Model, including nested cost objects, into the sidecar.
  return validateRpcModelMetadata({
    schema: 1,
    nonce,
    sessionId: options.sessionId,
    projectRoot: options.projectRoot,
    gatewayGeneration: options.gatewayGeneration,
    models: options.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.cost === undefined
        ? {}
        : {
            cost: {
              input: model.cost.input,
              output: model.cost.output,
              cacheRead: model.cost.cacheRead,
              cacheWrite: model.cost.cacheWrite
            }
          })
    }))
  })
}

const activeWrites = new Map<string, Promise<void>>()

async function waitForWrite(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  let cancel!: () => void
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal?.reason)
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
      })
    ])
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** Called only before generation startup; both files must be confirmed before RPC can launch. */
export async function writeRemoteModelProxyConfig(
  options: RemoteModelProxyConfigOptions
): Promise<ModelProxyConfigPublication> {
  options.signal?.throwIfAborted()
  const previous = activeWrites.get(options.agentDir) ?? Promise.resolve()
  let release!: () => void
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => finished)
  activeWrites.set(options.agentDir, current)
  void current.then(() => {
    if (activeWrites.get(options.agentDir) === current) activeWrites.delete(options.agentDir)
  })
  try {
    await waitForWrite(previous, options.signal)
    return await publish(options)
  } finally {
    release()
  }
}

async function publish(
  options: RemoteModelProxyConfigOptions
): Promise<ModelProxyConfigPublication> {
  const { signal } = options
  const { nonce } = generationPaths(options.agentDir)
  const metadata = metadataFor(options, nonce)
  const modelsContent = `${serializeRemoteModelProxyConfig({ ...options, models: metadata.models })}\n`
  const metadataContent = `${JSON.stringify(metadata)}\n`
  if (Buffer.byteLength(metadataContent) > RPC_MODEL_METADATA_MAX_BYTES)
    throw new Error('Safe model metadata exceeds the private write limit')
  signal?.throwIfAborted()
  options.startup.addFile({
    item: 'model-proxy-config',
    path: posix.join(options.agentDir, 'models.yml'),
    bytes: Buffer.from(modelsContent),
    mode: 0o600,
    ifAbsent: true
  })
  options.startup.addFile({
    item: 'model-proxy-metadata',
    path: posix.join(options.agentDir, RPC_MODEL_METADATA_FILENAME),
    bytes: Buffer.from(metadataContent),
    mode: 0o600,
    ifAbsent: true
  })
  signal?.throwIfAborted()
  return Object.freeze({
    nonce,
    sessionId: metadata.sessionId,
    projectRoot: metadata.projectRoot,
    gatewayGeneration: metadata.gatewayGeneration
  })
}
