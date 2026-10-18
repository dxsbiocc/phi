import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  compactionPolicy,
  type RpcCompactionPolicy
} from '../phi-extension/lib/rpc-compaction-control'
import { posix } from 'node:path'
import { RPC_BOOTSTRAP_OMP_VERSION, type RpcBootstrapConfig } from '../phi-extension/lib/rpc-config'
import {
  shellQuote as q,
  type RemoteSshSession,
  type RemoteStdioProcess
} from '../../wrappers/remote-ssh-session'
import { attestBootstrap } from './bootstrap-attestation'
import { RUN_NONCE_ENV, RUN_STOPPED_NOTICE, buildRunGuardWrapper } from './run-guard'
import {
  deploymentReadyMarkerPath,
  ensurePhiExtensionDeployment,
  phiExtensionReadyMarkerIdentity,
  serializeDeploymentReadyMarker,
  type ExtensionDeploymentOptions,
  type PhiExtensionBundle,
  type PhiExtensionDeployment
} from './extension-deployment'
import { assertRemoteRoot, privateRemotePrefix } from './extension-deployment/remote-commands'
import {
  ensureRemoteOmpDeployment,
  REMOTE_OMP_MANIFEST,
  remoteOmpReadyMarkerIdentity,
  selectRemoteOmpAsset,
  type RemoteOmpDeployment,
  type RemoteOmpDeploymentOptions
} from './runtime-deployment'
import { deploymentPaths, deploymentResult } from './runtime-deployment/remote-commands'
import type { RpcSessionCreateParams, RpcSessionInitializationContext } from './rpc-session-backend'
import {
  acquirePersistentLaunchStorage,
  type PreparePersistentLaunchStorage
} from './persistent-launch-storage'
import { activateRemoteSessionStorageLease } from './session-storage/writer-lease'
import { storageDirectories } from './session-storage/remote-preflight'
import { remoteJournalPath } from './session-storage/paths'
import { serializeRemoteSessionManifest } from './session-storage/remote-manifest'
import type {
  RemoteSessionReference,
  RemoteSessionStoragePreparation
} from './session-storage/types'
import {
  assertPhiModelProviderCompatible,
  PHI_DISABLED_CAPABILITY_PROVIDERS
} from './rpc-startup-policy'
import type { RemoteStartupDiagnostics } from './remote-startup-diagnostics'
import {
  RpcStartupTransactionBuilder,
  runRpcStartupTransaction,
  type RpcStartupMarkerCheck,
  type RpcStartupTransactionWriter
} from './startup-transaction'
import { serializeRemoteHelperReadyMarker } from '../../remote-helper-marker'

export interface SshRpcSessionTransportOptions {
  /** Main-only last dispatch fence; never serialized into CLI or SSH protocol options. */
  beforeLaunch?: () => void
  /** The selected, already connected session: the factory never owns its SSH master. */
  session: Pick<RemoteSshSession, 'openStdio' | 'execWithInput' | 'remoteHelper'>
  runtime: Omit<RemoteOmpDeploymentOptions, 'signal'>
  bundle: PhiExtensionBundle
  projectId: string
  onExtensionProgress?: ExtensionDeploymentOptions['onProgress']
  /** A previous run that outlived its SSH connection was stopped before this launch. */
  onRunTakeover?: (event: { readonly stoppedPid: number; readonly message: string }) => void
  readonly startupDiagnostics?: RemoteStartupDiagnostics
  /** Existing durable reference proved by the startup transaction before OMP launches. */
  readonly resumeReference?: RemoteSessionReference
  /** Factory owns the returned writer lease until this generation closes, including failed/late opens. */
  preparePersistentStorage?: PreparePersistentLaunchStorage
  /** R3 may write proxy model configuration here. Desktop credentials are never copied. */
  prepareSession?: (context: {
    readonly params: Readonly<RpcSessionCreateParams>
    readonly homePath: string
    readonly agentDir: string
    readonly startup: RpcStartupTransactionWriter
    readonly signal: AbortSignal
  }) => Promise<void>
  /** Composes capabilities after model publication; the factory retains launch/storage ownership. */
  prepareRuntime?: (
    context: RpcRuntimePreparationContext
  ) => Promise<void | RpcRuntimePreparationResult>
}

