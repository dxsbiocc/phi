import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { createApprovalEnvelope, approvalIdentifier } from './rpc-approval-protocol'
import { executionCapability } from './rpc-execution-protocol'

export interface RpcChildHostResource {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly schemaSha256: string
}
export interface RpcChildSkillResource {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly sha256: string
}
export interface RpcChildEnvironmentExecution {
  readonly runtimeRoot: string
  readonly micromambaPath: string
  readonly prefixPath: string
  readonly markerPath: string
  readonly markerSha256: string
}
export interface RpcChildEnvironmentResource {
  readonly ref: string
  readonly pluginId?: string
  readonly environmentId: string
  readonly lockSha256: string
  readonly status: 'ready'
  readonly binding: {
    readonly serverId: string
    readonly serverIdentitySha256: string
    readonly projectId: string
    readonly projectRoot: string
  }
  readonly execution: RpcChildEnvironmentExecution
}
export interface RpcChildResourceCatalog {
  readonly hostTools: readonly RpcChildHostResource[]
  readonly skills: readonly RpcChildSkillResource[]
  readonly environments: readonly RpcChildEnvironmentResource[]
}
export const CHILD_SKILL_DIRECTORY = 'phi-child-skills'
export const CHILD_SKILL_MAX_BYTES = 64 * 1024
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new Error('Invalid trusted child resource shape')
}
export function snapshotChildResourceJson(value: unknown): Record<string, unknown> {
  return createApprovalEnvelope(
    {
      nonce: 'phi-rpc-child-resources-v1',
      phiSessionId: 'resources',
      projectId: 'resources',
      cwd: '/',
      generation: 1,
      ompSessionId: 'resources',
      runId: 'resources'
    },
    'resources',
    'resources',
    value
  ).input
}
const snapshot = snapshotChildResourceJson
export function childResourceHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(snapshot({ value }).value))
    .digest('hex')
}
function canonicalPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 4096 &&
    posix.normalize(value) === value &&
    ![...value].some(
      (character) =>
        character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
}
export function validateChildEnvironmentExecution(
  value: unknown
): Readonly<RpcChildEnvironmentExecution> {
  const raw = snapshot(value)
  exact(raw, ['runtimeRoot', 'micromambaPath', 'prefixPath', 'markerPath', 'markerSha256'])
  if (
    !canonicalPath(raw.runtimeRoot) ||
    raw.runtimeRoot === '/' ||
    !executionCapability(raw.markerSha256) ||
    !['micromambaPath', 'prefixPath', 'markerPath'].every(
      (key) => canonicalPath(raw[key]) && (raw[key] as string).startsWith(raw.runtimeRoot + '/')
    )
  )
    throw new Error('Child environment execution is outside its managed runtime')
  return Object.freeze(raw) as unknown as Readonly<RpcChildEnvironmentExecution>
}
export function validateChildResourceCatalog(value: unknown): Readonly<RpcChildResourceCatalog> {
  const raw = snapshot(value)
  exact(raw, ['hostTools', 'skills', 'environments'])
  if (
    !Array.isArray(raw.hostTools) ||
    raw.hostTools.length > 1024 ||
    !Array.isArray(raw.skills) ||
    raw.skills.length > 1024 ||
    !Array.isArray(raw.environments) ||
    raw.environments.length > 64
  )
    throw new Error('Invalid child resource roster')
  const hosts = new Set<string>(),
    skills = new Set<string>(),
    envs = new Set<string>()
  for (const tool of raw.hostTools) {
    exact(tool, ['name', 'description', 'parameters', 'schemaSha256'])
    if (
      !approvalIdentifier(tool.name) ||
      hosts.has(tool.name) ||
      typeof tool.description !== 'string' ||
      !tool.description ||
      Buffer.byteLength(tool.description) > 16384 ||
      !tool.parameters ||
      typeof tool.parameters !== 'object' ||
      Array.isArray(tool.parameters) ||
      childResourceHash(tool.parameters) !== tool.schemaSha256
    )
      throw new Error('Invalid trusted child host tool')
    hosts.add(tool.name)
  }
  for (const skill of raw.skills) {
    exact(skill, ['name', 'description', 'path', 'sha256'])
    if (
      !approvalIdentifier(skill.name) ||
      skills.has(skill.name) ||
      typeof skill.description !== 'string' ||
      Buffer.byteLength(skill.description) > 4096 ||
      !executionCapability(skill.sha256) ||
      skill.path !== `${CHILD_SKILL_DIRECTORY}/${skill.sha256}.md`
    )
      throw new Error('Invalid trusted child skill')
    skills.add(skill.name)
  }
  for (const env of raw.environments) {
    exact(env, [
      'ref',
      'environmentId',
      'lockSha256',
      'status',
      'binding',
      'execution',
      ...(Object.hasOwn(env, 'pluginId') ? ['pluginId'] : [])
    ])
    exact(env.binding, ['serverId', 'serverIdentitySha256', 'projectId', 'projectRoot'])
    const key = JSON.stringify([env.ref, env.pluginId ?? null])
    if (
      !approvalIdentifier(env.ref) ||
      !approvalIdentifier(env.environmentId) ||
      envs.has(key) ||
      env.status !== 'ready' ||
      !executionCapability(env.lockSha256) ||
      !approvalIdentifier(env.binding.serverId) ||
      !approvalIdentifier(env.binding.projectId) ||
      !executionCapability(env.binding.serverIdentitySha256) ||
      !canonicalPath(env.binding.projectRoot) ||
      (env.pluginId !== undefined && !approvalIdentifier(env.pluginId))
    )
      throw new Error('Invalid trusted child environment')
    validateChildEnvironmentExecution(env.execution)
    envs.add(key)
  }
  return Object.freeze({
    hostTools: Object.freeze(raw.hostTools.map((tool) => Object.freeze(tool))),
    skills: Object.freeze(raw.skills.map((skill) => Object.freeze(skill))),
    environments: Object.freeze(
      raw.environments.map((env) =>
        Object.freeze({ ...env, execution: validateChildEnvironmentExecution(env.execution) })
      )
    )
  }) as unknown as Readonly<RpcChildResourceCatalog>
}
export function childProfileResourceDigest(
  profile: {
    tools: readonly { readonly name: string; readonly site: string }[]
    skills: readonly string[]
    environment?: { readonly ref: string; readonly pluginId?: string }
  },
  catalog: RpcChildResourceCatalog
): string {
  const hostTools = profile.tools
    .filter((tool) => tool.site === 'host')
    .map((tool) => {
      const resource = catalog.hostTools.find((item) => item.name === tool.name)
      if (!resource) throw new Error('Declared child host resource is unavailable')
      return resource
    })
  const skills = profile.skills.map((name) => {
    const resource = catalog.skills.find((item) => item.name === name)
    if (!resource) throw new Error('Declared child skill content is unavailable')
    return resource
  })
  const environment = profile.environment
    ? catalog.environments.find(
        (item) =>
          item.ref === profile.environment!.ref && item.pluginId === profile.environment!.pluginId
      )
    : undefined
  if (profile.environment && !environment)
    throw new Error('Declared child environment is unavailable')
  return childResourceHash({ hostTools, skills, ...(environment ? { environment } : {}) })
}
export function rpcChildEffectivePrompt(
  base: readonly string[],
  skills: readonly { readonly name: string; readonly markdown: string }[],
  environment?: RpcChildEnvironmentResource
): readonly string[] {
  return Object.freeze([
    ...base,
    ...skills.map(
      (skill) =>
        `<phi-trusted-skill name=${JSON.stringify(skill.name)}>\n${skill.markdown}\n</phi-trusted-skill>`
    ),
    ...(environment
      ? [
          `Phi managed environment ${environment.ref} is ready. Bash executes only inside its locked managed prefix; request extra dependencies through the declared env_request tool.`
        ]
      : [])
  ])
}
