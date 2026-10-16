import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { PhiAgentDefinition, PhiAgentThinkingLevel } from '../../../agents/definition'
import { AGENT_REPORT_PROTOCOL } from '../../../agents/report'
import type { RemoteWorkspaceHostBinding } from '../../../remote-workspace-boundary'
import type { WorkspaceHost } from '../../../workspace-host/types'
import type { RemoteUploadFileOptions } from '../../../transfer/remote-upload-types'
import { shellQuote as q } from '../../../wrappers/remote-ssh-session'
import type { ModelGatewayModelRef, SafeModelDescriptor } from '../../model-gateway-types'
import {
  MAX_RPC_CHILD_CONFIG_BYTES,
  RPC_CHILD_RUNTIME_FILE,
  validateRpcChildRuntimeConfig,
  type RpcChildConfigIdentity,
  type RpcChildRuntimeConfig
} from '../../phi-extension/lib/rpc-child-config'
import { validateRpcChildRoute } from '../../phi-extension/lib/rpc-child-protocol'
import { privateRemotePrefix } from '../extension-deployment/remote-commands'
import type { PhiExtensionFile } from '../extension-deployment/types'
import { storageHost } from '../session-storage/remote-preflight'
import type { RpcRuntimePreparationContext } from '../ssh-stdio-factory'
import { compileRpcAgentDefinitions } from './definition-compiler'
import { snapshotBinding, modelRef } from './definition-validation'
import { rpcChildProfileFromDefinition } from './run-registry'
import {
  prepareProductionChildResources,
  productionChildProfileResources,
  snapshotProductionChildResources
} from './production-child-resources'
import type { RpcAgentServerBinding } from './types'
import type { RpcAgentToolDescriptor } from './types'
import type { RpcAgentResourceCatalogInput, CompileRpcAgentDefinitionsOptions } from './types'
import { projectRpcChildModel } from '../../phi-extension/lib/rpc-child-protocol'
import { CHILD_SKILL_DIRECTORY } from '../../phi-extension/lib/rpc-child-resources'
import { planRpcPublishedAgentNames } from './published-agent-names'

export interface SelectedChildDeploymentBinding {
  readonly hostProfileId: string
  readonly bindingHash: string
  readonly projectId: string
  readonly projectRoot: string
}
/** Profile/project deployment configuration binding; this is not a machine/SSH host-key fingerprint. */
export function deriveProductionChildBinding(
  actual: RemoteWorkspaceHostBinding,
  selected: SelectedChildDeploymentBinding
): Readonly<RpcAgentServerBinding> {
  const key: unknown = JSON.parse(actual.cacheKey)
  const digest = createHash('sha256').update(actual.cacheKey).digest('hex')
  if (
    !Array.isArray(key) ||
    key.length !== 4 ||
    key[0] !== selected.hostProfileId ||
    key[1] !== actual.remoteRoot ||
    key[2] !== actual.canonicalRoot ||
    digest !== selected.bindingHash ||
    actual.projectId !== selected.projectId ||
    actual.canonicalRoot !== selected.projectRoot
  )
    throw new Error('Selected child SSH deployment binding differs from the resolved project')
  return Object.freeze(
    snapshotBinding({
      serverId: selected.hostProfileId,
      serverIdentitySha256: digest,
      projectId: actual.projectId,
      projectRoot: actual.canonicalRoot
    })
  )
}

export interface PreparedProductionChildConfig {
  /** Private capability material: never forward to the facade's public event/state stream. */
  readonly config: Readonly<RpcChildRuntimeConfig>
}
const issued = new WeakMap<PreparedProductionChildConfig, readonly PhiExtensionFile[]>()
export function assertPreparedProductionChildConfig(prepared: PreparedProductionChildConfig): void {
  if (!issued.has(prepared))
    throw new Error('Child configuration was not issued by the trusted compiler')
}
export interface CreateProductionChildConfigOptions {
  readonly resources?: RpcAgentResourceCatalogInput
  readonly availableSkills?: readonly string[]
  readonly resolveEnvironment?: CompileRpcAgentDefinitionsOptions['resolveEnvironment']
  readonly allowBackground?: boolean
  readonly allowParallel?: boolean
  /** The exact parent capability set; omission retains the accepted conservative native subset. */
  readonly availableTools?: readonly RpcAgentToolDescriptor[]
  readonly identity: RpcChildConfigIdentity
  readonly binding: RpcAgentServerBinding
  readonly definitions: readonly PhiAgentDefinition[]
  /** Persisted project aliases keyed by the source Phi agent name. */
  readonly aliases?: Readonly<Record<string, string>>
  readonly blockedAgents?: Readonly<
    Record<string, { readonly filePath: string; readonly contentHash: string }>
  >
  readonly modelDescriptors: readonly SafeModelDescriptor[]
  readonly parentModel: ModelGatewayModelRef
  readonly parentThinkingLevel: PhiAgentThinkingLevel
  /** Supplied by the currently owned model-gateway/reverse-tunnel generation. */
  readonly native: { readonly endpoint: string; readonly models: readonly ModelGatewayModelRef[] }
  readonly otherCapabilities: readonly string[]
}