export interface RpcRuntimePreparationResult {
  readonly compaction?: RpcCompactionPolicy
  readonly nativeTools: readonly (
    'read' | 'write' | 'edit' | 'bash' | 'powershell' | 'glob' | 'grep' | 'task'
  )[]
  readonly childRuntimeRequired?: boolean
  readonly childBackgroundEnabled?: boolean
  readonly childParallelEnabled?: boolean
  /** Exact compiler-issued foreground names; no remote Markdown discovery grants this policy. */
  readonly foregroundChildNativeNames?: readonly string[]
}

function snapshotRuntimePreparation(value: unknown): Readonly<RpcRuntimePreparationResult> {
  const refused = (): never => {
    throw new Error('Invalid composed native tool roster')
  }
  const fields = [
    'nativeTools',
    'childRuntimeRequired',
    'foregroundChildNativeNames',
    'compaction',
    'childBackgroundEnabled',
    'childParallelEnabled'
  ]
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
  for (const field of ['childBackgroundEnabled', 'childParallelEnabled'] as const)
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== 'boolean' || raw.childRuntimeRequired !== true)
    )
      return refused()
  const names = Array.isArray(raw.foregroundChildNativeNames)
    ? [...raw.foregroundChildNativeNames]
    : raw.foregroundChildNativeNames
  const foregroundName = (name: unknown): name is string =>
    typeof name === 'string' &&
    name.length <= 128 &&
    /^phi_[a-f0-9]{24}_[0-9]+_(?:fg|bg)$/u.test(name)
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
    ...(raw.compaction === undefined ? {} : { compaction: compactionPolicy(raw.compaction) }),
    nativeTools: Object.freeze([...nativeTools]),
    ...(raw.childRuntimeRequired === undefined
      ? {}
      : { childRuntimeRequired: raw.childRuntimeRequired }),
    ...(raw.childBackgroundEnabled === undefined
      ? {}
      : { childBackgroundEnabled: raw.childBackgroundEnabled as boolean }),
    ...(raw.childParallelEnabled === undefined
      ? {}
      : { childParallelEnabled: raw.childParallelEnabled as boolean }),
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
  readonly startup: RpcStartupTransactionWriter
  readonly signal: AbortSignal
}

