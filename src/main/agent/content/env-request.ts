import {
  currentPlatform,
  parseEnvironmentRef,
  type EnvironmentSpec,
  type HostRequirement,
  type PhiPlatform,
  type SourcePackage
} from '../envs'
import { getRuntimeRoot } from '../envs/runtime'
import { solveExplicitLock, type SolveExplicitLockInput } from '../envs/solve'
import {
  applyOverrides,
  nextProjectEnvironmentName,
  readOverrides,
  writeOverrides,
  writeProjectEnvironment
} from '../envs/project-environments'
import type { EnvironmentBuilds } from './environment-builds'
import { describeEnvironment } from './environment-refs'

export const ADD_PACKAGES = '添加'

const MATCH_SPEC = /^[A-Za-z0-9_.-]+(\s*[=<>!~]=?[^\s,;]+(,[<>=!~]=?[^\s,;]+)*)?$/

export interface EnvironmentRequestConfirm {
  runtimeSessionId: string
  packages: readonly string[]
  reason: string
  environment: string
  question: string
}

export type EnvRequestResult =
  | { ref: string; envId: string; name: string; added: string[] }
  | { declined: true }
  | { error: string }

export interface RequestProjectEnvironmentDeps {
  root?: string
  builds?: EnvironmentBuilds
  confirm?: (request: EnvironmentRequestConfirm) => Promise<boolean>
  solve?: (input: SolveExplicitLockInput) => Promise<string>
  platform?: PhiPlatform
  environmentsDir?: string
  agentDir?: string
  signal?: AbortSignal
}

export function environmentRequestQuestion(input: {
  packages: readonly string[]
  reason: string
  environment: string
}): string {
  return `向环境 ${input.environment} 添加 ${input.packages.join('、')}。原因：${input.reason}`
}

export function confirmedEnvironmentRequest(response: unknown): boolean {
  if (!isRecord(response) || response.cancelled === true || typeof response.error === 'string') {
    return false
  }
  if (!Array.isArray(response.answers)) return false
  return response.answers.some((answer) => isRecord(answer) && answer.answer === ADD_PACKAGES)
}

/**
 * Host handler for `environments.request`. The user confirms in the conversation;
 * a solver failure writes nothing. The build does not ask again.
 */
export async function requestProjectEnvironment(
  params: unknown,
  deps: RequestProjectEnvironmentDeps = {}
): Promise<EnvRequestResult> {
  let request: ValidRequest
  try {
    request = validateRequest(params)
  } catch (error) {
    return { error: shortError(error) }
  }

  const projectDir = request.cwd
  const applied = applyOverrides(request.environment, projectDir)
  let baseSpec: EnvironmentSpec
  try {
    baseSpec = describeEnvironment(applied.ref, {
      projectDir,
      ...(request.pluginId ? { pluginId: request.pluginId } : {}),
      ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
      ...(deps.environmentsDir ? { environmentsDir: deps.environmentsDir } : {}),
      ...(deps.platform ? { platform: deps.platform } : {})
    }).spec
  } catch (error) {
    return { error: shortError(error) }
  }

  if (!deps.confirm) return { declined: true }
  const question = environmentRequestQuestion({
    packages: request.packages,
    reason: request.reason,
    environment: applied.ref
  })
  const accepted = await deps.confirm({
    runtimeSessionId: request.runtimeSessionId,
    packages: request.packages,
    reason: request.reason,
    environment: applied.ref,
    question
  })
  if (!accepted) return { declined: true }

  const platform = deps.platform ?? currentPlatform()
  let name: string
  let spec: EnvironmentSpec
  try {
    name = nextProjectEnvironmentName(projectDir, baseNameOf(applied.ref, baseSpec.name))
    spec = extendSpec(baseSpec, name, request.packages)
  } catch (error) {
    return { error: shortError(error) }
  }

  const root = deps.root ?? getRuntimeRoot()
  const solve = deps.solve ?? solveExplicitLock
  let lockText: string
  try {
    lockText = await solve({
      root,
      spec,
      platform,
      ...(deps.signal ? { signal: deps.signal } : {})
    })
  } catch (error) {
    return { error: shortError(error) }
  }

  if (!deps.builds) return { error: 'environment builds are unavailable' }
  const newRef = `project:${name}`
  try {
    writeProjectEnvironment(projectDir, { name, spec, lockText, platform })
    retargetOverrides(projectDir, request.environment, applied.ref, newRef)
    const descriptor = describeEnvironment(newRef, { projectDir, platform })
    const handle = await deps.builds.start(descriptor, { ref: newRef })
    return { ref: newRef, envId: handle.envId, name, added: [...request.packages] }
  } catch (error) {
    return { error: shortError(error) }
  }
}