/** Compile trusted Phi definitions, refusing the whole unsupported profile instead of dropping fields. */
export async function createProductionChildConfig(
  options: CreateProductionChildConfigOptions
): Promise<PreparedProductionChildConfig> {
  const identity = Object.freeze({ ...options.identity })
  const binding = snapshotBinding(options.binding)
  if (
    binding.projectId !== identity.projectId ||
    binding.projectRoot !== identity.projectRoot ||
    !options.definitions.length ||
    options.definitions.length > 32
  )
    throw new Error('Child compiler lacks its owned project binding')
  const definitions = structuredClone(options.definitions)
  const publication = planRpcPublishedAgentNames(definitions, binding, options.aliases)
  const models = structuredClone(options.modelDescriptors)
  const parent = Object.freeze({ ...options.parentModel })
  const otherCapabilities = [...options.otherCapabilities]
  const resourceSnapshot = snapshotProductionChildResources(options.resources)
  const availableSkills = [
    ...(options.availableSkills ??
      resourceSnapshot?.catalog.skills.map((skill) => skill.name) ??
      [])
  ]
  const resolveEnvironment = options.resolveEnvironment
  const parentThinkingLevel = options.parentThinkingLevel
  const allowBackground = options.allowBackground
  const allowParallel = options.allowParallel
  if (
    [allowBackground, allowParallel].some(
      (value) => value !== undefined && typeof value !== 'boolean'
    )
  )
    throw new Error('Invalid child task policy flags')
  if (
    !Array.isArray(options.native.models) ||
    !options.native.models.length ||
    options.native.models.length > 256
  )
    throw new Error('Invalid child published model budget')
  const nativeModels = options.native.models.map(modelRef)
  const availableTools = structuredClone(
    options.availableTools ??
      ['read', 'write', 'bash'].map((name) => ({ name, site: 'native' as const }))
  )
  const endpoint = new URL(options.native.endpoint)
  if (
    endpoint.href !== options.native.endpoint ||
    endpoint.pathname !== '/v1/pi/stream' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !nativeModels.some((model) => model.provider === parent.provider && model.id === parent.id)
  )
    throw new Error('Child compiler lacks the owned parent model route')
  const route = validateRpcChildRoute({
    api: 'openai-completions',
    baseUrl: endpoint.origin,
    transport: 'pi-native'
  })
  for (const definition of definitions)
    if (definition.warnings.length) throw new Error('Unsupported foreground child definition')
  const compiled = await compileRpcAgentDefinitions({
    definitions,
    binding,
    availableModels: models,
    parentModel: parent,
    parentThinkingLevel,
    availableTools,
    availableSkills,
    publishedNames: options.aliases ?? {},
    ...(resolveEnvironment ? { resolveEnvironment } : {})
  })
  if (compiled.warnings.length) throw new Error('Child model fallback is not supported')
  const selected = compiled.manifest.entries.filter(
    (entry) => entry.blocking || allowBackground === true
  )
  if (selected.length > 32) throw new Error('Child profiles exceed the existing count budget')
  const resources = prepareProductionChildResources(resourceSnapshot, selected)
  const profiles = selected.map((entry) => {
    const sourceName = publication.find(
      (candidate) => candidate.nativeName === entry.nativeName
    )?.sourceName
    const definition = definitions.find((source) => source.name === sourceName)
    const model = models.find(
      (candidate) => candidate.provider === entry.model.provider && candidate.id === entry.model.id
    )
    if (
      !definition ||
      !model ||
      !nativeModels.some(
        (published) =>
          published.provider === entry.model.provider && published.id === entry.model.id
      )
    )
      throw new Error('Child model differs from its published owned route')
    const basePrompt = [definition.systemPrompt, AGENT_REPORT_PROTOCOL]
    return rpcChildProfileFromDefinition(
      entry,
      basePrompt,
      model,
      route,
      productionChildProfileResources(entry, basePrompt, resources)
    )
  })
  const profileNames = new Set(profiles.map((profile) => profile.definition.nativeName))
  const blockedAgents = Object.entries(options.blockedAgents ?? {})
    .filter(([nativeName]) => profileNames.has(nativeName))
    .map(([nativeName, conflict]) => ({ nativeName, ...conflict }))
  const files = [
    ...compiled.files.filter(
      (file) =>
        file.path === 'phi-agent-definitions.json' ||
        profiles.some((profile) => file.path === `agents/${profile.definition.nativeName}.md`)
    ),
    ...resources.files
  ]
  if (
    files.some((file) => file.bytes.length > 128 * 1024) ||
    files.reduce((total, file) => total + file.bytes.length, 0) > 1024 * 1024
  )
    throw new Error('Private child artifacts exceed the existing byte budget')
  const config = validateRpcChildRuntimeConfig(
    {
      schema: 1,
      ...identity,
      manifestHash: compiled.manifestHash,
      manifestBinding: binding,
      capability: randomBytes(32).toString('hex'),
      parentModel: projectRpcChildModel(
        models.find((model) => model.provider === parent.provider && model.id === parent.id)
      ),
      profiles,
      ...(blockedAgents.length ? { blockedAgents } : {}),
      ...(resources.catalog ? { resources: resources.catalog } : {}),
      files: files.map(({ path, sha256 }) => ({ path, sha256 })),
      policy: {
        mode: 'foreground-native',
        taskShape: 'single',
        ...(allowBackground === undefined ? {} : { allowBackground }),
        ...(allowParallel === undefined ? {} : { allowParallel })
      }
    },
    identity,
    otherCapabilities
  )
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_RPC_CHILD_CONFIG_BYTES)
    throw new Error('Child configuration exceeds its supported byte limit')
  const prepared = Object.freeze({ config })
  issued.set(
    prepared,
    files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }))
  )
  return prepared
}

