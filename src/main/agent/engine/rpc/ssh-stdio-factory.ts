import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { RPC_BOOTSTRAP_OMP_VERSION, type RpcBootstrapConfig } from '../phi-extension/lib/rpc-config'
import {
  shellQuote as q,
  type RemoteSshSession,
  type RemoteStdioProcess
} from '../../wrappers/remote-ssh-session'
import { attestBootstrap } from './bootstrap-attestation'
import {
  ensurePhiExtensionDeployment,
  type ExtensionDeploymentOptions,
  type PhiExtensionBundle
} from './extension-deployment'
import { assertRemoteRoot, privateRemotePrefix } from './extension-deployment/remote-commands'
import { ensureRemoteOmpDeployment, type RemoteOmpDeploymentOptions } from './runtime-deployment'
import type { RpcSessionCreateParams, RpcSessionInitializationContext } from './rpc-session-backend'
import {
  acquirePersistentLaunchStorage,
  type PreparePersistentLaunchStorage
} from './persistent-launch-storage'
import { storagePrefix } from './session-storage/remote-preflight'
import type { RemoteSessionStoragePreparation } from './session-storage/types'

export interface SshRpcSessionTransportOptions {
  /** The selected, already connected session: the factory never owns its SSH master. */
  session: Pick<RemoteSshSession, 'openStdio'>
  runtime: Omit<RemoteOmpDeploymentOptions, 'signal'>
  bundle: PhiExtensionBundle
  projectId: string
  onExtensionProgress?: ExtensionDeploymentOptions['onProgress']
  /** Factory owns the returned writer lease until this generation closes, including failed/late opens. */
  preparePersistentStorage?: PreparePersistentLaunchStorage
  /** R3 may write proxy model configuration here. Desktop credentials are never copied. */
  prepareSession?: (context: {
    readonly params: Readonly<RpcSessionCreateParams>
    readonly homePath: string
    readonly agentDir: string
    readonly signal: AbortSignal
  }) => Promise<void>
  /** Composes capabilities after model publication; the factory retains launch/storage ownership. */
  prepareRuntime?: (
    context: RpcRuntimePreparationContext
  ) => Promise<void | RpcRuntimePreparationResult>
}

export interface RpcRuntimePreparationResult {
  readonly nativeTools: readonly (
    'read' | 'write' | 'edit' | 'bash' | 'powershell' | 'glob' | 'grep' | 'task'
  )[]
  readonly childRuntimeRequired?: boolean
  /** Exact compiler-issued foreground names; no remote Markdown discovery grants this policy. */
  readonly foregroundChildNativeNames?: readonly string[]
}

function snapshotRuntimePreparation(value: unknown): Readonly<RpcRuntimePreparationResult> {
  const refused = (): never => {
    throw new Error('Invalid composed native tool roster')
  }
  const fields = ['nativeTools', 'childRuntimeRequired', 'foregroundChildNativeNames']
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !fields.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !('value' in descriptor)
    )
  )
    return refused()
  const raw = value as Record<string, unknown>
  const nativeTools = Array.isArray(raw.nativeTools) ? [...raw.nativeTools] : undefined
  const nativeTool = (name: unknown): name is RpcRuntimePreparationResult['nativeTools'][number] =>
    typeof name === 'string' &&
    ['read', 'write', 'edit', 'bash', 'powershell', 'glob', 'grep', 'task'].includes(name)
  if (
    !Array.isArray(nativeTools) ||
    !nativeTools.every(nativeTool) ||
    new Set(nativeTools).size !== nativeTools.length ||
    (raw.childRuntimeRequired !== undefined && typeof raw.childRuntimeRequired !== 'boolean') ||
    nativeTools.includes('task') !== (raw.childRuntimeRequired === true)
  )
    return refused()
  const names = Array.isArray(raw.foregroundChildNativeNames)
    ? [...raw.foregroundChildNativeNames]
    : raw.foregroundChildNativeNames
  const foregroundName = (name: unknown): name is string =>
    typeof name === 'string' && name.length <= 128 && /^phi_[a-f0-9]{24}_[0-9]+_fg$/u.test(name)
  if (
    names !== undefined &&
    (!Array.isArray(names) ||
      !names.every(foregroundName) ||
      names.length > 32 ||
      new Set(names).size !== names.length)
  )
    return refused()
  if (
    raw.childRuntimeRequired === true
      ? !Array.isArray(names) || names.length < 1
      : Array.isArray(names) && names.length > 0
  )
    return refused()
  return Object.freeze({
    nativeTools: Object.freeze([...nativeTools]),
    ...(raw.childRuntimeRequired === undefined
      ? {}
      : { childRuntimeRequired: raw.childRuntimeRequired }),
    ...(Array.isArray(names) ? { foregroundChildNativeNames: Object.freeze([...names]) } : {})
  })
}

