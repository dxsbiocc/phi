import { RPC_CHILD_CONCURRENCY_LIMIT } from './rpc-task-capacity'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createApprovalEnvelope, approvalIdentifier } from './rpc-approval-protocol'
import { executionCapability } from './rpc-execution-protocol'
import {
  validateChildResourceCatalog,
  childProfileResourceDigest,
  type RpcChildSkillResource,
  type RpcChildResourceCatalog
} from './rpc-child-resources'
import {
  sameRpcChildModel,
  sameRpcChildRoute,
  snapshotRpcChildProfile,
  validateRpcChildRoot,
  type RpcChildRootScope,
  type RpcChildTrustedProfile,
  validateRpcChildModel,
  type RpcChildModelDescriptor
} from './rpc-child-protocol'

export const RPC_CHILD_RUNTIME_FILE = 'child-runtime.json'
export const CHILD_ATTEST_COMMAND = 'phi-rpc-child-attest'
export const CHILD_ATTEST_DESCRIPTION = 'Phi foreground child authority v1'
export const MAX_RPC_CHILD_CONFIG_BYTES = 128 * 1024
export interface RpcChildConfigIdentity {
  readonly nonce: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly projectRoot: string
  readonly generation: number
}
export interface RpcChildRuntimeConfig extends RpcChildConfigIdentity {
  readonly resources?: RpcChildResourceCatalog
  readonly parentModel?: RpcChildModelDescriptor
  readonly schema: 1
  readonly manifestHash: string
  readonly manifestBinding: {
    readonly serverId: string
    readonly serverIdentitySha256: string
    readonly projectId: string
    readonly projectRoot: string
  }
  readonly capability: string
  readonly profiles: readonly RpcChildTrustedProfile[]
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
  readonly policy: {
    readonly mode: 'foreground-native'
    readonly taskShape: 'single'
    readonly allowBackground?: boolean
    readonly allowParallel?: boolean
  }
}
export interface RpcChildAttestation {
  readonly type: 'phi_rpc_child_attestation'
  readonly schema: 1
  readonly nonce: string
  readonly configHash: string
  readonly manifestHash: string
  readonly identity: RpcChildRootScope
  readonly hmac: string
}
export interface RpcForegroundTaskInput {
  readonly agent: string
  readonly task: string
  readonly solutionSpace: string
  readonly name?: string
}
/** Raw/effective native task policy, shared by root admission and the authenticated Node ledger. */
export function validateRpcForegroundTaskInput(
  input: unknown,
  config: RpcChildRuntimeConfig,
  options: { readonly allowIntent?: boolean } = {}
):
  | Readonly<RpcForegroundTaskInput>
  | Readonly<{ context: string; tasks: readonly Readonly<RpcForegroundTaskInput>[] }> {
  const raw = snapshot(input, config)
  if (Object.hasOwn(raw, 'tasks')) {
    if (
      config.policy.allowParallel !== true ||
      Object.keys(raw).some(
        (key) => !['context', 'tasks', ...(options.allowIntent ? ['i'] : [])].includes(key)
      ) ||
      typeof raw.context !== 'string' ||
      !raw.context.trim() ||
      raw.context.length > 65536 ||
      !Array.isArray(raw.tasks) ||
      raw.tasks.length < 1 ||
      raw.tasks.length > RPC_CHILD_CONCURRENCY_LIMIT ||
      (raw.i !== undefined && (typeof raw.i !== 'string' || raw.i.length > 512))
    )
      throw new Error('Native task batch is outside the trusted profile')
    const tasks = raw.tasks.map((task) =>
      validateRpcForegroundTaskInput(task, {
        ...config,
        policy: { ...config.policy, allowParallel: false }
      })
    ) as Readonly<RpcForegroundTaskInput>[]
    const names = tasks.flatMap((task) => (task.name ? [task.name.toLowerCase()] : []))
    if (new Set(names).size !== names.length)
      throw new Error('Native task batch has duplicate names')
    return Object.freeze({ context: raw.context, tasks: Object.freeze(tasks) })
  }
  if (
    Object.keys(raw).some(
      (key) =>
        !['agent', 'task', 'solutionSpace', 'name', ...(options.allowIntent ? ['i'] : [])].includes(
          key
        )
    ) ||
    typeof raw.agent !== 'string' ||
    !config.profiles.some((profile) => profile.definition.nativeName === raw.agent) ||
    !['task', 'solutionSpace'].every(
      (key) =>
        typeof raw[key] === 'string' &&
        (raw[key] as string).trim().length > 0 &&
        (raw[key] as string).length <= 65536
    ) ||
    (raw.name !== undefined &&
      (typeof raw.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(raw.name))) ||
    (raw.i !== undefined && (typeof raw.i !== 'string' || raw.i.length > 512))
  )
    throw new Error('Native foreground task input is outside the trusted profile')
  return Object.freeze({
    agent: raw.agent,
    task: raw.task as string,
    solutionSpace: raw.solutionSpace as string,
    ...(raw.name === undefined ? {} : { name: raw.name as string })
  })
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  )
    throw new Error('Invalid private child configuration shape')
}
function snapshot(value: unknown, identity: RpcChildConfigIdentity): Record<string, unknown> {
  return createApprovalEnvelope(
    {
      ...identity,
      cwd: identity.projectRoot,
      ompSessionId: 'child-config',
      runId: 'child-config'
    },
    'child-config',
    'child-config',
    value
  ).input
}
/** Shared SDK-free DTO; nullable metadata/resources/extra native capability reject the whole profile. */
export function validateRpcChildRuntimeConfig(
  value: unknown,
  identity: RpcChildConfigIdentity,
  otherCapabilities: readonly string[] = []
): Readonly<RpcChildRuntimeConfig> {
  const raw = snapshot(value, identity)
  exact(raw, [
    'schema',
    'nonce',
    'phiSessionId',
    'projectId',
    'projectRoot',
    'generation',
    'manifestHash',
    'manifestBinding',
    'capability',
    'profiles',
    'files',
    'policy',
    ...(Object.hasOwn(raw, 'parentModel') ? ['parentModel'] : []),
    ...(Object.hasOwn(raw, 'resources') ? ['resources'] : [])
  ])
  if (
    raw.schema !== 1 ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1 ||
    (['nonce', 'phiSessionId', 'projectId', 'projectRoot', 'generation'] as const).some(
      (key) => raw[key] !== identity[key]
    ) ||
    !hash(raw.manifestHash) ||
    !executionCapability(raw.capability) ||
    raw.capability === identity.nonce ||
    otherCapabilities.includes(raw.capability)
  )
    throw new Error('Private child configuration identity or capability differs')
  exact(raw.manifestBinding, ['serverId', 'serverIdentitySha256', 'projectId', 'projectRoot'])
  if (
    !approvalIdentifier(raw.manifestBinding.serverId) ||
    !hash(raw.manifestBinding.serverIdentitySha256) ||
    raw.manifestBinding.projectId !== identity.projectId ||
    raw.manifestBinding.projectRoot !== identity.projectRoot
  )
    throw new Error('Private child manifest binding differs')
  exact(raw.policy, [
    'mode',
    'taskShape',
    ...(Object.hasOwn(raw.policy as object, 'allowBackground') ? ['allowBackground'] : []),
    ...(Object.hasOwn(raw.policy as object, 'allowParallel') ? ['allowParallel'] : [])
  ])
  if (
    raw.policy.mode !== 'foreground-native' ||
    raw.policy.taskShape !== 'single' ||
    (raw.policy.allowBackground !== undefined && typeof raw.policy.allowBackground !== 'boolean') ||
    (raw.policy.allowParallel !== undefined && typeof raw.policy.allowParallel !== 'boolean') ||
    !Array.isArray(raw.profiles) ||
    raw.profiles.length < 1 ||
    raw.profiles.length > 32
  )
    throw new Error('Unsupported private child policy')
  const profiles = raw.profiles.map(snapshotRpcChildProfile)
  const resources =
    raw.resources === undefined ? undefined : validateChildResourceCatalog(raw.resources)
  const parentModel =
    raw.parentModel === undefined ? undefined : validateRpcChildModel(raw.parentModel)
  const names = new Set<string>()
  for (const profile of profiles) {
    const definition = profile.definition
    if (
      !(
        definition.blocking ? /^phi_[a-f0-9]{24}_[0-9]+_fg$/u : /^phi_[a-f0-9]{24}_[0-9]+_bg$/u
      ).test(definition.nativeName) ||
      (!definition.blocking && raw.policy.allowBackground !== true) ||
      names.has(definition.nativeName) ||
      (!parentModel && !sameRpcChildModel(profile.model, profiles[0].model)) ||
      !sameRpcChildRoute(profile.route, profiles[0].route)
    )
      throw new Error('Unsupported foreground child profile')
    if (
      definition.resourcesDigest !== undefined &&
      (!resources ||
        childProfileResourceDigest(definition, resources) !== definition.resourcesDigest)
    )
      throw new Error('Child resource digest differs from its shared catalogue')
    names.add(definition.nativeName)
  }
  const resourcePaths = new Set(resources?.skills.map((skill) => skill.path) ?? [])
  if (!Array.isArray(raw.files) || raw.files.length !== profiles.length + 1 + resourcePaths.size)
    throw new Error('Private child file inventory differs')
  const paths = new Set<string>()
  const files = raw.files.map((file: unknown) => {
    exact(file, ['path', 'sha256'])
    if (
      typeof file.path !== 'string' ||
      !hash(file.sha256) ||
      paths.has(file.path) ||
      (file.path !== 'phi-agent-definitions.json' &&
        !profiles.some((profile) => file.path === `agents/${profile.definition.nativeName}.md`) &&
        !resourcePaths.has(file.path))
    )
      throw new Error('Unsupported private child file')
    paths.add(file.path)
    return Object.freeze({ path: file.path, sha256: file.sha256 })
  })
  if (
    !files.some(
      (file) => file.path === 'phi-agent-definitions.json' && file.sha256 === raw.manifestHash
    )
  )
    throw new Error('Private child manifest hash differs')
  const result: RpcChildRuntimeConfig = {
    ...(parentModel ? { parentModel } : {}),
    ...(resources ? { resources } : {}),
    schema: 1,
    nonce: identity.nonce,
    phiSessionId: identity.phiSessionId,
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    generation: identity.generation,
    manifestHash: raw.manifestHash,
    manifestBinding: {
      serverId: raw.manifestBinding.serverId,
      serverIdentitySha256: raw.manifestBinding.serverIdentitySha256,
      projectId: identity.projectId,
      projectRoot: identity.projectRoot
    },
    capability: raw.capability,
    profiles: Object.freeze(profiles),
    files: Object.freeze(files),
    policy: Object.freeze({
      mode: 'foreground-native',
      taskShape: 'single',
      ...(raw.policy.allowBackground === undefined
        ? {}
        : { allowBackground: raw.policy.allowBackground }),
      ...(raw.policy.allowParallel === undefined ? {} : { allowParallel: raw.policy.allowParallel })
    })
  }
  return Object.freeze({ ...result, manifestBinding: Object.freeze(result.manifestBinding) })
}
function privateBytes(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const state = fstatSync(fd)
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      (state.mode & 0o777) !== 0o600 ||
      (process.getuid && state.uid !== process.getuid()) ||
      state.size < 1 ||
      state.size > maximum ||
      realpathSync(path) !== path
    )
      throw new Error('Invalid private child file')
    const bytes = Buffer.alloc(state.size + 1)
    let size = 0,
      count = 0
    do {
      count = readSync(fd, bytes, size, bytes.length - size, null)
      size += count
    } while (count && size < bytes.length)
    if (size !== state.size) throw new Error('Private child file changed during read')
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}
export function readRpcChildSkill(agentDir: string, skill: RpcChildSkillResource): string {
  privateDirectory(join(agentDir, 'phi-child-skills'))
  const bytes = privateBytes(join(agentDir, skill.path), 64 * 1024)
  if (createHash('sha256').update(bytes).digest('hex') !== skill.sha256)
    throw new Error('Trusted child skill content changed')
  const markdown = bytes.toString('utf8')
  if (!Buffer.from(markdown).equals(bytes))
    throw new Error('Trusted child skill content is not UTF-8')
  return markdown
}
function privateDirectory(path: string): void {
  const state = lstatSync(path)
  if (
    !state.isDirectory() ||
    (state.mode & 0o777) !== 0o700 ||
    (process.getuid && state.uid !== process.getuid()) ||
    realpathSync(path) !== path
  )
    throw new Error('Invalid private child directory')
}
export function loadRpcChildRuntimeConfig(
  bootstrapPath: string,
  identity: RpcChildConfigIdentity,
  options: { readonly required?: boolean; readonly otherCapabilities?: readonly string[] } = {}
): Readonly<RpcChildRuntimeConfig> | undefined {
  const generationDirectory = dirname(bootstrapPath)
  const path = join(generationDirectory, RPC_CHILD_RUNTIME_FILE)
  let bytes: Buffer
  try {
    bytes = privateBytes(path, MAX_RPC_CHILD_CONFIG_BYTES)
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Required private child configuration is unavailable')
  }
  privateDirectory(generationDirectory)
  const config = validateRpcChildRuntimeConfig(
    JSON.parse(bytes.toString('utf8')),
    identity,
    options.otherCapabilities
  )
  const agentDir = join(generationDirectory, 'home/.omp/agent')
  privateDirectory(agentDir)
  privateDirectory(join(agentDir, 'agents'))
  let total = 0
  for (const file of config.files) {
    const content = privateBytes(join(agentDir, file.path), 128 * 1024)
    total += content.length
    if (total > 1024 * 1024 || createHash('sha256').update(content).digest('hex') !== file.sha256)
      throw new Error('Private child compiler artifact differs')
  }
  return config
}
export function childConfigDigest(config: RpcChildRuntimeConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(snapshot(config, config)))
    .digest('hex')
}
export function makeRpcChildAttestation(
  config: RpcChildRuntimeConfig,
  root: RpcChildRootScope
): RpcChildAttestation {
  const identity = validateRpcChildRoot(root)
  if (
    identity.phiSessionId !== config.phiSessionId ||
    identity.projectId !== config.projectId ||
    identity.cwd !== config.projectRoot ||
    identity.generation !== config.generation
  )
    throw new Error('Child attestation root scope differs')
  const body = {
    type: 'phi_rpc_child_attestation' as const,
    schema: 1 as const,
    nonce: config.nonce,
    configHash: childConfigDigest(config),
    manifestHash: config.manifestHash,
    identity
  }
  const hmac = createHmac('sha256', Buffer.from(config.capability, 'hex'))
    .update('phi-child-attestation-v1\0' + JSON.stringify(snapshot(body, config)))
    .digest('hex')
  return Object.freeze({ ...body, hmac })
}
export function verifyRpcChildAttestation(
  value: unknown,
  config: RpcChildRuntimeConfig,
  root: RpcChildRootScope
): boolean {
  try {
    const raw = snapshot(value, config)
    exact(raw, ['type', 'schema', 'nonce', 'configHash', 'manifestHash', 'identity', 'hmac'])
    if (!hash(raw.hmac)) return false
    const expected = makeRpcChildAttestation(config, root)
    const { hmac, ...body } = expected
    return (
      Object.entries(body).every(
        ([key, item]) =>
          JSON.stringify(raw[key]) === JSON.stringify(snapshot({ value: item }, config).value)
      ) && timingSafeEqual(Buffer.from(raw.hmac, 'hex'), Buffer.from(hmac, 'hex'))
    )
  } catch {
    return false
  }
}