interface ValidRequest {
  runtimeSessionId: string
  cwd: string
  packages: string[]
  reason: string
  environment: string
  pluginId?: string
}

function validateRequest(params: unknown): ValidRequest {
  const record = requireRecord(params)
  const runtimeSessionId = requireText(record, 'runtimeSessionId')
  const cwd = requireText(record, 'cwd')
  const packages = validatePackages(record.packages)
  const reason = validateReason(record.reason)
  const environment = record.environment
  if (typeof environment !== 'string' || environment.length === 0) {
    throw new Error('environment is required')
  }
  const parsed = parseEnvironmentRef(environment)
  if (parsed.kind === 'path') {
    throw new Error('environment must be phi:<name>@<major>, plugin:<name>, or project:<name>')
  }
  const pluginId =
    typeof record.pluginId === 'string' && record.pluginId ? record.pluginId : undefined
  return {
    runtimeSessionId,
    cwd,
    packages,
    reason,
    environment,
    ...(pluginId ? { pluginId } : {})
  }
}

function validatePackages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('packages must contain 1 to 20 conda match specs')
  }
  const packages: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('packages must contain 1 to 20 conda match specs')
    }
    assertMatchSpec(item)
    packages.push(item)
  }
  return packages
}

function assertMatchSpec(spec: string): void {
  if (spec.includes('::')) throw new Error(`channel prefixes are not allowed: '${spec}'`)
  const name = spec.split(/[\s=<>!~]/, 1)[0] ?? spec
  if (name.toLowerCase() === 'pip') throw new Error('pip packages are not allowed')
  if (!MATCH_SPEC.test(spec)) throw new Error(`invalid conda match spec '${spec}'`)
}

function validateReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('reason must be 1 to 500 characters')
  const reason = value.trim()
  if (reason.length < 1 || reason.length > 500) {
    throw new Error('reason must be 1 to 500 characters')
  }
  return reason
}

function baseNameOf(ref: string, specName: string): string {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind === 'phi' || parsed.kind === 'plugin') return parsed.name
  if (parsed.kind === 'project') {
    const stripped = parsed.name.replace(/-x[1-9][0-9]*$/, '')
    if (stripped !== parsed.name) return stripped
    return parsed.name
  }
  return specName
}

function extendSpec(
  base: EnvironmentSpec,
  name: string,
  packages: readonly string[]
): EnvironmentSpec {
  const spec: EnvironmentSpec = {
    name,
    channels: [...base.channels],
    dependencies: [
      ...base.dependencies.map((dependency) =>
        typeof dependency === 'string' ? dependency : { pip: [...dependency.pip] }
      ),
      ...packages
    ]
  }
  if (base.description !== undefined) spec.description = base.description
  if (base.host) spec.host = base.host.map(cloneHost)
  if (base.sourcePackages) spec.sourcePackages = base.sourcePackages.map(cloneSourcePackage)
  return spec
}

function cloneHost(item: HostRequirement): HostRequirement {
  return {
    name: item.name,
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.platforms ? { platforms: [...item.platforms] } : {}),
    ...(item.candidates ? { candidates: [...item.candidates] } : {})
  }
}

function cloneSourcePackage(item: SourcePackage): SourcePackage {
  return {
    language: item.language,
    name: item.name,
    source: item.source,
    ref: item.ref,
    sha256: item.sha256,
    ...(item.repo !== undefined ? { repo: item.repo } : {})
  }
}

function retargetOverrides(
  projectDir: string,
  requested: string,
  previous: string,
  next: string
): void {
  const current = readOverrides(projectDir)
  const overrides = { ...current.overrides }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === previous) overrides[key] = next
  }
  overrides[requested] = next
  writeOverrides(projectDir, overrides)
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const compact = message.replace(/\s+/g, ' ').trim()
  if (compact.length <= 240) return compact
  return `${compact.slice(0, 239)}…`
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object')
  return value
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