export interface RpcRuntimePreparationContext {
  readonly params: Readonly<RpcSessionCreateParams>
  readonly bootstrap: Readonly<RpcBootstrapConfig>
  readonly generation: number
  readonly generationDirectory: string
  readonly homePath: string
  readonly agentDir: string
  readonly storage: RemoteSessionStoragePreparation | undefined
  readonly signal: AbortSignal
}

export interface SshRpcSessionTransport {
  readonly open: (
    params: RpcSessionCreateParams,
    signal: AbortSignal,
    generation?: number
  ) => Promise<RemoteStdioProcess>
  readonly initialize: (context: RpcSessionInitializationContext) => Promise<void>
}

function identity(value: string, label: string): void {
  if (
    !value ||
    value.length > 256 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f
    )
  )
    throw new Error(`Invalid RPC ${label}`)
}

async function cancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Each open owns only its channel and generation-specific private configuration. */
export async function prepareSshRpcSessionTransport(
  options: SshRpcSessionTransportOptions,
  preparationSignal?: AbortSignal
): Promise<SshRpcSessionTransport> {
  identity(options.projectId, 'project identity')
  assertRemoteRoot(options.runtime.runtimeRoot)
  if (options.runtime.desktopVersion !== RPC_BOOTSTRAP_OMP_VERSION)
    throw new Error('Unsupported Phi RPC bootstrap runtime version')
  if (!options.session.openStdio)
    throw new Error('Connected SSH session has no persistent stdio capability')
  // Download/upload preparation has its own caller-owned cancellation and transfer
  // budget. RpcConnection.start's deadline begins only after this factory returns.
  preparationSignal?.throwIfAborted()
  const runtime = await ensureRemoteOmpDeployment({ ...options.runtime, signal: preparationSignal })
  const extension = await ensurePhiExtensionDeployment({
    runtimeHost: options.runtime.runtimeHost,
    runtimeRoot: options.runtime.runtimeRoot,
    cacheDir: options.runtime.cacheDir,
    openLockStdio: (command) => options.session.openStdio!(command),
    bundle: options.bundle,
    uploadOptions: options.runtime.uploadOptions,
    onProgress: options.onExtensionProgress,
    signal: preparationSignal
  })
  preparationSignal?.throwIfAborted()
  const prepared = new WeakMap<Readonly<RpcSessionCreateParams>, RpcBootstrapConfig>()
  const preparedGenerations = new WeakMap<Readonly<RpcSessionCreateParams>, number>()
  return {
    async open(params, callerSignal, generation = 1) {
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error('Invalid RPC channel generation')
      const controller = new AbortController()
      const signal = controller.signal
      const cancel = (): void => controller.abort(callerSignal.reason)
      identity(params.sessionId, 'session identity')
      assertRemoteRoot(params.cwd)
      callerSignal.throwIfAborted()
      const { runtimeHost: host, runtimeRoot: root } = options.runtime
      if (!host.transfer) throw new Error('Runtime host has no streaming file transfer transport')
      const nonce = randomUUID()
      const sessionBase = posix.join(root, 'rpc-sessions')
      const sessionDirectory = posix.join(sessionBase, nonce)
      const homePath = posix.join(sessionDirectory, 'home')
      const agentDir = posix.join(
        homePath,
        options.preparePersistentStorage ? '.omp/agent' : 'agent'
      )
      const statePath = posix.join(sessionDirectory, 'state')
      const cachePath = posix.join(sessionDirectory, 'cache')
      const tempPath = posix.join(sessionDirectory, 'tmp')
      const configPath = posix.join(sessionDirectory, 'config.json')
      const startupPolicyPath = posix.join(sessionDirectory, 'startup-policy.json')
      const prefix = privateRemotePrefix(root)
      let local: string | undefined
      let channel: RemoteStdioProcess | undefined
      let storage: RemoteSessionStoragePreparation | undefined
      const loseLease = (): void => controller.abort(storage?.lease.signal.reason)
      let cleanupPromise: Promise<void> | undefined
      const run = async (command: string, operationSignal?: AbortSignal): Promise<void> => {
        operationSignal?.throwIfAborted()
        const result = await host.exec.run(['sh', '-c', `${prefix}\n${command}`], {
          cwd: root,
          signal: operationSignal,
          timeoutMs: 30_000,
          maxOutputBytes: 16 * 1024
        })
        operationSignal?.throwIfAborted()
        if (result.code !== 0 || result.truncated || result.terminationReason)
          throw new Error(
            `Cannot prepare private Phi RPC session: ${result.stderr.trim() || result.terminationReason || result.code}`
          )
      }
      const cleanup = (): Promise<void> => {
        if (!cleanupPromise)
          cleanupPromise = (async () => {
            signal.removeEventListener('abort', abort)
            callerSignal.removeEventListener('abort', cancel)
            storage?.lease.signal.removeEventListener('abort', loseLease)
            prepared.delete(params)
            preparedGenerations.delete(params)
            await run(
              `if [ -e ${q(sessionDirectory)} ] && [ ! -L ${q(sessionDirectory)} ]; then owned ${q(sessionBase)}; owned ${q(sessionDirectory)}; rm -rf -- ${q(sessionDirectory)}; fi`
            ).catch(() => undefined)
            await storage?.lease.release().catch(() => undefined)
          })()
        return cleanupPromise
      }
      const abort = (): void => {
        void channel?.close().catch(() => undefined)
      }
      callerSignal.addEventListener('abort', cancel, { once: true })
      if (callerSignal.aborted) cancel()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (options.preparePersistentStorage) {
          storage = await acquirePersistentLaunchStorage(
            options.preparePersistentStorage,
            { params, signal },
            {
              host,
              projectId: options.projectId,
              runtimeRoot: root
            }
          )
          storage.lease.signal.addEventListener('abort', loseLease, { once: true })
          if (storage.lease.signal.aborted) loseLease()
          storage.lease.assertActive()
          await run(storagePrefix(storage.scope, storage.paths), signal)
        }
        await run(
          `[ "$(cd -- ${q(params.cwd)} && pwd -P)" = ${q(params.cwd)} ] || fail 'Project root must be a canonical existing directory'
private_dir ${q(sessionBase)}
[ ! -e ${q(sessionDirectory)} ] && [ ! -L ${q(sessionDirectory)} ] || fail 'Session generation already exists'
private_dir ${q(sessionDirectory)}
private_dir ${q(homePath)}
${storage ? `private_dir ${q(posix.join(homePath, '.omp'))}\nprivate_dir ${q(statePath)}\nprivate_dir ${q(posix.join(statePath, 'omp'))}\nprivate_dir ${q(cachePath)}\nprivate_dir ${q(posix.join(cachePath, 'omp'))}\nprivate_dir ${q(tempPath)}` : ''}
private_dir ${q(agentDir)}`,
          signal
        )
        const config: RpcBootstrapConfig = {
          schema: 1,
          nonce,
          sessionId: params.sessionId,
          projectId: options.projectId,
          projectRoot: params.cwd,
          ompVersion: RPC_BOOTSTRAP_OMP_VERSION,
          contentHash: extension.contentHash
        }
        const bytes = Buffer.from(JSON.stringify(config))
        local = await mkdtemp(join(tmpdir(), 'phi-rpc-config-'))
        const source = join(local, 'config.json')
        await writeFile(source, bytes, { mode: 0o600, flag: 'wx' })
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        await host.transfer.uploadFile(source, configPath, {
          ...options.runtime.uploadOptions,
          signal,
          expectedSha256: sha256
        })
        await run(
          `private_file ${q(configPath)}\n[ "$(hash_file ${q(configPath)})" = ${q(sha256)} ] || fail 'Private RPC configuration was corrupted'`,
          signal
        )
        if (options.prepareSession)
          await cancelled(options.prepareSession({ params, homePath, agentDir, signal }), signal)
        const preparedRuntime = options.prepareRuntime
          ? await cancelled(
              options.prepareRuntime(
                Object.freeze({
                  params,
                  bootstrap: Object.freeze({ ...config }),
                  generation,
                  generationDirectory: sessionDirectory,
                  homePath,
                  agentDir,
                  storage,
                  signal
                })
              ),
              signal
            )
          : undefined
        const runtimePreparation =
          preparedRuntime === undefined ? undefined : snapshotRuntimePreparation(preparedRuntime)
        signal.throwIfAborted()
        // Explicit CLI overlays outrank global/project settings in 18.10.3.
        // Write this after the model-only preparation hook; startup MCP spawning
        // precedes tool_call guards and must never inherit repository commands.
        const policyBytes = Buffer.from(
          JSON.stringify({
            mcp: { enableProjectConfig: false },
            extensions: [],
            skills: [],
            lsp: { enabled: false },
            memory:
              runtimePreparation?.childRuntimeRequired === true
                ? { backend: 'off' }
                : { enabled: false },
            ...(options.prepareRuntime ? { tools: { xdev: false } } : {}),
            ...(runtimePreparation?.childRuntimeRequired === true
              ? {
                  async: { enabled: false },
                  task: {
                    batch: false,
                    structured: false,
                    speculativeLaunch: false,
                    enableEffort: false,
                    isolation: { enabled: false },
                    agentAdvisor: Object.fromEntries(
                      (runtimePreparation.foregroundChildNativeNames ?? []).map((name) => [
                        name,
                        'off'
                      ])
                    ),
                    agentPrewalk: Object.fromEntries(
                      (runtimePreparation.foregroundChildNativeNames ?? []).map((name) => [
                        name,
                        'off'
                      ])
                    )
                  },
                  eval: { py: false, js: false, autoProvision: false, tools: { enabled: false } }
                }
              : {}),
            ...(storage ? { goal: { continuationModes: [] } } : {})
          })
        )
        const policySource = join(local, 'startup-policy.json')
        await writeFile(policySource, policyBytes, { mode: 0o600, flag: 'wx' })
        const policyHash = createHash('sha256').update(policyBytes).digest('hex')
        await host.transfer.uploadFile(policySource, startupPolicyPath, {
          ...options.runtime.uploadOptions,
          signal,
          expectedSha256: policyHash
        })
        await run(
          `private_file ${q(startupPolicyPath)}\n[ "$(hash_file ${q(startupPolicyPath)})" = ${q(policyHash)} ] || fail 'Private RPC startup policy was corrupted'`,
          signal
        )
        const args = [
          '--cwd',
          params.cwd,
          '--mode',
          'rpc',
          '--no-extensions',
          '--trusted-extension',
          extension.entryPath,
          '--config',
          startupPolicyPath,
          '--no-skills',
          '--no-rules',
          '--no-lsp',
          '--no-title',
          '--no-prewalk',
          '--no-pty',
          ...(runtimePreparation
            ? runtimePreparation.nativeTools.length
              ? ['--tools', runtimePreparation.nativeTools.join(',')]
              : ['--no-tools']
            : []),
          ...(storage ? ['--session-dir', storage.paths.journals] : ['--no-session'])
        ]
        // pi-utils eagerly loads cwd/.env during module import, before OMP
        // applies --cwd. Start in the owned HOME, then let the official CLI
        // switch the real process and session cwd after that startup phase.
        storage?.lease.assertActive()
        const persistentEnv = storage
          ? ` XDG_DATA_HOME=${q(storage.paths.data)} XDG_STATE_HOME=${q(statePath)} XDG_CACHE_HOME=${q(cachePath)} TMPDIR=${q(tempPath)} TEMP=${q(tempPath)} TMP=${q(tempPath)}`
          : ''
        const command = `umask 077 && cd -- ${q(homePath)} && exec env -i PATH=/usr/local/bin:/usr/bin:/bin PI_REQ_DEBUG=0 HOME=${q(homePath)} PI_CODING_AGENT_DIR=${q(agentDir)} PHI_RPC_CONFIG=${q(configPath)}${options.prepareRuntime ? ' PHI_RPC_RUNTIME=1' : ''}${persistentEnv} ${q(runtime.executablePath)} ${args.map(q).join(' ')}`
        const opening = options.session.openStdio!(command)
        // An acquisition API cannot be force-cancelled. Settle now and separately
        // close a channel that arrives after its generation has already been disposed.
        void opening.then(
          (late) => {
            if (signal.aborted) void late.close().catch(() => undefined)
          },
          () => undefined
        )
        channel = await cancelled(opening, signal)
        signal.throwIfAborted()
        prepared.set(params, Object.freeze(config))
        preparedGenerations.set(params, generation)
        const owned = channel
        void owned.closed.then(cleanup, cleanup)
        return {
          stdin: owned.stdin,
          stdout: owned.stdout,
          stderr: owned.stderr,
          closed: owned.closed,
          async close() {
            try {
              await owned.close()
            } finally {
              await cleanup()
            }
          }
        }
      } catch (error) {
        await channel?.close().catch(() => undefined)
        await cleanup()
        signal.throwIfAborted()
        throw error
      } finally {
        if (local) await rm(local, { recursive: true, force: true })
      }
    },
    async initialize({ connection, params, signal }) {
      const config = prepared.get(params)
      if (!config) throw new Error('Missing prepared Phi RPC bootstrap generation')
      if (preparedGenerations.get(params) !== connection.bindControl().generation)
        throw new Error('Prepared RPC channel generation does not match')
      await attestBootstrap(connection, config, signal)
    }
  }
}
