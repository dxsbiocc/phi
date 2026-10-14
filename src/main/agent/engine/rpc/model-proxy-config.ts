import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { SafeModelDescriptor } from '../model-gateway-types'
import {
  RPC_MODEL_METADATA_FILENAME,
  RPC_MODEL_METADATA_MAX_BYTES,
  validateRpcModelMetadata,
  type RpcModelMetadata
} from '../phi-extension/lib/rpc-model-metadata'
import { shellQuote as q, type RemoteSshSession } from '../../wrappers/remote-ssh-session'
import { assertTunnelPort } from '../../wrappers/remote-ssh-reverse-tunnel'
import { privateRemotePrefix } from './extension-deployment/remote-commands'

export interface RemoteModelProxyConfigOptions {
  readonly session: Pick<RemoteSshSession, 'execWithInput' | 'execBounded'>
  readonly agentDir: string
  readonly models: readonly SafeModelDescriptor[]
  readonly remotePort: number
  readonly gatewayBearer: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly gatewayGeneration: number
  readonly signal?: AbortSignal
}

export type ModelProxyConfigPublication = Pick<
  RpcModelMetadata,
  'nonce' | 'sessionId' | 'projectRoot' | 'gatewayGeneration'
>

type RoutingOptions = Pick<RemoteModelProxyConfigOptions, 'models' | 'remotePort' | 'gatewayBearer'>

