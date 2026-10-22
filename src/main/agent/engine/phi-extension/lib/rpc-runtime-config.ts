import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { RpcBootstrapConfig } from './rpc-config'
import {
  executionCapability,
  executionLaunchIdentity,
  executionRoster,
  type RpcExecutionTool
} from './rpc-execution-protocol'

export const RPC_RUNTIME_FILE = 'runtime.json'
export const RPC_RUNTIME_COMMAND = 'phi-rpc-runtime-attest'
export const RPC_RUNTIME_DESCRIPTION = 'Phi composed RPC runtime v1'
export const RPC_RUNTIME_MAX_BYTES = 2 * 1024 * 1024
export function rpcRuntimeConfigDigest(config: RpcRuntimeConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export interface RpcRuntimeConfig {
  readonly promptPolicyHash?: string
  readonly schema: 1
  readonly nonce: string
  readonly phiSessionId: string
  readonly projectId: string
  readonly projectRoot: string
  readonly generation: number
  readonly childRuntimeRequired?: boolean
  readonly activeTools: readonly string[]
  readonly hiddenTools: readonly string[]
  readonly generationDirectory: string
  readonly directory: string
  readonly journals: string
  readonly blobs: string
  readonly execution: { readonly capability: string; readonly tools: readonly RpcExecutionTool[] }
  readonly result: {
    readonly capability: string
    readonly leaseId: string
    readonly directory: string
  }
  readonly native: {
    readonly endpoint: string
    readonly models: readonly { readonly provider: string; readonly id: string }[]
    /** A separately scoped reverse tunnel for Cursor's native HTTP/2 transport. */
    readonly cursorEndpoint?: string
  }
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw new Error('Invalid private RPC runtime configuration')
}
function privateDirectory(path: string): void {
  const s = lstatSync(path)
  if (
    !s.isDirectory() ||
    (s.mode & 0o777) !== 0o700 ||
    (process.getuid && s.uid !== process.getuid()) ||
    realpathSync(path) !== path
  )
    throw new Error('Invalid private RPC runtime directory')
}
export function validateRpcRuntimeConfig(
  value: unknown,
  bootstrap: RpcBootstrapConfig,
  configPath: string
): RpcRuntimeConfig {
  exact(value, [
    'schema',
    'nonce',
    'phiSessionId',
    'projectId',
    'projectRoot',
    'generation',
    'activeTools',
    'hiddenTools',
    'generationDirectory',
    'directory',
    'journals',
    'blobs',
    'execution',
    'result',
    'native',
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'childRuntimeRequired')
      ? ['childRuntimeRequired']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'promptPolicyHash')
      ? ['promptPolicyHash']
      : [])
  ])
  if (value.childRuntimeRequired !== undefined && typeof value.childRuntimeRequired !== 'boolean')
    throw new Error('Invalid child runtime intent')
  if (
    value.promptPolicyHash !== undefined &&
    (typeof value.promptPolicyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.promptPolicyHash))
  )
    throw new Error('Invalid Phi prompt publication hash')
  exact(value.execution, ['capability', 'tools'])
  exact(value.result, ['capability', 'leaseId', 'directory'])
  exact(value.native, [
    'endpoint',
    'models',
    ...(value.native && typeof value.native === 'object' && Object.hasOwn(value.native, 'cursorEndpoint')
      ? ['cursorEndpoint']
      : [])
  ])
  const generationDirectory = dirname(configPath)
  if (
    value.schema !== 1 ||
    value.nonce !== bootstrap.nonce ||
    value.phiSessionId !== bootstrap.sessionId ||
    value.projectId !== bootstrap.projectId ||
    value.projectRoot !== bootstrap.projectRoot ||
    value.generationDirectory !== generationDirectory ||
    dirname(generationDirectory).split('/').at(-1) !== 'rpc-sessions' ||
    generationDirectory.split('/').at(-1) !== bootstrap.nonce ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  )
    throw new Error('RPC runtime identity does not match bootstrap')
  executionLaunchIdentity({
    nonce: bootstrap.nonce,
    phiSessionId: bootstrap.sessionId,
    projectId: bootstrap.projectId,
    cwd: bootstrap.projectRoot,
    generation: value.generation as number
  })
  if (
    !executionCapability(value.execution.capability) ||
    !executionCapability(value.result.capability) ||
    value.execution.capability === value.result.capability ||
    value.execution.capability === bootstrap.nonce ||
    value.result.capability === bootstrap.nonce
  )
    throw new Error('RPC runtime requires independent private capabilities')
  if (
    typeof value.directory !== 'string' ||
    value.directory !== resolve(value.directory) ||
    value.journals !== join(value.directory, 'journals') ||
    value.blobs !== join(value.directory, 'data/omp/blobs') ||
    dirname(dirname(value.directory)) !==
      join(dirname(dirname(generationDirectory)), 'omp-sessions') ||
    !/^[a-f0-9]{64}$/u.test(value.directory.split('/').at(-2)!) ||
    value.directory.split('/').at(-1) !== bootstrap.sessionId
  )
    throw new Error('RPC runtime persistent layout is invalid')
  if (
    typeof value.result.leaseId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.result.leaseId) ||
    typeof value.result.directory !== 'string' ||
    dirname(value.result.directory) !== generationDirectory ||
    !/^host-results-[a-f0-9]{64}$/u.test(value.result.directory.split('/').at(-1)!)
  )
    throw new Error('RPC runtime result scope is invalid')
  if (!Array.isArray(value.execution.tools)) throw new Error('Invalid RPC runtime tool roster')
  const tools: RpcExecutionTool[] = value.execution.tools.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid RPC runtime tool')
    const tool = raw as Record<string, unknown>
    exact(tool, tool.site === 'host' ? ['name', 'site', 'parameters'] : ['name', 'site'])
    if (typeof tool.name !== 'string' || (tool.site !== 'native' && tool.site !== 'host'))
      throw new Error('Invalid RPC runtime tool')
    if (tool.site === 'host') {
      if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))
        throw new Error('Invalid RPC runtime host schema')
      return {
        name: tool.name,
        site: tool.site,
        parameters: tool.parameters as Record<string, unknown>
      }
    }
    return { name: tool.name, site: tool.site }
  })
  const roster = executionRoster(tools, { allowNativeTask: value.childRuntimeRequired === true })
  if (roster.tools.some((tool) => tool.name === 'task') !== (value.childRuntimeRequired === true))
    throw new Error('Native task requires matching child runtime intent')
  if (
    !Array.isArray(value.activeTools) ||
    new Set(value.activeTools).size !== value.activeTools.length ||
    value.activeTools.some(
      (name: unknown) =>
        typeof name !== 'string' || !roster.tools.some((tool) => tool.name === name)
    ) ||
    roster.tools.some(
      (tool) => tool.site === 'native' && !(value.activeTools as unknown[]).includes(tool.name)
    )
  )
    throw new Error('Invalid RPC runtime active roster')
  if (
    !Array.isArray(value.hiddenTools) ||
    value.hiddenTools.some(
      (name: unknown) =>
        typeof name !== 'string' ||
        !roster.tools.some((tool) => tool.site === 'host' && tool.name === name)
    ) ||
    new Set([...value.activeTools, ...value.hiddenTools]).size !== roster.tools.length ||
    value.activeTools.length + value.hiddenTools.length !== roster.tools.length
  )
    throw new Error('Invalid RPC runtime hidden roster')
  const endpoint = new URL(value.native.endpoint as string)
  if (
    endpoint.href !== value.native.endpoint ||
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.pathname !== '/v1/pi/stream' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !Array.isArray(value.native.models) ||
    value.native.models.length < 1 ||
    value.native.models.length > 4096
  )
    throw new Error('Invalid owned RPC native gateway')
  if (value.native.cursorEndpoint !== undefined) {
    const cursor = new URL(value.native.cursorEndpoint as string)
    if (
      cursor.protocol !== 'http:' ||
      cursor.hostname !== '127.0.0.1' ||
      !cursor.port ||
      cursor.origin !== value.native.cursorEndpoint ||
      cursor.username ||
      cursor.password ||
      cursor.search ||
      cursor.hash
    )
      throw new Error('Invalid owned Cursor native gateway')
  }
  const models = new Set<string>()
  for (const model of value.native.models) {
    exact(model, ['provider', 'id'])
    if (
      typeof model.provider !== 'string' ||
      typeof model.id !== 'string' ||
      !model.provider ||
      !model.id ||
      model.provider.length > 256 ||
      model.id.length > 256 ||
      models.has(JSON.stringify([model.provider, model.id]))
    )
      throw new Error('Invalid owned RPC native model')
    models.add(JSON.stringify([model.provider, model.id]))
  }
  for (const path of [
    dirname(generationDirectory),
    generationDirectory,
    join(generationDirectory, 'home'),
    join(generationDirectory, 'home/.omp'),
    join(generationDirectory, 'home/.omp/agent'),
    dirname(dirname(value.directory)),
    dirname(value.directory),
    value.directory,
    value.journals,
    join(value.directory, 'data'),
    join(value.directory, 'data/omp'),
    value.blobs,
    value.result.directory
  ])
    privateDirectory(path as string)
  if (
    realpathSync(process.env.PI_CODING_AGENT_DIR ?? '') !==
      join(generationDirectory, 'home/.omp/agent') ||
    process.env.HOME !== join(generationDirectory, 'home') ||
    process.env.XDG_DATA_HOME !== join(value.directory, 'data')
  )
    throw new Error('RPC runtime process layout differs from the owned launch')
  return Object.freeze({
    ...value,
    activeTools: Object.freeze([...value.activeTools]),
    hiddenTools: Object.freeze([...value.hiddenTools]),
    execution: Object.freeze({ capability: value.execution.capability, tools: roster.tools }),
    result: Object.freeze({ ...value.result }),
    native: Object.freeze({
      endpoint: value.native.endpoint,
      ...(value.native.cursorEndpoint === undefined
        ? {}
        : { cursorEndpoint: value.native.cursorEndpoint }),
      models: Object.freeze(
        (value.native.models as RpcRuntimeConfig['native']['models']).map((model) =>
          Object.freeze({ ...model })
        )
      )
    })
  }) as unknown as RpcRuntimeConfig
}

/** Fixed sibling only. No env-selected path, permissive UTF-8, symbolic link or shared inode. */
export function loadRpcRuntimeConfig(
  configPath: string,
  bootstrap: RpcBootstrapConfig
): RpcRuntimeConfig | undefined {
  const path = join(dirname(configPath), RPC_RUNTIME_FILE)
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (realpathSync(path) !== path) throw new Error('Private RPC runtime path must be canonical')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > RPC_RUNTIME_MAX_BYTES
    )
      throw new Error('Invalid private RPC runtime file')
    const bytes = Buffer.alloc(RPC_RUNTIME_MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size !== stat.size || size > RPC_RUNTIME_MAX_BYTES)
      throw new Error('Private RPC runtime file changed or exceeded its limit')
    const after = fstatSync(fd),
      named = lstatSync(path)
    for (const current of [after, named])
      if (
        ['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].some(
          (key) => current[key as keyof typeof current] !== stat[key as keyof typeof stat]
        )
      )
        throw new Error('Private RPC runtime file changed during loading')
    try {
      return validateRpcRuntimeConfig(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))),
        bootstrap,
        configPath
      )
    } catch {
      throw new Error('Phi RPC private runtime configuration was refused')
    }
  } finally {
    closeSync(fd)
  }
}