/** Registered writer-owned publication, complete before the official CLI may start. */
export async function publishProductionChildConfig(options: {
  readonly prepared: PreparedProductionChildConfig
  readonly context: RpcRuntimePreparationContext
  readonly host: WorkspaceHost
  readonly uploadOptions?: RemoteUploadFileOptions
}): Promise<void> {
  const { prepared, context, host } = options
  const files = issued.get(prepared)
  const storage = context.storage
  const config = prepared.config
  const transfer = host.transfer
  if (!files || !storage || storageHost(storage) !== host || !transfer)
    throw new Error('Child publication requires its compiler output and registered writer host')
  storage.lease.assertActive()
  context.signal.throwIfAborted()
  if (
    config.nonce !== context.bootstrap.nonce ||
    config.phiSessionId !== context.params.sessionId ||
    config.phiSessionId !== context.bootstrap.sessionId ||
    config.phiSessionId !== storage.scope.phiSessionId ||
    config.projectId !== storage.scope.projectId ||
    config.projectId !== context.bootstrap.projectId ||
    config.projectRoot !== storage.scope.projectRoot ||
    config.projectRoot !== context.params.cwd ||
    config.projectRoot !== context.bootstrap.projectRoot ||
    config.manifestBinding.serverId !== storage.scope.hostProfileId ||
    config.manifestBinding.serverIdentitySha256 !== storage.scope.bindingHash ||
    config.generation !== context.generation ||
    context.agentDir !== posix.join(context.generationDirectory, 'home/.omp/agent') ||
    context.generationDirectory !==
      posix.join(storage.scope.runtimeRoot, 'rpc-sessions', config.nonce)
  )
    throw new Error('Child publication differs from its private launch generation')
  const sidecar = Buffer.from(JSON.stringify(config))
  if (sidecar.length > MAX_RPC_CHILD_CONFIG_BYTES)
    throw new Error('Child configuration exceeds its supported byte limit')
  const prefix = privateRemotePrefix(storage.scope.runtimeRoot)
  const run = async (command: string): Promise<void> => {
    storage.lease.assertActive()
    context.signal.throwIfAborted()
    const result = await host.exec.run(['sh', '-c', `${prefix}\n${command}`], {
      cwd: storage.scope.runtimeRoot,
      signal: context.signal,
      timeoutMs: 30000,
      maxOutputBytes: 1024
    })
    if (result.code !== 0 || result.truncated || result.terminationReason)
      throw new Error('Cannot publish private child runtime configuration')
    storage.lease.assertActive()
    context.signal.throwIfAborted()
  }
  const runChecks = async (checks: readonly string[]): Promise<void> => {
    // Leave room below Linux's 128 KiB single-argument limit for shell wrapping.
    const maximum = 32 * 1024
    let batch: string[] = []
    let bytes = Buffer.byteLength(prefix) + 1
    for (const check of checks) {
      const size = Buffer.byteLength(check) + 1
      if (Buffer.byteLength(prefix) + 1 + size > maximum)
        throw new Error('Private child metadata check exceeds its command byte limit')
      if (bytes + size > maximum) {
        await run(batch.join('\n'))
        batch = []
        bytes = Buffer.byteLength(prefix) + 1
      }
      batch.push(check)
      bytes += size
    }
    if (batch.length) await run(batch.join('\n'))
  }
  const publication = [
    ...files.map((file) => ({ ...file, destination: posix.join(context.agentDir, file.path) })),
    {
      path: RPC_CHILD_RUNTIME_FILE,
      bytes: sidecar,
      sha256: createHash('sha256').update(sidecar).digest('hex'),
      destination: posix.join(context.generationDirectory, RPC_CHILD_RUNTIME_FILE)
    }
  ]
  const agentDirectory = posix.join(context.agentDir, 'agents')
  const skillDirectory = posix.join(context.agentDir, CHILD_SKILL_DIRECTORY)
  const checks = [
    `private_dir ${q(context.generationDirectory)}`,
    `[ "$(cd -- ${q(context.generationDirectory)} && pwd -P)" = ${q(context.generationDirectory)} ] || fail 'Child generation directory is not canonical'`,
    `private_dir ${q(context.agentDir)}`,
    `[ "$(cd -- ${q(context.agentDir)} && pwd -P)" = ${q(context.agentDir)} ] || fail 'Child agent directory is not canonical'`,
    `[ ! -e ${q(agentDirectory)} ] && [ ! -L ${q(agentDirectory)} ] || fail 'Child generation directory already exists'`,
    `private_dir ${q(agentDirectory)}`
  ]
  if (files.some((file) => file.path.startsWith(CHILD_SKILL_DIRECTORY + '/')))
    checks.push(
      `[ ! -e ${q(skillDirectory)} ] && [ ! -L ${q(skillDirectory)} ] || fail 'Child skill directory already exists'`,
      `private_dir ${q(skillDirectory)}`
    )
  await runChecks([
    ...checks,
    ...publication.map(
      (file) =>
        `[ ! -e ${q(file.destination)} ] && [ ! -L ${q(file.destination)} ] || fail 'Child generation file already exists'`
    )
  ])
  const local = await mkdtemp(join(tmpdir(), 'phi-child-publication-'))
  try {
    const upload = async (file: (typeof publication)[number], index: number): Promise<void> => {
      storage.lease.assertActive()
      context.signal.throwIfAborted()
      const source = join(local, String(index))
      await writeFile(source, file.bytes, { mode: 0o600, flag: 'wx' })
      storage.lease.assertActive()
      context.signal.throwIfAborted()
      await transfer.uploadFile(source, file.destination, {
        ...options.uploadOptions,
        signal: context.signal,
        expectedSha256: file.sha256
      })
      storage.lease.assertActive()
      context.signal.throwIfAborted()
    }
    const verify = (file: (typeof publication)[number]): string =>
      `private_file ${q(file.destination)}\n[ "$(hash_file ${q(file.destination)})" = ${q(file.sha256)} ] || fail 'Private child artifact was corrupted'`
    const artifacts = publication.slice(0, -1)
    const last = publication[publication.length - 1]
    for (const [index, file] of artifacts.entries()) await upload(file, index)
    await runChecks([
      ...artifacts.map(verify),
      `[ ! -e ${q(last.destination)} ] && [ ! -L ${q(last.destination)} ] || fail 'Child generation file already exists'`
    ])
    // The sidecar is a readiness barrier: no consumer may see it before artifacts verify.
    await upload(last, publication.length - 1)
    await runChecks([verify(last)])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}