/** SDK schema placeholders only. Exact nullable limits require the paired metadata selection. */
export function serializeRemoteModelProxyConfig(options: RoutingOptions): string {
  assertTunnelPort(options.remotePort)
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.gatewayBearer))
    throw new Error('Invalid model gateway bearer')
  const providers: Record<
    string,
    {
      baseUrl: string
      transport: 'pi-native'
      api: 'openai-completions'
      apiKey: string
      models: Array<Record<string, unknown>>
    }
  > = Object.create(null)
  if (!Array.isArray(options.models) || !options.models.length)
    throw new Error('Model gateway needs an approved model')
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
    const provider = (providers[model.provider] ??= {
      baseUrl: `http://127.0.0.1:${options.remotePort}`,
      transport: 'pi-native',
      api: 'openai-completions',
      apiKey: options.gatewayBearer,
      models: []
    })
    provider.models.push(safe)
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
  const { session, signal } = options
  if (!session.execWithInput || !session.execBounded)
    throw new Error('SSH connection lacks cancellable private stdin configuration writes')
  const { root, nonce, directories } = generationPaths(options.agentDir)
  const metadata = metadataFor(options, nonce)
  const modelsContent = `${serializeRemoteModelProxyConfig({ ...options, models: metadata.models })}\n`
  const metadataContent = `${JSON.stringify(metadata)}\n`
  if (Buffer.byteLength(metadataContent) > RPC_MODEL_METADATA_MAX_BYTES)
    throw new Error('Safe model metadata exceeds the private write limit')
  const modelsHash = createHash('sha256').update(modelsContent).digest('hex')
  const metadataHash = createHash('sha256').update(metadataContent).digest('hex')
  const transaction = posix.join(options.agentDir, `.model-config-${randomUUID()}`)
  const prefix = `cd -- ${q(root)} || exit 1\n${privateRemotePrefix(root)}\n${directories.map((directory) => `[ -d ${q(directory)} ] && [ ! -L ${q(directory)} ] || fail 'Private model generation directory is missing or symbolic'\nprivate_dir ${q(directory)}`).join('\n')}
models=${q(posix.join(options.agentDir, 'models.yml'))}
metadata=${q(posix.join(options.agentDir, RPC_MODEL_METADATA_FILENAME))}
txn=${q(transaction)}
models_hash=${q(modelsHash)}
metadata_hash=${q(metadataHash)}`
  const rollback = `restore_file() {
  target=$1; label=$2; expected=$3
  if [ -e "$target" ] || [ -L "$target" ]; then private_file "$target"; current_hash=$(hash_file "$target"); else current_hash=''; fi
  if [ -f "$txn/old-$label.sha" ] && [ ! -L "$txn/old-$label.sha" ]; then
    private_file "$txn/old-$label.sha"; private_file "$txn/old-$label"
    old_hash=$(cat "$txn/old-$label.sha")
    [ "$(hash_file "$txn/old-$label")" = "$old_hash" ] || fail 'Invalid private model backup'
    if [ -z "$current_hash" ] || [ "$current_hash" = "$expected" ] || [ "$current_hash" = "$old_hash" ]; then mv -f -- "$txn/old-$label" "$target"; private_file "$target"; else fail 'Concurrent private model publication changed'; fi
  elif [ "$current_hash" = "$expected" ]; then rm -f -- "$target"; fi
}
rollback() {
  if [ -d "$txn" ] && [ ! -L "$txn" ]; then
    private_dir "$txn"
    if [ -f "$txn/publishing" ] && [ ! -L "$txn/publishing" ]; then
      restore_file "$models" models "$models_hash"
      restore_file "$metadata" metadata "$metadata_hash"
    fi
    rm -rf -- "$txn"
  fi
}`
  const command = `${prefix}
[ "$(cd -- ${q(options.projectRoot)} && pwd -P)" = ${q(options.projectRoot)} ] || fail 'Model project root is not canonical'
[ ! -e "$txn" ] && [ ! -L "$txn" ] || fail 'Private model transaction already exists'
private_dir "$txn"
${rollback}
success=0
trap 'if [ "$success" != 1 ]; then rollback; fi' EXIT
trap 'rollback; exit 1' HUP INT TERM
for target in "$models" "$metadata"; do if [ -e "$target" ] || [ -L "$target" ]; then private_file "$target"; fi; done
(set -C; : > "$txn/new-models"; : > "$txn/new-metadata") || fail 'Private model temporary files already exist'
private_file "$txn/new-models"; private_file "$txn/new-metadata"
awk -v models_file="$txn/new-models" -v metadata_file="$txn/new-metadata" 'NR==1 { print >models_file; next } NR==2 { print >metadata_file; next } { bad=1 } END { if (NR!=2 || bad) exit 1 }'
[ "$(hash_file "$txn/new-models")" = "$models_hash" ] && [ "$(hash_file "$txn/new-metadata")" = "$metadata_hash" ] || fail 'Private model configuration input was incomplete'
backup() {
  target=$1; label=$2
  if [ -e "$target" ] || [ -L "$target" ]; then
    private_file "$target"; old_hash=$(hash_file "$target")
    cp "$target" "$txn/old-$label"; private_file "$txn/old-$label"
    [ "$(hash_file "$txn/old-$label")" = "$old_hash" ] || fail 'Cannot verify private model backup'
    printf '%s' "$old_hash" > "$txn/old-$label.sha"
  fi
}
backup "$models" models; backup "$metadata" metadata
: > "$txn/publishing"
mv -f -- "$txn/new-models" "$models"
mv -f -- "$txn/new-metadata" "$metadata"
private_file "$models"; private_file "$metadata"
[ "$(hash_file "$models")" = "$models_hash" ] && [ "$(hash_file "$metadata")" = "$metadata_hash" ] || fail 'Private model publication was not confirmed'
success=1
printf 'PHI_MODEL_PROXY_READY\\n'`
  try {
    const result = await session.execWithInput(command, `${modelsContent}${metadataContent}`, {
      signal,
      timeoutMs: 10_000,
      maxOutputBytes: 4096
    })
    signal?.throwIfAborted()
    if (result.code !== 0 || result.signal || result.stdout !== 'PHI_MODEL_PROXY_READY\n')
      throw new Error('Private model publication was not confirmed')
    const cleaned = await session.execBounded(
      `${prefix}\nif [ -d "$txn" ] && [ ! -L "$txn" ]; then private_dir "$txn"; rm -rf -- "$txn"; fi`,
      { timeoutMs: 2000, maxOutputBytes: 4096, signal }
    )
    if (cleaned.code !== 0 || cleaned.signal || cleaned.stdoutTruncated || cleaned.stderrTruncated)
      throw new Error('Private model publication cleanup was not confirmed')
    signal?.throwIfAborted()
    return Object.freeze({
      nonce,
      sessionId: metadata.sessionId,
      projectRoot: metadata.projectRoot,
      gatewayGeneration: metadata.gatewayGeneration
    })
  } catch {
    await session
      .execBounded(`${prefix}\n${rollback}\nrollback`, { timeoutMs: 2000, maxOutputBytes: 4096 })
      .catch(() => undefined)
    signal?.throwIfAborted()
    throw new Error('Private model proxy configuration write failed')
  }
}