export interface SshRpcSessionTransport {
  readonly open: (
    params: RpcSessionCreateParams,
    signal: AbortSignal,
    generation?: number
  ) => Promise<RemoteStdioProcess>
  readonly initialize: (context: RpcSessionInitializationContext) => Promise<void>
  readonly startupPreflight: (
    params: Readonly<RpcSessionCreateParams>
  ) => import('./session-storage/types').RemoteJournalPreflight | undefined
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

function expectedRemoteOmpDeployment(options: SshRpcSessionTransportOptions['runtime']): {
  deployment: RemoteOmpDeployment
  marker: RpcStartupMarkerCheck
} {
  const manifest = options.manifest ?? REMOTE_OMP_MANIFEST
  const { asset } = selectRemoteOmpAsset(
    manifest,
    options.desktopVersion,
    options.runtimeHost.capabilities().platform
  )
  const paths = deploymentPaths(options.runtimeRoot, manifest.version, asset.sha256)
  return {
    deployment: deploymentResult(paths, manifest.version, true),
    marker: {
      item: 'omp',
      managedRoot: options.runtimeRoot,
      directory: paths.directory,
      path: paths.readyMarker,
      bytes: Buffer.from(
        serializeDeploymentReadyMarker(remoteOmpReadyMarkerIdentity(manifest.version, asset.sha256))
      )
    }
  }
}

function expectedPhiExtensionDeployment(
  runtimeRoot: string,
  bundle: PhiExtensionBundle
): { deployment: PhiExtensionDeployment; marker: RpcStartupMarkerCheck } {
  const directory = posix.join(runtimeRoot, 'extensions', bundle.contentHash)
  return {
    deployment: {
      contentHash: bundle.contentHash,
      directory,
      entryPath: posix.join(directory, bundle.entryPoint),
      reused: true
    },
    marker: {
      item: 'extension',
      managedRoot: runtimeRoot,
      directory,
      path: deploymentReadyMarkerPath(directory),
      bytes: Buffer.from(
        serializeDeploymentReadyMarker(phiExtensionReadyMarkerIdentity(bundle.contentHash))
      )
    }
  }
}

function startupMarkers(options: SshRpcSessionTransportOptions): RpcStartupMarkerCheck[] {
  const markers = [
    expectedRemoteOmpDeployment(options.runtime).marker,
    expectedPhiExtensionDeployment(options.runtime.runtimeRoot, options.bundle).marker
  ]
  const helper = options.runtime.runtimeHost.managedRemoteHelper?.()
  if (helper) {
    markers.push({
      item: 'helper',
      managedRoot: helper.managedRoot,
      directory: helper.remoteDirectory,
      path: helper.readyMarkerPath,
      bytes: Buffer.from(serializeRemoteHelperReadyMarker(helper.markerIdentity))
    })
  }
  return markers
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
  const step = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
    options.startupDiagnostics?.step(name, operation) ?? operation()
  // Paths and marker identities are content-addressed and can be derived locally.
  // Deployment work is deferred until the consolidated transaction reports the
  // specific item that needs repair.
  const runtime = expectedRemoteOmpDeployment(options.runtime).deployment
  const extension = expectedPhiExtensionDeployment(
    options.runtime.runtimeRoot,
    options.bundle
  ).deployment
  preparationSignal?.throwIfAborted()
  const prepared = new WeakMap<Readonly<RpcSessionCreateParams>, RpcBootstrapConfig>()
  const preparedGenerations = new WeakMap<Readonly<RpcSessionCreateParams>, number>()
  const preparedPreflights = new WeakMap<
    Readonly<RpcSessionCreateParams>,
    import('./session-storage/types').RemoteJournalPreflight
  >()
  return {
    async open(params, callerSignal, generation = 1) {
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error('Invalid RPC channel generation')
      const controller = new AbortController()
      const signal = controller.signal
      const cancel = (): void => controller.abort(callerSignal.reason)
      identity(params.sessionId, 'session identity')
      assertRemoteRoot(params.cwd)
      if (params.model) assertPhiModelProviderCompatible(params.model.provider)
      callerSignal.throwIfAborted()
      const { runtimeHost: host, runtimeRoot: root } = options.runtime
      let startupHelper = host.managedRemoteHelper?.()
      if (host.ensureManagedRemoteHelper) {
        startupHelper = await step('remote_helper', () => host.ensureManagedRemoteHelper!())
        if (!startupHelper) {
          const reason = host.managedRemoteHelperFailure?.()
          throw new Error(
            `Remote RPC startup requires the managed helper guard${reason ? `: ${reason}` : ''}`
          )
        }
      }
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
      let startup: RpcStartupTransactionBuilder
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
            preparedPreflights.delete(params)
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
          storage = await step('persistent_storage', () =>
            acquirePersistentLaunchStorage(
              options.preparePersistentStorage!,
              { params, signal },
              {
                host,
                projectId: options.projectId,
                runtimeRoot: root
              }
            )
          )
          storage.lease.signal.addEventListener('abort', loseLease, { once: true })
          if (storage.lease.signal.aborted) loseLease()
          storage.lease.assertActive()
        }
        const resume =
          options.resumeReference && storage
            ? (() => {
                const supplied = options.resumeReference!
                const journalPath = remoteJournalPath(storage!.scope, supplied)
                const reference: RemoteSessionReference = {
                  ...storage!.scope,
                  kind: 'remote-omp',
                  version: 1,
                  durableSessionKey: supplied.durableSessionKey,
                  ompVersion: supplied.ompVersion,
                  ompSessionId: supplied.ompSessionId,
                  journalBasename: supplied.journalBasename
                }
                const manifest = serializeRemoteSessionManifest(storage!, reference)
                return {
                  manifestPath: storage!.paths.manifest,
                  manifestSha256: createHash('sha256').update(manifest).digest('hex'),
                  manifestBytes: manifest.length,
                  journalPath,
                  ompSessionId: reference.ompSessionId
                }
              })()
            : undefined
        if (options.resumeReference && !resume)
          throw new Error('Remote resume requires persistent startup storage')
        startup = new RpcStartupTransactionBuilder({
          runtimeRoot: root,
          projectRoot: params.cwd,
          ...(startupHelper ? { projectPluginGuardHelper: startupHelper.remotePath } : {}),
          ...(storage
            ? { lock: { path: storage.paths.lock, runExecutable: runtime.executablePath } }
            : {}),
          ...(resume ? { resume } : {}),
          markers: startupMarkers(options)
        })
        if (storage)
          for (const path of storageDirectories(storage.scope, storage.paths))
            startup.addDirectory({ path })
        startup.addDirectory({ path: sessionBase })
        startup.addDirectory({ path: sessionDirectory, ifAbsent: true })
        startup.addDirectory({ path: homePath })
        if (storage) {
          startup.addDirectory({ path: posix.join(homePath, '.omp') })
          startup.addDirectory({ path: statePath })
          startup.addDirectory({ path: posix.join(statePath, 'omp') })
          startup.addDirectory({ path: cachePath })
          startup.addDirectory({ path: posix.join(cachePath, 'omp') })
          startup.addDirectory({ path: tempPath })
        }
        startup.addDirectory({ path: agentDir })
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
        startup.addFile({
          item: 'bootstrap-config',
          path: configPath,
          bytes,
          mode: 0o600,
          ifAbsent: true
        })
        if (options.prepareSession)
          await step('model_proxy_publication', () =>
            cancelled(
              options.prepareSession!({ params, homePath, agentDir, startup, signal }),
              signal
            )
          )
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
                  startup,
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
            ...(runtimePreparation?.compaction
              ? { compaction: { ...runtimePreparation.compaction, modelThresholdsEnabled: false } }
              : {}),
            disabledProviders: PHI_DISABLED_CAPABILITY_PROVIDERS,
            mcp: { enableProjectConfig: false },
            extensions: [],
            skills: [],
            lsp: { enabled: false },
            memory:
              runtimePreparation?.childRuntimeRequired === true
                ? { backend: 'off' }
                : { enabled: false },
            // A backgrounded bash call outlives its run: its output would arrive as an unsolicited
            // follow-up after the Phi generation ended, and a model-chosen `timeout: 1` becomes a 1 s kill.
            // Keep every command in the foreground, as the remote bash description promises.
            bash: { autoBackground: { enabled: false } },
            // Plain old/new string replacement matches Phi's legacy edit tool; the default hashline
            // mode needs anchored [PATH#HASH] input that models do not produce reliably.
            ...(options.prepareRuntime
              ? // Discoverable host tools mount under xd:// (OMP default). Automated QA would advertise
                // `write xd://report_issue`, a device the Phi authority refuses on the remote host.
                { edit: { mode: 'replace' }, dev: { autoqa: false } }
              : {}),
            ...(runtimePreparation?.childRuntimeRequired === true
              ? {
                  edit: { mode: 'replace' },
                  async: { enabled: runtimePreparation.childBackgroundEnabled === true },
                  task: {
                    maxConcurrency: 4,
                    batch: runtimePreparation.childParallelEnabled === true,
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
        startup.addFile({
          item: 'startup-policy',
          path: startupPolicyPath,
          bytes: policyBytes,
          mode: 0o600,
          ifAbsent: true
        })

        const reportTakeover = (takeover: { readonly stoppedPid: number } | undefined): void => {
          if (!takeover) return
          try {
            options.onRunTakeover?.({
              stoppedPid: takeover.stoppedPid,
              message: RUN_STOPPED_NOTICE
            })
          } catch {
            // A failed notice must never abort the launch that already took over.
          }
        }
        const launch = async (): Promise<void> => {
          const first = await step('rpc_startup_transaction', () =>
            runRpcStartupTransaction(options.session, startup.build(), signal)
          )
          if (first.result.status === 'ready') {
            reportTakeover(first.result.takeover)
            if (first.result.resume) preparedPreflights.set(params, first.result.resume.journal)
            if (storage) {
              if (!first.lock) throw new Error('Remote RPC startup did not retain its writer lock')
              await activateRemoteSessionStorageLease(storage, first.lock)
            }
            return
          }
          for (const item of first.result.markers.filter((marker) => marker.status === 'repair')) {
            if (item.item === 'omp') {
              await step('runtime_binary', () =>
                ensureRemoteOmpDeployment({ ...options.runtime, signal })
              )
            } else if (item.item === 'extension') {
              await step('extension_deployment', () =>
                ensurePhiExtensionDeployment({
                  runtimeHost: host,
                  runtimeRoot: root,
                  cacheDir: options.runtime.cacheDir,
                  openLockStdio: (command) => options.session.openStdio!(command),
                  bundle: options.bundle,
                  uploadOptions: options.runtime.uploadOptions,
                  onProgress: options.onExtensionProgress,
                  signal
                })
              )
            } else if (item.item === 'helper') {
              const repaired = await host.ensureManagedRemoteHelper?.({ force: true })
              if (!repaired) throw new Error('Remote helper marker repair failed')
            } else {
              throw new Error(`Unknown remote startup repair item: ${item.item}`)
            }
          }
          const repaired = await step('rpc_startup_transaction', () =>
            runRpcStartupTransaction(options.session, startup.build(), signal)
          )
          if (repaired.result.status !== 'ready') {
            const failures = repaired.result.markers
              .filter((item) => item.status === 'repair')
              .map((item) => `${item.item}:${item.reason ?? 'invalid'}`)
              .join(', ')
            throw new Error(`Remote RPC startup repair was not confirmed: ${failures}`)
          }
          reportTakeover(repaired.result.takeover)
          if (repaired.result.resume) preparedPreflights.set(params, repaired.result.resume.journal)
          if (storage) {
            if (!repaired.lock) throw new Error('Remote RPC startup did not retain its writer lock')
            await activateRemoteSessionStorageLease(storage, repaired.lock)
          }
        }
        await launch()
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
        options.beforeLaunch?.()
        const persistentEnv = storage
          ? ` XDG_DATA_HOME=${q(storage.paths.data)} XDG_STATE_HOME=${q(statePath)} XDG_CACHE_HOME=${q(cachePath)} TMPDIR=${q(tempPath)} TEMP=${q(tempPath)} TMP=${q(tempPath)}`
          : ''
        const runNonce = randomBytes(16).toString('hex')
        const runGuard = storage
          ? buildRunGuardWrapper({
              runLock: storage.paths.runLock,
              runRecord: storage.paths.runRecord,
              nonce: runNonce
            })
          : ''
        const runEnv = storage ? ` ${RUN_NONCE_ENV}=${runNonce}` : ''
        const command = `umask 077 && cd -- ${q(homePath)} && ${runGuard || 'exec '}env -i PATH=/usr/local/bin:/usr/bin:/bin PI_REQ_DEBUG=0${runEnv} HOME=${q(homePath)} PI_CODING_AGENT_DIR=${q(agentDir)} PHI_RPC_CONFIG=${q(configPath)}${options.prepareRuntime ? ' PHI_RPC_RUNTIME=1' : ''}${persistentEnv} ${q(runtime.executablePath)} ${args.map(q).join(' ')}`
        const opening = step('rpc_stdio_open', () => options.session.openStdio!(command))
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
      }
    },
    async initialize({ connection, params, signal }) {
      const config = prepared.get(params)
      if (!config) throw new Error('Missing prepared Phi RPC bootstrap generation')
      if (preparedGenerations.get(params) !== connection.bindControl().generation)
        throw new Error('Prepared RPC channel generation does not match')
      await step('bootstrap_attestation', () => attestBootstrap(connection, config, signal))
    },
    startupPreflight: (params) => preparedPreflights.get(params)
  }
}
