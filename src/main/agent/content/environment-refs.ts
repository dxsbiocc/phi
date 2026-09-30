import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { bundledPluginsDir, listBundledPlugins } from '../plugins/bundled'
import { getBundledResourceDir } from '../runtime/runtime-adapter'
import {
  computeEnvId,
  currentPlatform,
  ensureEnvironment,
  loadEnvironment,
  parseEnvironmentRef,
  parseEnvironmentSpec,
  parseExplicitLock,
  type EnsureProgressEvent,
  type EnvHandle,
  type EnvKind,
  type EnvScope,
  type EnvironmentSpec,
  type PhiPlatform
} from '../envs'
import type { ValidatedSkill } from './skill'

const LOCAL_ENVIRONMENT = './environment.yml'
const FALLBACK_ENVIRONMENT = 'phi:python@1'

export interface EnvironmentDescriptor {
  ref: string
  scope: EnvScope
  owner?: string
  kind: EnvKind
  spec: EnvironmentSpec
  lockText: string
  platform: PhiPlatform
}

export function bundledEnvironmentsDir(): string {
  return join(getBundledResourceDir('runtime'), 'environments')
}

/**
 * § 3.3. The skill's own environment, else the calling session's, else `phi:python@1`
 * with a warning. Callers still have to build that environment; nothing here runs on the host.
 */
export function resolveSkillEnvironment(
  skill: ValidatedSkill,
  sessionEnvironment?: string
): { ref: string; warnings: string[] } {
  const declared = skill.phi?.environment
  if (typeof declared === 'string' && declared.length > 0) {
    return { ref: declared, warnings: [] }
  }
  if (typeof sessionEnvironment === 'string' && sessionEnvironment.length > 0) {
    return { ref: sessionEnvironment, warnings: [] }
  }
  return {
    ref: FALLBACK_ENVIRONMENT,
    warnings: [`skill ${skill.name} declares no environment`]
  }
}

export function describeEnvironment(
  ref: string,
  ctx: {
    skill?: ValidatedSkill
    environmentsDir?: string
    /** Bundled plugins root. Defaults to `resources/plugins`, same idea as `environmentsDir`. */
    pluginsDir?: string
    platform?: PhiPlatform
  } = {}
): EnvironmentDescriptor {
  const parsed = parseEnvironmentRef(ref)
  const platform = ctx.platform ?? currentPlatform()
  switch (parsed.kind) {
    case 'phi':
      if (parsed.major !== 1) {
        throw new Error(`environment phi:${parsed.name}@${parsed.major} is not available`)
      }
      return loadDescriptor(
        ref,
        'phi',
        'base',
        undefined,
        join(ctx.environmentsDir ?? bundledEnvironmentsDir(), `phi-${parsed.name}`),
        platform
      )
    case 'path':
      if (parsed.path !== LOCAL_ENVIRONMENT) {
        throw new Error('skill-local environment must be ./environment.yml')
      }
      if (!ctx.skill) throw new Error('./environment.yml requires a skill')
      return loadDescriptor(ref, 'skill', 'package', ctx.skill.name, ctx.skill.dir, platform)
    case 'plugin':
      return describePluginEnvironment(
        ref,
        parsed.name,
        ctx.pluginsDir ?? bundledPluginsDir(),
        platform
      )
    case 'project':
      throw new Error('project environments are not supported yet (implementation plan step 4.9)')
  }
}

/** The call fails closed. A missing or unfinished environment is never replaced by the host. */
export class EnvironmentNotReadyError extends Error {
  readonly ref: string
  readonly envId: string
  readonly descriptor: EnvironmentDescriptor

  constructor(ref: string, envId: string, descriptor: EnvironmentDescriptor) {
    super(`environment ${ref} is not ready`)
    this.name = 'EnvironmentNotReadyError'
    this.ref = ref
    this.envId = envId
    this.descriptor = descriptor
  }
}

export function readyEnvironment(root: string, descriptor: EnvironmentDescriptor): EnvHandle {
  const envId = computeEnvId({
    scope: descriptor.scope,
    owner: descriptor.owner,
    name: descriptor.spec.name,
    platform: descriptor.platform,
    lockText: descriptor.lockText,
    sourcePackages: descriptor.spec.sourcePackages
  })
  try {
    return loadEnvironment(root, envId)
  } catch (error) {
    if (error instanceof Error && absentOrNotReady(error.message)) {
      throw new EnvironmentNotReadyError(descriptor.ref, envId, descriptor)
    }
    throw error
  }
}

export function buildEnvironment(
  root: string,
  descriptor: EnvironmentDescriptor,
  options: {
    signal?: AbortSignal
    onProgress?: (event: EnsureProgressEvent) => void
  } = {}
): Promise<EnvHandle> {
  return ensureEnvironment({
    root,
    scope: descriptor.scope,
    owner: descriptor.owner,
    kind: descriptor.kind,
    spec: descriptor.spec,
    lockText: descriptor.lockText,
    platform: descriptor.platform,
    signal: options.signal,
    onProgress: options.onProgress
  }).then((result) => ({
    envId: result.envId,
    prefix: result.prefix,
    metadata: result.metadata
  }))
}

function absentOrNotReady(message: string): boolean {
  return message.includes('metadata is missing') || message.includes(' is not ready (status:')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function describePluginEnvironment(
  ref: string,
  name: string,
  pluginsDir: string,
  platform: PhiPlatform
): EnvironmentDescriptor {
  const matches = listBundledPlugins(pluginsDir).flatMap((plugin) => {
    if (!plugin.environmentsDir) return []
    const dir = join(plugin.environmentsDir, name)
    return isDirectory(dir) ? [{ id: plugin.id, dir }] : []
  })
  if (matches.length === 0) {
    throw new Error(`environment plugin:${name} is not available`)
  }
  if (matches.length > 1) {
    throw new Error(
      `environment plugin:${name} is provided by ${matches.map((match) => match.id).join(' and ')}`
    )
  }
  const match = matches[0]
  if (!match) throw new Error(`environment plugin:${name} is not available`)
  return loadDescriptor(ref, 'plugin', 'package', match.id, match.dir, platform)
}

function loadDescriptor(
  ref: string,
  scope: EnvScope,
  kind: EnvKind,
  owner: string | undefined,
  dir: string,
  platform: PhiPlatform
): EnvironmentDescriptor {
  const specPath = join(dir, 'environment.yml')
  const lockPath = join(dir, 'locks', `${platform}.txt`)
  const parsed = parseEnvironmentSpec(readText(specPath, 'environment spec'))
  if (!parsed.ok) {
    throw new Error(`environment spec ${specPath} is invalid: ${parsed.errors.join('; ')}`)
  }
  const lockText = readText(lockPath, 'environment lock')
  const lock = parseExplicitLock(lockText)
  if (!lock.ok) {
    throw new Error(`environment lock ${lockPath} is invalid: ${lock.errors.join('; ')}`)
  }
  const descriptor: EnvironmentDescriptor = {
    ref,
    scope,
    kind,
    spec: parsed.spec,
    lockText,
    platform
  }
  if (owner !== undefined) descriptor.owner = owner
  return descriptor
}

function readText(file: string, label: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new Error(`${label} is missing: ${file}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read ${label} ${file}: ${message}`)
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}
